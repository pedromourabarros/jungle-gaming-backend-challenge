import type { FinancialService } from '../application/financial-service';

/** Scheduling only: locking, the due-time recheck and retry limits live in the shared use case. */
export class PendingReferenceWorker {
  constructor(private readonly service: Pick<FinancialService, 'retryPendingBatch'>) {}

  tick(limit = 25): Promise<number> {
    return this.service.retryPendingBatch(limit);
  }
}
