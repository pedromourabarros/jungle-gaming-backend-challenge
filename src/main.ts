import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Request, Response, NextFunction } from 'express';
import { Database } from './infrastructure/database';
import { config } from './infrastructure/config';
import { FinancialService } from './application/financial-service';
import { QueryService } from './application/query-service';
import { MessagingRuntime, SqsGateway } from './messaging';
import { OperationsController, TransactionsController, WalletsController } from './http/controllers';
import { ApiExceptionFilter } from './http/exception-filter';
import { ProviderIdentityGuard, UnauthenticatedChallengeIdentity } from './http/auth';
import { log } from './observability/logger';

export async function createApplication(db: Database, financial = new FinancialService(db), gateway = new SqsGateway()) {
  @Module({
    controllers: [WalletsController,TransactionsController,OperationsController],
    providers: [
      { provide: Database, useValue: db }, { provide: FinancialService, useValue: financial },
      { provide: QueryService, useValue: new QueryService(db) }, { provide: SqsGateway, useValue: gateway },
    ],
  })
  class ApplicationModule {}
  const app = await NestFactory.create(ApplicationModule, { logger: false, abortOnError: false });
  app.use((request: Request & { correlationId?: string }, response: Response, next: NextFunction) => {
    const supplied = request.headers['x-correlation-id'];
    request.correlationId = typeof supplied === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : randomUUID();
    response.setHeader('X-Correlation-Id',request.correlationId);
    next();
  });
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalGuards(new ProviderIdentityGuard(new UnauthenticatedChallengeIdentity()));
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  return app;
}

async function bootstrap(): Promise<void> {
  const db = await Database.connect();
  const service = new FinancialService(db);
  const runtime = new MessagingRuntime(db,service);
  const app = await createApplication(db,service,runtime.gateway);
  await app.listen(config.port,'0.0.0.0');
  runtime.start();
  log('info','application.started',{port:config.port});
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log('info','application.stopping',{signal});
    // Stop accepting work, then drain messages before closing the shared database pool.
    await Promise.all([app.close(),runtime.stop()]);
    await db.close();
    log('info','application.stopped',{signal});
  };
  process.once('SIGTERM',() => void stop('SIGTERM').catch(() => process.exit(1)));
  process.once('SIGINT',() => void stop('SIGINT').catch(() => process.exit(1)));
}

if (import.meta.main) bootstrap().catch(() => { log('error','application.start_failed',{code:'STARTUP_FAILURE'}); process.exit(1); });
