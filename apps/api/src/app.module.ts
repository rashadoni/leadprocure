import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from './common/db/database.module';
import { TransactionInterceptor } from './common/db/transaction.interceptor';
import { AuthModule } from './common/auth/auth.module';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard';
import { RolesGuard } from './common/auth/roles.guard';
import { AuditModule } from './common/audit/audit.service';
import { LicenseModule } from './common/license/license.module';
import { FeatureGuard } from './common/license/feature.guard';
import { HealthController } from './health.controller';
import { SealedCryptoModule } from './common/crypto/sealed.service';
import { SignatureModule } from './common/signature/signature.provider';
import { NotifyModule } from './common/notify/notify.module';
import { RealtimeModule } from './common/realtime/realtime.gateway';
import { IdentityModule } from './modules/identity/identity.module';
import { SuppliersModule } from './modules/suppliers/suppliers.module';
import { RequestsModule } from './modules/requests/requests.module';
import { SourcingModule } from './modules/sourcing/sourcing.module';

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    DatabaseModule,
    AuthModule,
    AuditModule,
    LicenseModule,
    SealedCryptoModule,
    SignatureModule,
    NotifyModule,
    RealtimeModule,
    IdentityModule,
    SuppliersModule,
    RequestsModule,
    SourcingModule,
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: authenticate, then role check, then feature gate.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: FeatureGuard },
    // Runs after guards: opens the per-request RLS transaction.
    { provide: APP_INTERCEPTOR, useClass: TransactionInterceptor },
  ],
})
export class AppModule {}
