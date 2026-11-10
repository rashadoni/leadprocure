import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AppConfig } from '../src/common/config/config.service';
import { assertZoneKnownToPostgres, resolveAppTimezone } from '../src/common/config/timezone';
import { addApprover, teardown } from './helpers';

// День счёта — не момент счёта.
//
// `invoices.issued_at` это `timestamptz`, то есть МОМЕНТ; день из него получается только с
// поясом. Выгрузки брали его через `toISOString()` — то есть в UTC, и в UTC ВСЕГДА, по
// построению такой строки, а не потому что контейнер в UTC. В Баку (+04) счёт, выписанный
// между 00:00 и 04:00, уносил в `<cbc:IssueDate>` УБЛ-документа (он уходит наружу, в
// e-qaimə) и в колонку «Дата» реестра для 1С ПРЕДЫДУЩИЙ день — при том что на экране стояло
// правильное число, потому что веб печатает `issued_at` по поясу браузера.
//
// Решение владельца (8 ноября 2026): день по Баку, зафиксированный при выставлении. Он
// лежит в `invoices.issue_date` (миграция 0051), считается один раз, по `APP_TIMEZONE`, и
// при чтении не пересчитывается вообще. Разбор — `docs/invoice-issue-date-decision.md`.
//
// Весь набор идёт под НЕ-UTC поясом установки (+14), выставленным до создания приложения:
// под UTC-раннером утверждение «день берут из пояса установки» проверить нельзя, оно
// выполнялось бы само собой.
const ZONE = 'Pacific/Kiritimati'; // +14, без переходов на летнее время
const dayIn = (zone: string, at: string | Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(at));
const dayInUtc = (at: string | Date) => new Date(at).toISOString().slice(0, 10);

