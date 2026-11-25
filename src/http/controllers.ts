import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { FinancialService } from '../application/financial-service';
import { QueryService } from '../application/query-service';
import { parseSubmission, parseUuid, parseWallet } from '../application/contracts';
import { Database } from '../infrastructure/database';
import { SqsGateway } from '../messaging';
import { metrics } from '../observability/metrics';
import { AppError } from '../application/errors';

export function correlation(request: Request): string { return (request as Request & { correlationId?: string }).correlationId ?? randomUUID(); }

@Controller('wallets')
export class WalletsController {
  constructor(@Inject(FinancialService) private readonly financial: FinancialService, @Inject(QueryService) private readonly queries: QueryService) {}
  @Post()
  async create(@Body() body: unknown, @Req() req: Request) {
    const input = parseWallet(body);
    return this.financial.createWallet(input.playerId,input.initialBalance,correlation(req));
  }
  @Get(':walletId')
  get(@Param('walletId') id: string) { return this.queries.wallet(parseUuid(id)); }
  @Get(':walletId/ledger')
  ledger(@Param('walletId') id: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    if ((cursor !== undefined && typeof cursor !== 'string') || (limit !== undefined && typeof limit !== 'string')) throw new AppError(400,'INVALID_QUERY','Query parameters must be single values');
    return this.queries.ledger(parseUuid(id),cursor,limit);
  }
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId') id: string, @Req() req: Request) { return this.queries.reconciliation(parseUuid(id),correlation(req)); }
}

@Controller()
export class TransactionsController {
  constructor(@Inject(FinancialService) private readonly financial: FinancialService, @Inject(QueryService) private readonly queries: QueryService) {}
  @Post('wagering/transactions')
  async submit(@Body() body: unknown, @Headers('idempotency-key') key: string | undefined,
    @Req() req: Request, @Res({ passthrough: true }) response: Response) {
    // The HTTP header is the sole authority; body copies are rejected as ambiguous contracts.
    if (body && typeof body === 'object' && 'idempotencyKey' in body) throw new AppError(400,'INVALID_PAYLOAD','Send Idempotency-Key in the HTTP header');
    const input = parseSubmission(body,key ?? '');
    const result = await this.financial.submit(input,{correlationId:correlation(req)});
    response.status(result.status === 'PENDING_REFERENCE' || result.status === 'PENDING' ? 202
      : result.status === 'REJECTED' ? 422 : result.status === 'FAILED' ? 500 : 200);
    return result;
  }
  @Get('wagering/transactions/:transactionId')
  get(@Param('transactionId') id: string) { return this.queries.transaction(parseUuid(id)); }
  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  getExternal(@Param('providerId') provider: string, @Param('externalTransactionId') external: string) {
    return this.queries.providerTransaction(provider,external);
  }
}

@Controller()
export class OperationsController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(SqsGateway) private readonly sqs: SqsGateway) {}
  @Get('health/live')
  live() { return { status: 'ok' }; }
  @Get('health/ready')
  async ready(@Res({ passthrough: true }) response: Response) {
    const checks = await Promise.allSettled([this.db.query('select 1'),this.sqs.readiness()]);
    const postgres = checks[0]!.status === 'fulfilled';
    const sqsResult = checks[1]!;
    const sqs = sqsResult.status === 'fulfilled' && sqsResult.value === true;
    response.status(postgres && sqs ? 200 : 503);
    return { status: postgres && sqs ? 'ready' : 'unavailable', checks: { postgres, sqs } };
  }
  @Get('metrics')
  metricOutput(@Res() response: Response) { response.type('text/plain; version=0.0.4').send(metrics.render()); }
}
