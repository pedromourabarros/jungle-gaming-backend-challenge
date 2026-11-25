import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Message } from '@aws-sdk/client-sqs';
import { AppError } from '../../src/application/errors';
import { WagerTransactionStatus } from '../../src/domain';
import type { TransactionResult } from '../../src/application/contracts';
import { SqsConsumer, parseEnvelope } from '../../src/messaging/sqs-consumer';
import { SqsGateway } from '../../src/messaging/sqs-gateway';
import { workerBackoff } from '../../src/messaging/async';

const originalEnvironment = process.env.NODE_ENV;
beforeAll(() => { process.env.NODE_ENV = 'test'; });
afterAll(() => {
  if (originalEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnvironment;
});

const walletId = '02126cd0-8497-4c51-8210-3199b7a4c3c4';
const playerId = 'a33d5aa4-7c85-43b2-9a78-c6806cef65cb';
const transactionId = 'c92f6be6-e326-4e59-aea3-ef8cc93c2d20';
function envelope() {
  return {
    messageId: 'provider-message-1', type: 'WagerTransactionRequested', occurredAt: '2026-11-25T12:00:00.000Z',
    data: {
      providerId: 'provider-a', externalTransactionId: 'bet-1', idempotencyKey: 'different-valid-header-key',
      playerId, walletId, roundId: 'round-1', gameId: 'game-1', kind: 'BET', money: { amount: '10.00', currency: 'BRL' },
    },
  };
}
function message(count = 1): Message {
  return { MessageId: 'broker-1', ReceiptHandle: 'receipt-1', Body: JSON.stringify(envelope()), Attributes: { ApproximateReceiveCount: String(count) } };
}
class FakeGateway extends SqsGateway {
  readonly operations: string[] = [];
  readonly visibility: number[] = [];
  failDlq = false;
  constructor() { super({ visibilityTimeoutSeconds: 6, pollWaitSeconds: 0, requestTimeoutMs: 1000 }); }
  override async acknowledge(): Promise<void> { this.operations.push('ack'); }
  override async sendToDlq(_message: Message, failureCode: string): Promise<void> {
    this.operations.push(`dlq:${failureCode}`);
    if (this.failDlq) throw new Error('Transport unavailable');
  }
  override async changeVisibility(_receipt: string, seconds: number): Promise<void> {
    this.operations.push('visibility'); this.visibility.push(seconds);
  }
}
class FakeService {
  readonly operations: string[] = [];
  error?: Error;
  auditError?: Error;
  wait?: Promise<void>;
  result: TransactionResult = {
    transactionId, status: WagerTransactionStatus.Processed,
    balance: { amount: '90.00', currency: 'BRL' }, idempotentReplay: false,
  };
  async submit(): Promise<TransactionResult> {
    this.operations.push('submit');
    await this.wait;
    if (this.error) throw this.error;
    return this.result;
  }
  async recordFailed(): Promise<void> {
    this.operations.push('recordFailed');
    if (this.auditError) throw this.auditError;
  }
}

function latch(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
class DelayedHeartbeatGateway extends FakeGateway {
  readonly heartbeatStarted = latch();
  readonly heartbeatRelease = latch();
  override async changeVisibility(receipt: string, seconds: number): Promise<void> {
    if (seconds === 6) {
      this.heartbeatStarted.release();
      await this.heartbeatRelease.promise;
    }
    await super.changeVisibility(receipt, seconds);
  }
}

describe('SQS transport failure contracts', () => {
  test('validates the envelope and preserves the supplied idempotency key', () => {
    const parsed = parseEnvelope(JSON.stringify(envelope()));
    expect(parsed.input.idempotencyKey).toBe('different-valid-header-key');
    expect(parsed.messageId).toBe('provider-message-1');
    expect(parsed.input.money.amount).toBe('10.00');
  });

  test('rejects malformed JSON, absent keys, invalid dates, OPENING and numeric money', () => {
    const noKey = envelope() as unknown as { data: Record<string, unknown> };
    delete noKey.data.idempotencyKey;
    const invalid = [
      '', '{', JSON.stringify(noKey),
      JSON.stringify({ ...envelope(), occurredAt: 'tomorrow' }),
      JSON.stringify({ ...envelope(), occurredAt: '2026-02-31T12:00:00.000Z' }),
      JSON.stringify({ ...envelope(), messageId: ' ' }),
      JSON.stringify({ ...envelope(), data: { ...envelope().data, kind: 'OPENING' } }),
      JSON.stringify({ ...envelope(), data: { ...envelope().data, money: { amount: 10, currency: 'BRL' } } }),
    ];
    for (const body of invalid) expect(() => parseEnvelope(body)).toThrow();
  });

  test('acknowledges only after the committed use case and the test hook', async () => {
    const gateway = new FakeGateway();
    const service = new FakeService();
    try {
      const consumer = new SqsConsumer(gateway, service, { afterCommitBeforeAck: async () => {
        expect(service.operations).toEqual(['submit']);
        expect(gateway.operations).toEqual([]);
        gateway.operations.push('committed-hook');
      } });
      await consumer.handleMessage(message());
      expect(gateway.operations).toEqual(['committed-hook', 'ack']);
    } finally { gateway.close(); }
  });

  test('acknowledges a persisted business rejection without sending it to DLQ', async () => {
    const gateway = new FakeGateway();
    const service = new FakeService();
    service.result = { ...service.result, status: WagerTransactionStatus.Rejected, failureCode: 'INSUFFICIENT_FUNDS' };
    try {
      await new SqsConsumer(gateway, service).handleMessage(message());
      expect(gateway.operations).toEqual(['ack']);
      expect(service.operations).toEqual(['submit']);
    } finally { gateway.close(); }
  });

  test('never ACKs malformed input if its DLQ transfer fails', async () => {
    const gateway = new FakeGateway(); gateway.failDlq = true;
    const service = new FakeService();
    try {
      await new SqsConsumer(gateway, service).handleMessage({ ...message(), Body: '{' });
      expect(gateway.operations).toEqual(['dlq:INVALID_MESSAGE_ENVELOPE', 'visibility']);
      expect(gateway.visibility).toEqual([1]);
      expect(service.operations).toEqual([]);
    } finally { gateway.close(); }
  });

  test('transfers malformed input before acknowledging it', async () => {
    const gateway = new FakeGateway();
    try {
      await new SqsConsumer(gateway, new FakeService()).handleMessage({ ...message(), Body: '{' });
      expect(gateway.operations).toEqual(['dlq:INVALID_MESSAGE_ENVELOPE', 'ack']);
    } finally { gateway.close(); }
  });

  test('transient failure retries without acknowledgement or terminal audit', async () => {
    const gateway = new FakeGateway(); const service = new FakeService();
    service.error = new AppError(503, 'DATABASE_UNAVAILABLE', 'Temporary infrastructure failure', true);
    try {
      await new SqsConsumer(gateway, service).handleMessage(message(2));
      expect(gateway.operations).toEqual(['visibility']);
      expect(gateway.visibility).toEqual([2]);
      expect(service.operations).toEqual(['submit']);
    } finally { gateway.close(); }
  });

  test('exhausted identifiable failures persist an audit before DLQ and ACK', async () => {
    const gateway = new FakeGateway(); const service = new FakeService();
    service.error = new AppError(503, 'DATABASE_UNAVAILABLE', 'Temporary infrastructure failure', true);
    try {
      await new SqsConsumer(gateway, service).handleMessage(message(5));
      expect(service.operations).toEqual(['submit', 'recordFailed']);
      expect(gateway.operations).toEqual(['dlq:PROCESSING_RETRY_EXHAUSTED', 'ack']);
    } finally { gateway.close(); }
  });

  test('does not ACK when the terminal audit cannot commit', async () => {
    const gateway = new FakeGateway(); const service = new FakeService();
    service.error = new Error('Connection unavailable'); service.auditError = service.error;
    try {
      await new SqsConsumer(gateway, service).handleMessage(message(5));
      expect(service.operations).toEqual(['submit', 'recordFailed']);
      expect(gateway.operations).toEqual(['visibility']);
      expect(gateway.visibility).toEqual([16]);
    } finally { gateway.close(); }
  });

  test('a conflicting command is quarantined without creating another transaction', async () => {
    const gateway = new FakeGateway(); const service = new FakeService();
    service.error = new AppError(409, 'INBOX_CONFLICT', 'Message identifier conflicts with its persisted payload');
    try {
      await new SqsConsumer(gateway, service).handleMessage(message());
      expect(service.operations).toEqual(['submit']);
      expect(gateway.operations).toEqual(['dlq:INBOX_CONFLICT', 'ack']);
    } finally { gateway.close(); }
  });

  test('extends visibility while a financial transaction is still running', async () => {
    const gateway = new FakeGateway(); const service = new FakeService();
    let release!: () => void;
    service.wait = new Promise<void>(resolve => { release = resolve; });
    try {
      const work = new SqsConsumer(gateway, service).handleMessage(message());
      const deadline = Date.now() + 3500;
      while (gateway.visibility.length === 0 && Date.now() < deadline) await Bun.sleep(25);
      expect(gateway.visibility).toContain(6);
      expect(gateway.operations).not.toContain('ack');
      release();
      await work;
      expect(gateway.operations.at(-1)).toBe('ack');
    } finally { release(); gateway.close(); }
  }, 5000);

  test('backoff increases exponentially and is bounded', () => {
    expect(workerBackoff(1)).toBe(1000);
    expect(workerBackoff(4)).toBe(8000);
    expect(workerBackoff(100000)).toBe(300000);
  });

  test('finishes an in-flight heartbeat before applying retry visibility', async () => {
    const gateway = new DelayedHeartbeatGateway(); const service = new FakeService();
    const processing = latch(); service.wait = processing.promise;
    service.error = new AppError(503, 'DATABASE_UNAVAILABLE', 'Temporary infrastructure failure', true);
    try {
      const work = new SqsConsumer(gateway, service).handleMessage(message());
      await gateway.heartbeatStarted.promise;
      processing.release();
      await Bun.sleep(20);
      expect(gateway.visibility).toEqual([]);
      gateway.heartbeatRelease.release();
      await work;
      expect(gateway.visibility).toEqual([6, 1]);
      expect(gateway.operations).not.toContain('ack');
    } finally { processing.release(); gateway.heartbeatRelease.release(); gateway.close(); }
  }, 5000);

  test('shutdown releases visibility after the heartbeat and prevents late processing from overriding it', async () => {
    const gateway = new DelayedHeartbeatGateway(); const service = new FakeService();
    const processing = latch(); service.wait = processing.promise;
    service.error = new AppError(503, 'DATABASE_UNAVAILABLE', 'Temporary infrastructure failure', true);
    try {
      const consumer = new SqsConsumer(gateway, service);
      const work = consumer.handleMessage(message());
      await gateway.heartbeatStarted.promise;
      const release = consumer.releaseInFlight();
      await Bun.sleep(20);
      expect(gateway.visibility).toEqual([]);
      gateway.heartbeatRelease.release();
      await release;
      expect(gateway.visibility).toEqual([6, 0]);
      processing.release();
      await work;
      expect(gateway.visibility).toEqual([6, 0]);
      expect(gateway.operations).not.toContain('ack');
    } finally { processing.release(); gateway.heartbeatRelease.release(); gateway.close(); }
  }, 5000);
});
