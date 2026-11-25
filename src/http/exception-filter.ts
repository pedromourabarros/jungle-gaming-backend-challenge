import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppError, databaseCode, isTransient } from '../application/errors';
import { DomainError } from '../domain';
import { log } from '../observability/logger';
import { correlation } from './controllers';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<Request>();
    const response = host.switchToHttp().getResponse<Response>();
    let mapped: AppError;
    if (error instanceof AppError) mapped = error;
    else if (error instanceof DomainError) mapped = new AppError(
      ['INVALID_TRANSACTION_STATE','INVALID_INBOX_STATE','INVALID_OUTBOX_STATE'].includes(error.code) ? 500 : 400,
      error.code,'Invalid domain operation');
    else if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.parse.failed')
      mapped = new AppError(400,'INVALID_REQUEST','Request body must be valid JSON');
    else if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large')
      mapped = new AppError(413,'PAYLOAD_TOO_LARGE','Request body exceeds the supported limit');
    else if (error instanceof HttpException) mapped = new AppError(error.getStatus(),error.getStatus() === 404 ? 'ROUTE_NOT_FOUND' : 'INVALID_REQUEST','Invalid HTTP request');
    else if (isTransient(error)) mapped = new AppError(503,'INFRASTRUCTURE_UNAVAILABLE','Temporary infrastructure failure; retry with the same key',true);
    else mapped = new AppError(500,'INTERNAL_ERROR','Unexpected internal failure');
    const correlationId = correlation(request);
    log(mapped.httpStatus >= 500 ? 'error' : 'warn','http.request_failed',{correlationId,code:mapped.code,sqlState:databaseCode(error)});
    if (mapped.retryable) response.setHeader('Retry-After','1');
    response.status(mapped.httpStatus).json({ code: mapped.code, message: mapped.message, retryable: mapped.retryable, correlationId });
  }
}
