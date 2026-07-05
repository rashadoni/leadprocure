import { Global, Module } from '@nestjs/common';
import { EntitlementService, QuotaService } from './entitlement.service';
import { LicenseController } from './license.controller';

@Global()
@Module({
  controllers: [LicenseController],
  providers: [EntitlementService, QuotaService],
  exports: [EntitlementService, QuotaService],
})
export class LicenseModule {}
