import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC } from './decorators';
import { TokenService } from './token.service';

// Stateless access-token verification. Runs before TransactionInterceptor, so it does
// no DB work; token_version is enforced only at refresh time.
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest();

    const header: string | undefined = req.headers?.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

    if (token) {
      try {
        req.auth = this.tokens.verifyAccess(token);
      } catch {
        if (!isPublic) throw new UnauthorizedException('Invalid or expired token');
      }
    } else if (!isPublic) {
      throw new UnauthorizedException('Missing bearer token');
    }
    return true;
  }
}
