import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AccessTokenPayload } from '@leadprocure/shared';
import { AppConfig } from '../config/config.service';

export interface RefreshPayload {
  sub: string;
  org_id: string;
  token_version: number;
  jti?: string;
}

@Injectable()
export class TokenService {
  private readonly access: JwtService;
  private readonly refresh: JwtService;

  constructor(private readonly cfg: AppConfig) {
    this.access = new JwtService({
      secret: cfg.jwtAccessSecret,
      signOptions: { expiresIn: cfg.jwtAccessTtl },
    });
    this.refresh = new JwtService({
      secret: cfg.jwtRefreshSecret,
      signOptions: { expiresIn: cfg.jwtRefreshTtl },
    });
  }

  signAccess(payload: AccessTokenPayload): string {
    return this.access.sign(payload);
  }
  verifyAccess(token: string): AccessTokenPayload {
    return this.access.verify<AccessTokenPayload>(token);
  }
  signRefresh(payload: RefreshPayload): string {
    // jti makes every refresh token unique. Without it, JWT's 1-second iat resolution
    // means a rotation within the same second as issuance can produce the IDENTICAL
    // token string — "rotation" silently becomes a no-op (same session hash).
    return this.refresh.sign({ ...payload, jti: randomUUID() });
  }
  verifyRefresh(token: string): RefreshPayload {
    return this.refresh.verify<RefreshPayload>(token);
  }
}
