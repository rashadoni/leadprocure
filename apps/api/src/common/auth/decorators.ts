import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { AccessTokenPayload, MembershipRole, FeatureKey } from '@leadprocure/shared';

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ROLES_KEY = 'roles';
export const Roles = (...roles: MembershipRole[]) => SetMetadata(ROLES_KEY, roles);

export const FEATURE_KEY = 'requiredFeature';
export const RequiresFeature = (feature: FeatureKey) => SetMetadata(FEATURE_KEY, feature);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AccessTokenPayload => {
    return ctx.switchToHttp().getRequest().auth;
  },
);

export const OrgId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  return ctx.switchToHttp().getRequest().auth?.org_id;
});
