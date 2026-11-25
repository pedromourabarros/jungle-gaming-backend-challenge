import { randomUUID } from 'node:crypto';
import { Database, sql } from '../infrastructure/database';
import { log } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { crashIfRequested, delay, testOnlyHook, workerBackoff } from './async';
import { SqsGateway } from './sqs-gateway';

export interface ClaimedOutbox {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  lease_owner: string;
}

export interface OutboxOptions {
  leaseMs?: number;
  batchSize?: number;
  afterPublishBeforeMark?: (event: ClaimedOutbox) => Promise<void>;
}

function eventContext(event: ClaimedOutbox): Record<string, unknown> {
  const data = event.payload.data;
  const metadata = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  return {
    eventId: event.id, walletId: event.aggregate_id, eventType: event.event_type,
    correlationId: event.payload.correlationId, messageId: event.payload.causationId,
    transactionId: metadata.transactionId, providerId: metadata.providerId,
  };
}

/**
 * Claims are short SQL transactions. Network I/O never holds a database lock.
 * A fresh UUID fences every claim; an expired owner cannot update publication state.
 */
export class OutboxPublisher {
  private readonly leaseMs: number;
  private readonly batchSize: number;
  private readonly afterPublishBeforeMark: OutboxOptions['afterPublishBeforeMark'];
  private readonly active = new Map<string, { owner: string; abort: AbortController }>();

  constructor(private readonly db: Database, private readonly gateway: SqsGateway, options: OutboxOptions = {}) {
    this.leaseMs = options.leaseMs ?? Number(process.env.OUTBOX_LEASE_MS ?? '60000');
    this.batchSize = options.batchSize ?? 10;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 300 || this.leaseMs > 3600000
      || !Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 100) {
      throw new Error('Invalid outbox configuration');
    }
    this.afterPublishBeforeMark = testOnlyHook(options.afterPublishBeforeMark);
  }

  async publishBatch(limit = this.batchSize): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid outbox batch limit');
    const owner = randomUUID();
    const batch = await this.db.transaction(em => sql<ClaimedOutbox>(em, `
      WITH candidates AS (
        SELECT id FROM outbox_messages
        WHERE published_at IS NULL AND next_attempt_at <= clock_timestamp()
          AND (lease_until IS NULL OR lease_until <= clock_timestamp())
        ORDER BY occurred_at, id
        FOR UPDATE SKIP LOCKED LIMIT ?
      )
      UPDATE outbox_messages AS o
      SET lease_owner = ?::uuid,
          lease_until = clock_timestamp() + (?::integer * interval '1 millisecond'),
          attempts = o.attempts + 1
      FROM candidates AS c WHERE o.id = c.id
      RETURNING o.id, o.aggregate_id, o.event_type, o.payload, o.attempts, o.lease_owner
    `, [limit, owner, this.leaseMs]));
    const results = await Promise.all(batch.map(event => this.publishOne(event)));
    await this.updateLag();
    return results.reduce((sum, published) => sum + (published ? 1 : 0), 0);
  }

  async releaseOwnedLeases(): Promise<void> {
    await Promise.allSettled([...this.active.entries()].map(async ([id, claim]) => {
      claim.abort.abort();
      await this.db.query(`UPDATE outbox_messages SET lease_owner = NULL, lease_until = NULL
        WHERE id = ?::uuid AND lease_owner = ?::uuid AND published_at IS NULL RETURNING id`, [id, claim.owner]);
    }));
  }

  private async publishOne(event: ClaimedOutbox): Promise<boolean> {
    const sendAbort = new AbortController();
    const heartbeatAbort = new AbortController();
    this.active.set(event.id, { owner: event.lease_owner, abort: sendAbort });
    let ownsLease = true;
    const heartbeat = this.renewLease(event, heartbeatAbort.signal, () => {
      ownsLease = false;
      sendAbort.abort();
    });
    try {
      await this.gateway.publish({ id: event.id, aggregateId: event.aggregate_id, payload: event.payload }, sendAbort.signal);
      await this.afterPublishBeforeMark?.(event);
      crashIfRequested('TEST_CRASH_AFTER_PUBLISH');
      if (!ownsLease) return false;
      const marked = await this.db.query<{ id: string }>(`
        UPDATE outbox_messages
        SET published_at = clock_timestamp(), lease_owner = NULL, lease_until = NULL
        WHERE id = ?::uuid AND lease_owner = ?::uuid
          AND lease_until > clock_timestamp() AND published_at IS NULL
        RETURNING id
      `, [event.id, event.lease_owner]);
      if (marked.length === 0) {
        metrics.inc('outbox_lease_conflicts_total');
        return false;
      }
      metrics.inc('outbox_published_total', { eventType: event.event_type });
      log('info', 'outbox.published', eventContext(event));
      return true;
    } catch {
      // A send may have reached SQS before its response was lost. Preserve the same eventId.
      // Redelivery is expected and downstream consumers must persistently deduplicate it.
      if (ownsLease) {
        try {
          await this.db.query(`UPDATE outbox_messages
            SET next_attempt_at = clock_timestamp() + (?::integer * interval '1 millisecond'),
                lease_owner = NULL, lease_until = NULL
            WHERE id = ?::uuid AND lease_owner = ?::uuid AND lease_until > clock_timestamp()
              AND published_at IS NULL RETURNING id`,
          [workerBackoff(event.attempts), event.id, event.lease_owner]);
        } catch {
          // If PostgreSQL is unavailable the finite lease is the recovery mechanism.
          log('warn', 'outbox.retry_persistence_failed', { ...eventContext(event), code: 'DATABASE_UNAVAILABLE' });
        }
      }
      metrics.inc('retries_total', { worker: 'outbox' });
      log('warn', 'outbox.publish_retry', {
        ...eventContext(event),
        attempts: event.attempts, code: 'EVENT_PUBLICATION_INCOMPLETE',
      });
      return false;
    } finally {
      heartbeatAbort.abort();
      await heartbeat;
      this.active.delete(event.id);
    }
  }

  private async renewLease(event: ClaimedOutbox, signal: AbortSignal, lost: () => void): Promise<void> {
    while (!signal.aborted) {
      await delay(Math.floor(this.leaseMs / 3), signal);
      if (signal.aborted) return;
      try {
        const rows = await this.db.query<{ id: string }>(`UPDATE outbox_messages
          SET lease_until = clock_timestamp() + (?::integer * interval '1 millisecond')
          WHERE id = ?::uuid AND lease_owner = ?::uuid
            AND lease_until > clock_timestamp() AND published_at IS NULL RETURNING id`,
        [this.leaseMs, event.id, event.lease_owner]);
        if (rows.length === 0) {
          lost();
          metrics.inc('outbox_lease_conflicts_total');
          return;
        }
      } catch {
        // Do not assume a lease is valid after an uncertain heartbeat.
        lost();
        metrics.inc('outbox_lease_conflicts_total');
        return;
      }
    }
  }

  private async updateLag(): Promise<void> {
    const rows = await this.db.query<{ pending: string; lag_seconds: string | number }>(`
      SELECT count(*)::text AS pending,
        COALESCE(GREATEST(0, EXTRACT(EPOCH FROM (clock_timestamp() - MIN(occurred_at)))), 0)::text AS lag_seconds
      FROM outbox_messages WHERE published_at IS NULL
    `);
    metrics.set('outbox_pending', Number(rows[0]?.pending ?? '0'));
    metrics.set('outbox_lag_seconds', Number(rows[0]?.lag_seconds ?? '0'));
  }
}
