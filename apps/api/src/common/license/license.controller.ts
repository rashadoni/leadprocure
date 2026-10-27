import { Body, Controller, ForbiddenException, Get, Post } from '@nestjs/common';
import { IsString, MinLength } from 'class-validator';
import { Roles } from '../auth/decorators';
import { AppConfig } from '../config/config.service';
import { EntitlementService } from './entitlement.service';

class InstallLicenseDto {
  @IsString() @MinLength(1) token!: string;
}

@Controller()
export class LicenseController {
  constructor(private readonly entitlements: EntitlementService, private readonly cfg: AppConfig) {}

  @Get('me/entitlements')
  entitlements2() {
    return this.entitlements.snapshot();
  }

  // On-prem license renewal: admin uploads a new signed license token.
  @Roles('BUYER_ADMIN')
  @Post('admin/license')
  async install(@Body() body: InstallLicenseDto) {
    if (this.cfg.deploymentMode !== 'on_prem_isolated') throw new ForbiddenException('Server licensing is managed by the deployment operator');
    await this.entitlements.installFromToken(body.token);
    return this.entitlements.snapshot();
  }
}
