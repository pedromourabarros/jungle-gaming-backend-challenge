import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** Extension point for an OIDC/JWKS adapter that binds the authenticated subject to providerId. */
export abstract class ProviderIdentityPort {
  abstract authorize(request: Request): Promise<void>;
}
export class UnauthenticatedChallengeIdentity extends ProviderIdentityPort {
  override async authorize(_request: Request): Promise<void> {
    // Explicit scope decision permitted by the challenge. No homemade passwords/API-key authentication.
  }
}
export class ProviderIdentityGuard implements CanActivate {
  constructor(private readonly identity: ProviderIdentityPort) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    if (request.path.startsWith('/health/')) return true;
    await this.identity.authorize(request);
    return true;
  }
}
