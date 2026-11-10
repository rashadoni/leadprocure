import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { AccessLogMiddleware } from '../src/common/http/access-log.middleware';
import { AppConfig } from '../src/common/config/config.service';

/**
 * Журнал запросов api существует ради одного случая: отказ, у которого больше нигде нет
 * следа. Отказ ограничителя частоты (429) именно такой — `ThrottlerGuard` бросает
 * `HttpException`, Nest отвечает клиенту и НЕ пишет об этом ни строки. Поэтому проверка
 * меряет не «пишется ли вообще что-нибудь», а ровно то, из-за чего четыре прогона приёмки
 * 10 ноября 2026 перезапустили, не поняв причины: виден ли в логе api код 429.
 *
 * Ограничитель здесь — `/auth/forgot-password` (5/мин): он дешёвый (неизвестный адрес не
 * считает argon2 и не пишет в базу) и у него самый низкий предел, то есть шести запросов
 * хватает. `/auth/login` для этого не годится — он 10/мин, и на этом пределе уже стоит
 * браузерный набор.
 */
describe('access log (API e2e)', () => {
  let app: INestApplication;
  const lines: string[] = [];

  beforeAll(async () => {
    // Читается конструктором AppConfig, поэтому до сборки модуля.
    process.env.HTTP_ACCESS_LOG = '1';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useLogger({
      log: (m: unknown) => { lines.push(String(m)); },
      warn: (m: unknown) => { lines.push(String(m)); },
      error: () => undefined,
      debug: () => undefined,
      verbose: () => undefined,
    });
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    lines.length = 0; // разбор маршрутов на старте нас здесь не интересует
  });

  afterAll(async () => {
    delete process.env.HTTP_ACCESS_LOG;
    await app.close();
  });

  it('пишет строку на каждый запрос, и 429 от ограничителя частоты в ней виден', async () => {
    const server = app.getHttpServer();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await request(server)
        .post('/auth/forgot-password')
        .send({ email: `absent-${randomUUID().slice(0, 8)}@nobody.invalid` });
      statuses.push(res.status);
    }
    // Пятый ещё проходит, шестой — нет. Если ограничитель вдруг перестанет работать, падать
    // должна эта строка, а не следующая: иначе проверка журнала станет проверкой ни о чём.
    expect(statuses.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
    expect(statuses[5]).toBe(429);

    const own = lines.filter((l) => l.includes('/auth/forgot-password'));
    expect(own).toHaveLength(6);
    // Та самая строка, которой не было в артефакте.
    expect(own.filter((l) => / 429 /.test(l))).toHaveLength(1);
    // Путь без строки запроса и без тела: в логе не должно оказаться ни того, что человек
    // набрал, ни cookie.
    expect(own.every((l) => /^POST \/auth\/forgot-password \d{3} \d+ms$/.test(l))).toBe(true);
  });

  it('выключенный журнал не подписывается на ответ и не говорит ничего', () => {
    const said = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warned = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const mw = new AccessLogMiddleware({ httpAccessLog: false } as unknown as AppConfig);
      let passedOn = false;
      mw.use(
        { method: 'GET', originalUrl: '/health' } as never,
        { on: () => { throw new Error('подписка на finish при выключенном журнале'); } } as never,
        () => { passedOn = true; },
      );
      expect(passedOn).toBe(true);
      expect(said).not.toHaveBeenCalled();
      expect(warned).not.toHaveBeenCalled();
    } finally {
      said.mockRestore();
      warned.mockRestore();
    }
  });
});
