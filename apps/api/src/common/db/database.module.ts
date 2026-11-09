import './pg-date-type'; // a `date` is a day, not an instant — must load before any query
import { Global, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppConfig } from '../config/config.service';
import { RequestContextService } from '../context/request-context.service';
import { assertZoneKnownToPostgres } from '../config/timezone';

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
export class DatabaseModule implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly ds: DataSource, private readonly cfg: AppConfig) {}

  // `APP_TIMEZONE` решает, какой день считается днём документа, и считает его Postgres
  // (`AT TIME ZONE`, см. `common/config/timezone.ts`). Форму имени проверил уже `AppConfig`;
  // здесь проверяется, что это имя знает именно та база, которая будет считать. Иначе
  // выкладка поднялась бы, а упало бы первое выставление счёта — 500-й с текстом про
  // `AT TIME ZONE`, в котором про эту переменную ничего нет.
  async onModuleInit(): Promise<void> {
    await assertZoneKnownToPostgres((sql, params) => this.ds.query(sql, params), this.cfg.appTimezone);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.ds.isInitialized) await this.ds.destroy();
  }
}
