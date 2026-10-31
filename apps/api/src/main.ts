import 'reflect-metadata';
import { loadRootEnv } from './common/config/env';

loadRootEnv();

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AppConfig } from './common/config/config.service';

async function bootstrap(): Promise<void> {
  // The flag exists for the e2e suites and is never set in production — but if it ever
  // were, the loss would be entirely silent: sourcing events would stay OPEN past
  // close_at, so late bids would keep being accepted as on-time, follow-ups would never
  // send and the weekly budget digest would never run. Say it at boot.
  if (process.env.DISABLE_SCHEDULERS === '1') {
    // eslint-disable-next-line no-console
    console.warn(
      'DISABLE_SCHEDULERS=1 — no cron jobs are registered: tenders will NOT close at '
      + 'close_at, follow-ups will not send, the budget digest will not run.',
    );
  }
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const cfg = app.get(AppConfig);
  app.use(helmet());
  app.use(cookieParser());
  // Credentials mode → reflect only known origins, never a wildcard.
  app.enableCors({ origin: cfg.webOrigins, credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const port = parseInt(process.env.API_PORT ?? '3000', 10);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Leadprocure API listening on :${port}`);
}
void bootstrap();
