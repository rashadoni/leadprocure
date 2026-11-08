import { Injectable } from '@nestjs/common';
import type { DeploymentMode, Edition } from '@leadprocure/shared';
import { resolveAppTimezone } from './timezone';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
function opt(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}
function int(name: string, fallback: number): number {
  const v = process.env[name];
  return v ? parseInt(v, 10) : fallback;
}
function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  return v == null ? fallback : v === 'true' || v === '1';
}

// Central typed configuration. process.env is populated by loadRootEnv() in main.ts / seed.ts.
@Injectable()
export class AppConfig {
  readonly nodeEnv = opt('NODE_ENV', 'development');
  readonly apiPort = int('API_PORT', 3000);
  readonly deploymentMode = opt('DEPLOYMENT_MODE', 'cloud_multi_tenant') as DeploymentMode;

  readonly databaseUrl = req('DATABASE_URL');

  readonly jwtAccessSecret = opt('JWT_ACCESS_SECRET', 'dev_access_secret_change_me');
  readonly jwtAccessTtl = int('JWT_ACCESS_TTL', 900);
  readonly jwtRefreshSecret = opt('JWT_REFRESH_SECRET', 'dev_refresh_secret_change_me');
  readonly jwtRefreshTtl = int('JWT_REFRESH_TTL', 1209600);
  readonly refreshCookieName = opt('REFRESH_COOKIE_NAME', 'lp_refresh');
  readonly refreshCookieSecure = bool('REFRESH_COOKIE_SECURE', false);
  // Rotating-refresh reuse leeway: a just-rotated token replayed within this window is
  // treated as a benign race (SPA reload / StrictMode double-mount / concurrent 401s),
  // not theft. Only reuse older than this trips the "revoke the family" breach response.
  readonly refreshReuseLeewayMs = int('JWT_REFRESH_REUSE_LEEWAY_MS', 15000);
  // Пауза между присуждением и контрактом: столько часов проигравший может возразить, пока
  // дверь ещё открыта (отмена присуждения после создания контракта уже невозможна).
  //
  // Это УМОЛЧАНИЕ, а не единственный источник. Срок берётся из политики организации по
  // методу закупки (`award_standstill_policies`, миграция 0049) — и только когда политики
  // для метода нет, применяется это число. Иначе в мультиарендном продукте регулируемый
  // закупщик не мог бы получить свои 24 часа, не изменив паузу ВСЕМ и не перезапустив API:
  // «регулируемой закупке ставят 24» было невыполнимо буквально, ставили не закупке, а
  // серверу.
  //
  // Ноль по умолчанию — чтобы у тех, кто политик не заводил, ничего не изменилось: новый
  // запрет, останавливающий закупщика посреди работы, включают осознанно.
  //
  // Уведомление участникам и страница итогов работают независимо от этого числа: сказать
  // проигравшему, что решение принято, нужно всегда, а ждать — не всегда.
  //
  // Значение ОТВЕРГАЕТСЯ, а не приводится, и это важнее, чем кажется.
  //
  // Сначала я зажал его `Math.min(Math.max(…))` — и это тихо делало защиту слабее, чем
  // просил оператор: `5000` становилось `720` (пауза короче заказанной), `-24` становилось
  // `0` (паузы нет вовсе — опечатка выключила защиту второй стороны), а нечисловое
  // значение проходило насквозь как `NaN`, потому что `Math.max(NaN, 0)` это `NaN`.
  // Дальше `NaN` доезжал до БД и ронял САМО присуждение для всей организации с ошибкой
  // «invalid input syntax for type integer», в которой про эту переменную ничего нет.
  //
  // Для контроля, который существует ради второй стороны, тихое ослабление — не та сторона,
  // в которую стоит ошибаться. И сравните с таблицей политик: там выход за границу
  // отвергается `CHECK`-ом. Одна граница должна вести себя одинаково в обоих местах.
  //
  // `Number`, а не `parseInt`: `parseInt('24h')` даёт `24`, то есть молча читает мусор как
  // число. Выкладка с опечаткой теперь не поднимется и скажет, в какой переменной дело.
  readonly awardStandstillHours = (() => {
    const raw = process.env.AWARD_STANDSTILL_HOURS;
    const h = raw === undefined || raw === '' ? 0 : Number(raw);
    if (!Number.isInteger(h) || h < 0 || h > 720) {
      throw new Error(
        `AWARD_STANDSTILL_HOURS must be an integer 0..720, got ${JSON.stringify(raw)}`,
      );
    }
    return h;
  })();

  // Какой день считается днём документа. Пока это читает ОДНО место — дата выставления
  // счёта, которая уходит наружу в УБЛ/e-qaimə и в реестр для 1С, — и решение владельца
  // (8 ноября 2026) записано в `docs/invoice-issue-date-decision.md`.
  //
  // Момент выставления хранится в `invoices.issued_at` (`timestamptz`), и момент — это не
  // день: чтобы назвать день, нужен пояс. Раньше его брали из `toISOString()`, то есть в
  // UTC, и это НЕ зависело от `TZ` процесса — такая строка в UTC по построению. В Баку
  // (+04) счёт, выписанный между 00:00 и 04:00, уносил в налоговый документ ПРЕДЫДУЩИЙ
  // день, причём экран показывал правильный: веб печатает `issued_at` по поясу браузера.
  //
  // Одна настройка на установку, а не поле у каждой организации: рынок один, и вторая
  // настройка, без которой первая молча врёт, дороже той честности, которую она даёт.
  //
  // Значение ОТВЕРГАЕТСЯ, а не приводится: опечатка в названии пояса не должна тихо
  // превратиться в UTC и сдвинуть дату налогового документа на сутки. Почему именно имя
  // зоны, а не смещение, и почему проверок две — в `timezone.ts`: Node и Postgres читают
  // строку-смещение с ОБРАТНЫМИ знаками, и `+04:00` дал бы день от UTC−4.
  readonly appTimezone = resolveAppTimezone(process.env.APP_TIMEZONE);

  readonly bidMasterKeyB64 = opt('BID_MASTER_KEY_B64', '');

  readonly licensePublicKeyB64 = opt('LICENSE_PUBLIC_KEY_B64', '');
  readonly licenseFile = opt('LICENSE_FILE', '');
  readonly licenseDevEdition = opt('LICENSE_DEV_EDITION', 'enterprise') as Edition;

  readonly clamavEnabled = bool('CLAMAV_ENABLED', false);
  readonly clamavHost = opt('CLAMAV_HOST', 'localhost');
  readonly clamavPort = int('CLAMAV_PORT', 3310);

  // Comma-separated allowed browser origins for CORS (credentials mode requires
  // an explicit origin, never a wildcard).
  readonly webOrigins = opt('WEB_ORIGIN', 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // First allowed origin is where password-reset / invite links point.
  readonly webBaseUrl = this.webOrigins[0] ?? 'http://localhost:5173';

  readonly smtpHost = opt('SMTP_HOST', '');
  readonly smtpPort = int('SMTP_PORT', 587);
  readonly smtpUser = opt('SMTP_USER', '');
  readonly smtpPass = opt('SMTP_PASS', '');
  readonly mailFrom = opt('MAIL_FROM', 'Leadprocure <no-reply@leadprocure.local>');
}
