import { Global, Module, OnModuleDestroy } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppConfig } from '../config/config.service';
import { RequestContextService } from '../context/request-context.service';

// The running application connects as app_user (NOSUPERUSER, NOBYPASSRLS, not table owner),
// so PostgreSQL RLS is enforced. Data access is raw parameterized SQL through the
// request-scoped transactional EntityManager (see TransactionInterceptor + RequestContextService).
@Global()
@Module({
  providers: [
    {
      provide: DataSource,
      useFactory: async (cfg: AppConfig) => {
        const ds = new DataSource({
          type: 'postgres',
          url: cfg.databaseUrl,
          entities: [],
          synchronize: false,
          logging: cfg.nodeEnv === 'development' ? ['error', 'warn'] : ['error'],
        });
        await ds.initialize();
        return ds;
      },
      inject: [AppConfig],
    },
    AppConfig,
    RequestContextService,
  ],
  exports: [DataSource, AppConfig, RequestContextService],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor(private readonly ds: DataSource) {}
  async onModuleDestroy(): Promise<void> {
    if (this.ds.isInitialized) await this.ds.destroy();
  }
}
