import { Controller, Get } from '@nestjs/common';
import { Public } from './common/auth/decorators';
import { AppConfig } from './common/config/config.service';
import { EntitlementService } from './common/license/entitlement.service';

@Controller()
export class HealthController {
  constructor(
    private readonly cfg: AppConfig,
    private readonly entitlements: EntitlementService,
  ) {}

  @Public()
  @Get('health')
  health() {
    return {
      status: 'ok',
      deploymentMode: this.cfg.deploymentMode,
      edition: this.entitlements.snapshot().edition,
      licenseSource: this.entitlements.snapshot().source,
      licenseStatus: this.entitlements.snapshot().status,
    };
  }
}
