import { Body, Controller, Get, Post } from '@nestjs/common';
import { Roles } from '../auth/decorators';
import { EntitlementService } from './entitlement.service';

@Controller()
export class LicenseController {
  constructor(private readonly entitlements: EntitlementService) {}

  @Get('me/entitlements')
  entitlements2() {
    return this.entitlements.snapshot();
  }

  // On-prem license renewal: admin uploads a new signed license token.
  @Roles('BUYER_ADMIN')
  @Post('admin/license')
  async install(@Body() body: { token: string }) {
    await this.entitlements.installFromToken(body.token);
    return this.entitlements.snapshot();
  }
}