describe('дата выставления счёта (API e2e)', () => {
  let app: INestApplication;
  let db: Client;
  let owner: Client;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ['Authorization', `Bearer ${t}`] as [string, string];
  const originalZone = process.env.APP_TIMEZONE;

  let buyer: string, approver: string, supplier: string, supplierOrg: string;
  let poId: string, poItemId: string;
  let invoice: any;

  beforeAll(async () => {
    process.env.APP_TIMEZONE = ZONE;
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    // Счёт принадлежит поставщику, и под RLS без контекста запроса его не тронуть: правки
    // момента выставления идут владельцем схемы, как в date-columns.e2e-spec.ts.
    owner = new Client({ connectionString: process.env.DATABASE_OWNER_URL ?? process.env.DATABASE_URL });
    await owner.connect();

    const reg = async (path: string, name: string, email: string) => {
      const r = await http().post(path).send({ legalName: name, email, password: 'password123', fullName: name }).expect(201);
      return { token: r.body.accessToken as string, org: r.body.org.id as string };
    };
    ({ token: buyer } = await reg('/auth/register/buyer', `IssueDate Buyer ${tag}`, `idb-${tag}@t.test`));
    approver = await addApprover(app, buyer, tag);
    ({ token: supplier, org: supplierOrg } = await reg('/auth/register/supplier', `IssueDate Sup ${tag}`, `ids-${tag}@t.test`));

    await http().post(`/suppliers/${supplierOrg}/invite`).set(...bearer(buyer)).expect(201);
    const relId = (await http().get('/suppliers').set(...bearer(buyer)).expect(200)).body
      .find((r: any) => r.supplier_org_id === supplierOrg).id;
    await http().post(`/suppliers/relationships/${relId}/status`).set(...bearer(buyer)).send({ status: 'APPROVED' }).expect(201);
    await http().put('/requests/method-policies').set(...bearer(buyer))
      .send({ policies: [{ category: '*', minAmountMinor: 0, maxAmountMinor: null, method: 'DIRECT' }] }).expect(200);

    const req = await http().post('/requests').set(...bearer(buyer))
      .send({ title: `IssueDate ${tag}`, items: [{ name: 'Widget', qty: 2, estUnitPriceMinor: 100_000 }] }).expect(201);
    await http().post(`/requests/${req.body.id}/submit`).set(...bearer(buyer)).expect(201);
    await http().post(`/requests/${req.body.id}/approve`).set(...bearer(approver)).expect(201);
    const po = await http().post(`/orders/direct/from-request/${req.body.id}`).set(...bearer(buyer))
      .send({ supplierOrgId: supplierOrg }).expect(201);
    poId = po.body.id;
    poItemId = po.body.items[0].id;
    await http().post(`/orders/${poId}/status`).set(...bearer(buyer)).send({ status: 'ISSUED' }).expect(201);
    for (const s of ['CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED']) {
      await http().post(`/orders/${poId}/status`).set(...bearer(supplier)).send({ status: s }).expect(201);
    }
    await http().post(`/orders/${poId}/receipts`).set(...bearer(buyer)).send({ items: [{ poItemId, qty: 2 }] }).expect(201);
    invoice = (await http().post(`/invoices/from-po/${poId}`).set(...bearer(supplier))
      .send({ items: [{ poItemId, qty: 2, unitPriceMinor: 100_000 }] }).expect(201)).body;
  });

  afterAll(async () => {
    await teardown(
      db,
      // Второе соединение закрывается здесь же, одним гарантированным шагом с приложением.
      { close: async () => { if (owner) await owner.end(); if (app) await app.close(); } },
      () => db.query(`DELETE FROM organizations WHERE legal_name LIKE $1`, [`IssueDate %${tag}%`]),
      // Набор один процесс на все файлы под --runInBand: оставить пояс сдвинутым значило бы
      // тихо переназначить день каждому следующему набору.
      () => {
        if (originalZone === undefined) delete process.env.APP_TIMEZONE;
        else process.env.APP_TIMEZONE = originalZone;
      },
    );
  });

  // Утверждение, которое держится в любой час: сохранённый день — это день сохранённого
  // момента в поясе установки. Само по себе оно ловит не всё — возврат к дню в UTC краснеет
  // тут 14 часов из 24, а зашитый `Asia/Baku` вместо чтения настройки и вовсе 10 из 24, —
  // поэтому путь записи закрыт отдельно, двумя поясами («настройка решает» ниже), где
  // расхождение гарантировано в любой час.
  it('день выставления — это день момента выставления в поясе установки', async () => {
    expect(invoice.issue_date).toBe(dayIn(ZONE, invoice.issued_at));
    // `date` драйвер отдаёт текстом (common/db/pg-date-type.ts), и это важно именно здесь:
    // объект Date на этом месте снова превратился бы в день в UTC при первом toISOString().
    expect(typeof invoice.issue_date).toBe('string');
  });

  // Номер и дата в одном документе не должны называть разные годы: год номера брали из
  // `new Date().getFullYear()`, то есть по поясу ПРОЦЕССА.
  it('номер счёта называет год своей собственной даты', () => {
    expect(invoice.invoice_no).toMatch(new RegExp(`^INV-${invoice.issue_date.slice(0, 4)}-\\d{4}$`));
  });

  // Тот самый дефект, и здесь он виден без всякой зависимости от часов прогона: момент
  // задан так, что бакинский день и день по UTC — разные числа.
  describe('момент выставления между 00:00 и 04:00 по Баку', () => {
    const AT = '2026-03-01T22:30:00Z'; // 2 марта 02:30 в Баку
    const BAKU_DAY = '2026-03-02';
    const UTC_DAY = '2026-03-01';

    beforeAll(async () => {
      await owner.query(`UPDATE invoices SET issued_at = $2, issue_date = $3 WHERE id = $1`,
        [invoice.id, AT, BAKU_DAY]);
    });

    it('в УБЛ-документ уходит зафиксированный день, а не день в UTC', async () => {
      const xml = (await http().get(`/invoices/${invoice.id}/ubl`).set(...bearer(buyer)).expect(200)).text;
      expect(xml).toContain(`<cbc:IssueDate>${BAKU_DAY}</cbc:IssueDate>`);
      expect(xml).not.toContain(UTC_DAY);
    });

    it('в реестре для 1С стоит тот же день', async () => {
      const csv = (await http().get('/invoices/export/1c').set(...bearer(buyer)).expect(200)).text;
      expect(csv).toContain(`"${invoice.invoice_no}";"${BAKU_DAY}";`);
      expect(csv).not.toContain(`"${UTC_DAY}"`);
    });

    // Решение владельца именно про это: документ, ушедший в налоговую, свою дату не меняет.
    // Если день снова начнут считать из момента, сдвиг момента потянет за собой дату.
    it('сдвиг момента выставления не двигает дату документа', async () => {
      await owner.query(`UPDATE invoices SET issued_at = issued_at - interval '2 days' WHERE id = $1`, [invoice.id]);
      const xml = (await http().get(`/invoices/${invoice.id}/ubl`).set(...bearer(buyer)).expect(200)).text;
      expect(xml).toContain(`<cbc:IssueDate>${BAKU_DAY}</cbc:IssueDate>`);
      const back = (await http().get(`/invoices/${invoice.id}`).set(...bearer(buyer)).expect(200)).body;
      expect(back.issue_date).toBe(BAKU_DAY);
      expect(dayInUtc(back.issued_at)).toBe('2026-02-27');
    });
  });

  // Детерминированное доказательство того, что день берут из НАСТРОЙКИ.
  //
  // Проверка выше сравнивает с `now()`, и когда пояс установки и UTC называют одно число,
  // она зелёная при любой реализации. Поэтому счёт выставляется ВТОРОЙ раз — вторым
  // приложением, поднятым с другим поясом установки. Между `Pacific/Kiritimati` (+14) и
  // `Etc/GMT+12` (−12) двадцать шесть часов, то есть их календарные дни не могут совпасть
  // никогда, в любой час прогона. Любая реализация, которая настройку игнорирует — день в
  // UTC, зашитый `Asia/Baku`, пояс процесса, — даёт у двух счетов ОДИН день и краснеет
  // всегда.
  describe('настройка решает, а не UTC и не зашитый пояс', () => {
    const ZONE2 = 'Etc/GMT+12'; // −12; настоящее имя IANA, знак у него обратный по правилам самой IANA
    let app2: INestApplication;
    let second: any;

    beforeAll(async () => {
      process.env.APP_TIMEZONE = ZONE2;
      const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app2 = mod.createNestApplication();
      app2.use(cookieParser());
      app2.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
      await app2.init();
      // Тот же заказ и тот же поставщик: нужен только день второго счёта. Количество уже
      // выставлено первым счётом, поэтому этот выйдет DISPUTED — к делу это не относится.
      second = (await request(app2.getHttpServer()).post(`/invoices/from-po/${poId}`).set(...bearer(supplier))
        .send({ items: [{ poItemId, qty: 2, unitPriceMinor: 100_000 }] }).expect(201)).body;
    });

    afterAll(async () => {
      // Дать дорассылке дойти до конца, прежде чем закрывать приложение. `notifyOrg`
      // складывает рассылку в пост-коммитную очередь (`rc.onCommit`), и получателей она
      // читает на СВОЁМ соединении уже после ответа. Закрыть приложение сразу после
      // выставления счёта значит оборвать её на полуслове — письма тут и так не уходят
      // (`SMTP_HOST` пуст), но в журнал прогона падает «Connection terminated», а лог после
      // teardown это ровно та причина, по которой прогон однажды вышел с ошибкой при 374
      // зелёных тестах (FollowupsScheduler, run 41226454840).
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (app2) await app2.close();
      process.env.APP_TIMEZONE = ZONE;
    });

    it('два пояса установки дают разные дни для одного и того же мгновения', () => {
      // Один момент, два пояса — расхождение здесь не зависит от часа прогона совсем.
      expect(second.issue_date).toBe(dayIn(ZONE2, second.issued_at));
      expect(second.issue_date).not.toBe(dayIn(ZONE, second.issued_at));
      expect(invoice.issue_date).not.toBe(dayIn(ZONE2, invoice.issued_at));
      // И то же самое как факт о двух документах: у них разные дни выставления.
      expect(second.issue_date).not.toBe(invoice.issue_date);
    });

    it('номер второго счёта тоже называет год своей даты', () => {
      expect(second.invoice_no).toMatch(new RegExp(`^INV-${second.issue_date.slice(0, 4)}-\\d{4}$`));
    });
  });

  // Настройка одна на установку, и у неё есть умолчание рынка. Опечатка отвергается, а не
  // приводится к UTC: иначе она тихо сдвинула бы дату налогового документа — ровно то, от
  // чего эта работа и затевалась.
  describe('APP_TIMEZONE', () => {
    it('по умолчанию Asia/Baku', () => {
      const was = process.env.APP_TIMEZONE;
      delete process.env.APP_TIMEZONE;
      try {
        expect(resolveAppTimezone(undefined)).toBe('Asia/Baku');
        expect(resolveAppTimezone('')).toBe('Asia/Baku');
        expect(new AppConfig().appTimezone).toBe('Asia/Baku');
      } finally {
        if (was === undefined) delete process.env.APP_TIMEZONE;
        else process.env.APP_TIMEZONE = was;
      }
    });

    // Главное здесь — смещения. Node принимает `+04:00` как идентификатор зоны, а Postgres
    // читает строку-смещение по правилам POSIX, где знак ОБРАТНЫЙ: `AT TIME ZONE '+04:00'`
    // это UTC−4. Такое значение положило бы в налоговый документ день, отстоящий от
    // задуманного на восемь часов, и положило бы навсегда — день фиксируется при
    // выставлении. Проверено живьём: `+04:00` дал в Postgres 2026-11-08 там, где
    // `Asia/Baku` даёт 2026-11-09.
    it.each(['+04:00', '+04', '-08:00', '04:00', 'UTC+4', 'Asia/Baki', 'Европа/Баку'])(
      'не поднимается с APP_TIMEZONE=%s', (bad) => {
        expect(() => resolveAppTimezone(bad)).toThrow(/APP_TIMEZONE/);
      },
    );

    it('имена зон принимаются, включая Etc/GMT+N — его оба движка читают одинаково', () => {
      for (const good of ['Asia/Baku', 'UTC', 'Europe/Berlin', 'Etc/GMT+4', 'America/Argentina/Buenos_Aires']) {
        expect(resolveAppTimezone(good)).toBe(good);
      }
    });

    // Вторая половина проверки: имя должно знать та база, которая день и считает. Так
    // утверждение «наборы зон у ICU и Postgres совпадают» перестаёт быть предположением.
    // `+04:00` взят как заведомо неизвестное Postgres значение — форму оно уже не проходит,
    // но для этой проверки важно именно то, что в `pg_timezone_names` его нет.
    it('имя сверяется с самой базой при старте', async () => {
      const q = (sql: string, params: unknown[]) => app.get(DataSource).query(sql, params);
      await expect(assertZoneKnownToPostgres(q, 'Asia/Baku')).resolves.toBeUndefined();
      await expect(assertZoneKnownToPostgres(q, ZONE)).resolves.toBeUndefined();
      await expect(assertZoneKnownToPostgres(q, '+04:00')).rejects.toThrow(/pg_timezone_names/);

      // Регистр: `pg_timezone_names` хранит канонический вид, а `AT TIME ZONE` и `Intl`
      // принимают любой. Сверка по точному равенству отказывала в старте на рабочем
      // значении — и винила в сообщении Postgres.
      await expect(assertZoneKnownToPostgres(q, 'asia/baku')).resolves.toBeUndefined();
      await expect(assertZoneKnownToPostgres(q, 'ASIA/BAKU')).resolves.toBeUndefined();
      // А несуществующая зона по-прежнему отвергается, в любом регистре.
      await expect(assertZoneKnownToPostgres(q, 'asia/baki')).rejects.toThrow(/not a time zone/);    });
  });
});
