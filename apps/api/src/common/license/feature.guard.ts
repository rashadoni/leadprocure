import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FeatureKey } from '@leadprocure/shared';
import { FEATURE_KEY } from '../auth/decorators';
import { EntitlementService } from './entitlement.service';

// Coarse feature gate: blocks endpoints whose @RequiresFeature() is not in the license.
// Command-level invariants (e.g. graceful-degradation on expiry) live in services.
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const feature = this.reflector.getAllAndOverride<FeatureKey>(FEATURE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest();
    const path = String(req.path ?? '').replace(/\/$/, '');
    if (req.method === 'POST' && (/^\/requests$/.test(path) ||
      /^\/(events|auctions)\/from-request\//.test(path) ||
      /^\/contracts\/(from-award|direct)\//.test(path) ||
      /^\/catalogs(?:$|\/from-contract\/|\/[^/]+\/order$)/.test(path) ||
      /^\/contracts\/[^/]+\/orders$/.test(path) || /^\/events\/[^/]+\/publish$/.test(path)))
      this.entitlements.assertCanCreateNew();
    if (!feature) return true;
    if (this.entitlements.status() === 'revoked') {
      throw new ForbiddenException('License revoked');
    }
    if (!this.entitlements.hasFeature(feature)) {
      throw new ForbiddenException(`Feature not licensed: ${feature}`);
    }
    return true;
  }
}
