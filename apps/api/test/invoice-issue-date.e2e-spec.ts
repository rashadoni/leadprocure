import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { AppConfig } from '../src/common/config/config.service';
import { addApprover } from './helpers';

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
    if (db) {
      await db.query(`DELETE FROM organizations WHERE legal_name LIKE $1`, [`IssueDate %${tag}%`]);
      await db.end();
    }
    if (owner) await owner.end();
    if (app) await app.close();
    // Набор один процесс на все файлы под --runInBand: оставить пояс сдвинутым значило бы
    // тихо переназначить день каждому следующему набору.
    if (originalZone === undefined) delete process.env.APP_TIMEZONE;
    else process.env.APP_TIMEZONE = originalZone;
  });

  // Утверждение, которое держится в любой час: сохранённый день — это день сохранённого
  // момента в поясе установки. Пояс здесь +14, так что день по UTC отличается от него 14
  // часов в сутки — то есть возврат к UTC-дню краснеет тут почти всегда, а в следующей
  // проверке (там момент задан) — всегда.
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

  // Настройка одна на установку, и у неё есть умолчание рынка. Опечатка в названии пояса
  // отвергается, а не приводится к UTC: иначе она тихо сдвинула бы дату налогового
  // документа на сутки — ровно то, от чего эта работа и затевалась.
  describe('APP_TIMEZONE', () => {
    const restore = (v: string | undefined) => {
      if (v === undefined) delete process.env.APP_TIMEZONE;
      else process.env.APP_TIMEZONE = v;
    };

    it('по умолчанию Asia/Baku', () => {
      const was = process.env.APP_TIMEZONE;
      delete process.env.APP_TIMEZONE;
      try {
        expect(new AppConfig().appTimezone).toBe('Asia/Baku');
      } finally {
        restore(was);
      }
    });

    it('неизвестный пояс не поднимается', () => {
      const was = process.env.APP_TIMEZONE;
      process.env.APP_TIMEZONE = 'Asia/Baki';
      try {
        expect(() => new AppConfig()).toThrow(/APP_TIMEZONE/);
      } finally {
        restore(was);
      }
    });
  });
});
