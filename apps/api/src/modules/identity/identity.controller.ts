import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { CurrentUser, Public } from '../../common/auth/decorators';
import type { AccessTokenPayload } from '@leadprocure/shared';
import { AppConfig } from '../../common/config/config.service';
import { EntitlementService } from '../../common/license/entitlement.service';
import { IdentityService, AuthResult } from './identity.service';
import { LoginDto, RegisterOrgDto } from './dto';

@Controller('auth')
export class IdentityController {
  constructor(
    private readonly identity: IdentityService,
    private readonly cfg: AppConfig,
    private readonly entitlements: EntitlementService,
  ) {}

  @Public()
  @Post('register/buyer')
  async registerBuyer(@Body() dto: RegisterOrgDto, @Res({ passthrough: true }) res: Response) {
    return this.finish(await this.identity.register(dto, 'BUYER', 'BUYER_ADMIN'), res);
  }

  @Public()
  @Post('register/supplier')
  async registerSupplier(@Body() dto: RegisterOrgDto, @Res({ passthrough: true }) res: Response) {
    return this.finish(await this.identity.register(dto, 'SUPPLIER', 'SUPPLIER_USER'), res);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } }) // brute-force / argon2-DoS guard
  @Post('login')
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    return this.finish(await this.identity.login(dto), res);
  }

  @Public()
  @Post('refresh')
  async refresh(@Req() req: Request) {
    const token = req.cookies?.[this.cfg.refreshCookieName];
    return this.identity.refresh(token);
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(this.cfg.refreshCookieName);
    return { ok: true };
  }

  @Get('me')
  async me(@CurrentUser() auth: AccessTokenPayload) {
    const [me, entitlements] = await Promise.all([
      this.identity.me(auth),
      Promise.resolve(this.entitlements.snapshot()),
    ]);
    return { ...me, entitlements };
  }

  private finish(result: AuthResult, res: Response) {
    res.cookie(this.cfg.refreshCookieName, result.refreshToken, {
      httpOnly: true,
      secure: this.cfg.refreshCookieSecure,
      sameSite: 'lax',
      maxAge: this.cfg.jwtRefreshTtl * 1000,
      path: '/',
    });
    return { accessToken: result.accessToken, user: result.user, org: result.org };
  }
}
