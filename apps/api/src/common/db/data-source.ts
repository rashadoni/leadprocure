import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadRootEnv } from '../config/env';

loadRootEnv();

// CLI / migration DataSource — connects as the OWNER role (creates tables, RLS policies).
// The running application uses a separate DataSource on the app_user role (see database.module.ts).
export default new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_OWNER_URL,
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/common/db/migrations/*.ts'],
  synchronize: false,
  logging: ['error', 'warn', 'migration'],
});
