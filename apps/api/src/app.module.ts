import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
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
import { DocumentsModule } from './common/storage/documents.module';
import { RealtimeModule } from './common/realtime/realtime.gateway';
import { IdentityModule } from './modules/identity/identity.module';
import { SuppliersModule } from './modules/suppliers/suppliers.module';
import { RequestsModule } from './modules/requests/requests.module';
import { SourcingModule } from './modules/sourcing/sourcing.module';
import { ContractsModule } from './modules/contracts/contracts.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { SettingsModule } from './modules/settings/settings.module';
import { AiScorerModule } from './common/ai/ai-scorer';
import { LogisticsModule } from './modules/logistics/logistics.module';
import { CatalogsModule } from './modules/catalogs/catalogs.module';
import { VerificationModule } from './modules/verification/verification.module';
import { InvoicesModule } from './modules/invoices/invoices.module';
import { BudgetsModule } from './modules/budgets/budgets.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { DepartmentsModule } from './modules/departments/departments.module';
import { FollowupsModule } from './modules/followups/followups.module';
import { ChannelsModule } from './modules/channels/channels.module';
import { MailModule } from './common/mail/mail.module';

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    // Cron jobs in an e2e app are a liability, not coverage. Every suite builds a full
    // AppModule, the minute and 30-second jobs fire during the run, and a tick still in
    // flight when a suite closes queries a closing DataSource and logs after teardown —
    // which makes jest exit non-zero while every single test passed. That is a gate going
    // red for a reason nobody can read, and the first instinct is to re-run it.
    // followups.e2e already stopped the jobs by hand for exactly this reason; the flag
    // does it for every suite, and schedulers are tested by calling the tick directly.
    ...(process.env.DISABLE_SCHEDULERS === '1' ? [] : [ScheduleModule.forRoot()]),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 300 }]),
    DatabaseModule,
    AuthModule,
    AuditModule,
    LicenseModule,
    SealedCryptoModule,
    SignatureModule,
    AiScorerModule,
    MailModule,
    NotifyModule,
    DocumentsModule,
    RealtimeModule,
    IdentityModule,
    SuppliersModule,
    RequestsModule,
    SourcingModule,
    ContractsModule,
    DashboardModule,
    SettingsModule,
    LogisticsModule,
    CatalogsModule,
    VerificationModule,
    InvoicesModule,
    BudgetsModule,
    CategoriesModule,
    DepartmentsModule,
    FollowupsModule,
    ChannelsModule,
  ],
  controllers: [HealthController],
  providers: [
    // Rate limiting first, then authenticate, role check, feature gate.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: FeatureGuard },
    // Runs after guards: opens the per-request RLS transaction.
    { provide: APP_INTERCEPTOR, useClass: TransactionInterceptor },
  ],
})
export class AppModule {}
