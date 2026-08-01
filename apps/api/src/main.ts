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
  const app = await NestFactory.create(AppModule);
  const cfg = app.get(AppConfig);
  app.use(helmet());
  app.use(cookieParser());
  // Credentials mode → reflect only known origins, never a wildcard.
  app.enableCors({ origin: cfg.webOrigins, credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const port = cfg.apiPort;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Leadprocure API listening on :${port}`);
}
void bootstrap();
