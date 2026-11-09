import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join, relative, sep } from 'path';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { nextDocumentNo, nextDocumentNoForDay } from '../src/common/procurement/document-no';
import { addApprover, teardown } from './helpers';

// Год в номере документа — не год процесса.
//
// Номер состоит из типа, ГОДА и сквозного счётчика. Год брали из
// `new Date().getFullYear()`, то есть по поясу ПРОЦЕССА, а в прод-контейнере это UTC. В
// Баку (+04) заказ, выписанный 1 января между 00:00 и 04:00, получал номер `PO-2025-…` — и
// уезжал наружу вместе с датой `2026-01-01`: номер заказа стоит в `<cac:OrderReference>`
// той же УБЛ-выгрузки, в которой `<cbc:IssueDate>` уже называет новый год.
//
// Решение (9 ноября 2026, продолжение решения про `issue_date`): год считает БАЗА, тем же
// выражением и в том же операторе, что выдаёт счётчик, по `APP_TIMEZONE`. Разбор —
// `docs/invoice-issue-date-decision.md`, выпуск номеров — `common/procurement/document-no.ts`.
//
// ПРИЁМ, которым этот набор краснеет на прежней арифметике В ЛЮБОЙ ЧАС. Для ДНЯ хватало
// двух поясов (у `invoice-issue-date` это +14 и −12, 26 часов между ними), но для ГОДА
// такой приём не работает: два пояса дают разные годы только около Нового года, и проверка
// была бы зелёной 364 дня. Поэтому часы ПРОЦЕССА подменяются на полдень 1 июля ПРОШЛОГО
// года — ровно тот источник, из которого год и брали. Любая реализация, читающая часы
// процесса, называет прошлый год; та, что спрашивает базу, называет текущий. Расхождение
// гарантировано всегда, и оно не зависит ни от часа, ни от даты прогона, ни от пояса
// раннера. Подмена действует только на время самого вызова и проверяется отдельно: приём,
// который молча не сработал, сделал бы весь набор зелёным по ошибке.
const ZONE = 'Pacific/Kiritimati'; // +14, без переходов на летнее время
const yearIn = (zone: string, at: Date) =>
  Number(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric' }).format(at));
const FROZEN_YEAR = yearIn(ZONE, new Date()) - 1;
const FROZEN_MS = Date.UTC(FROZEN_YEAR, 6, 1, 12, 0, 0);

async function withProcessClockInAnotherYear<T>(fn: () => Promise<T>): Promise<T> {
  const Real = globalThis.Date;
  // Proxy, а не подкласс: `new Date(что-то)` и `Date.parse` должны остаться прежними —
  // драйвер базы разбирает ими метки времени, — а подменить нужно ровно «сейчас».
  const Frozen = new Proxy(Real, {
    construct: (t, args) => (args.length === 0 ? new (t as any)(FROZEN_MS) : new (t as any)(...args)),
    get: (t, prop) => (prop === 'now' ? () => FROZEN_MS : Reflect.get(t, prop)),
  });
  (globalThis as any).Date = Frozen;
  try {
    return await fn();
  } finally {
    (globalThis as any).Date = Real;
  }
}

describe('год в номере документа (API e2e)', () => {
  let app: INestApplication;
  let db: Client;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ['Authorization', `Bearer ${t}`] as [string, string];
  const originalZone = process.env.APP_TIMEZONE;

  let buyer: string, approver: string, supplierOrg: string, buyerOrg: string;
  let approvedRequestId: string;
  // Интерфейс, который ждёт выпуск номеров: `query(sql, params) -> строки`.
  const m = { query: async (sql: string, params: unknown[]) => (await db.query(sql, params as any[])).rows };

  beforeAll(async () => {
    // Пояс установки выставляется ДО создания приложения: `AppConfig` читает его один раз.
    // И он не UTC намеренно — под UTC-раннером утверждение «год из пояса установки» было бы
    // неотличимо от «год из UTC».
    process.env.APP_TIMEZONE = ZONE;
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();

    const reg = async (path: string, name: string, email: string) => {
      const r = await http().post(path).send({ legalName: name, email, password: 'password123', fullName: name }).expect(201);
      return { token: r.body.accessToken as string, org: r.body.org.id as string };
    };
    ({ token: buyer, org: buyerOrg } = await reg('/auth/register/buyer', `DocNo Buyer ${tag}`, `dnb-${tag}@t.test`));
    approver = await addApprover(app, buyer, tag);
    ({ org: supplierOrg } = await reg('/auth/register/supplier', `DocNo Sup ${tag}`, `dns-${tag}@t.test`));

    await http().post(`/suppliers/${supplierOrg}/invite`).set(...bearer(buyer)).expect(201);
    const relId = (await http().get('/suppliers').set(...bearer(buyer)).expect(200)).body
      .find((r: any) => r.supplier_org_id === supplierOrg).id;
    await http().post(`/suppliers/relationships/${relId}/status`).set(...bearer(buyer)).send({ status: 'APPROVED' }).expect(201);
    await http().put('/requests/method-policies').set(...bearer(buyer))
      .send({ policies: [{ category: '*', minAmountMinor: 0, maxAmountMinor: null, method: 'DIRECT' }] }).expect(200);

    // Заявку готовим на НАСТОЯЩИХ часах: одобрение считает «сегодня» в JS (budgets), и
    // подменять часы там значило бы проверять совсем другое.
    const req = await http().post('/requests').set(...bearer(buyer))
      .send({ title: `DocNo ${tag}`, items: [{ name: 'Widget', qty: 2, estUnitPriceMinor: 100_000 }] }).expect(201);
    approvedRequestId = req.body.id;
    await http().post(`/requests/${approvedRequestId}/submit`).set(...bearer(buyer)).expect(201);
    await http().post(`/requests/${approvedRequestId}/approve`).set(...bearer(approver)).expect(201);
  });

  afterAll(async () => {
    await teardown(
      db,
      // Пауза ВНУТРИ шага закрытия: рассылка уходит в пост-коммитную очередь и читает
      // получателей на своём соединении уже после ответа — закрыть приложение сразу значит
      // оборвать её и получить `Connection terminated` в журнале после teardown.
      { close: async () => { await new Promise((r) => setTimeout(r, 500)); if (app) await app.close(); } },
      () => db.query(`DELETE FROM organizations WHERE legal_name LIKE $1`, [`DocNo %${tag}%`]),
      // Набор идёт одним процессом на все файлы (--runInBand): оставить пояс сдвинутым
      // значило бы тихо переназначить день и год каждому следующему набору.
      () => {
        if (originalZone === undefined) delete process.env.APP_TIMEZONE;
        else process.env.APP_TIMEZONE = originalZone;
      },
    );
  });

  it('подмена часов процесса действительно действует и снимается', async () => {
    const inside = await withProcessClockInAnotherYear(async () => ({
      ctor: new Date().getFullYear(),
      now: new Date(Date.now()).getFullYear(),
    }));
    expect(inside).toEqual({ ctor: FROZEN_YEAR, now: FROZEN_YEAR });
    expect(new Date().getFullYear()).not.toBe(FROZEN_YEAR);
    // `new Date(значение)` подмена не трогает — иначе драйвер базы разбирал бы метки
    // времени неправильно, и красным стало бы всё, а не проверяемое утверждение.
    expect(new Date('2019-03-04T05:06:07Z').getUTCFullYear()).toBe(2019);
  });

  it('номер заявки называет год пояса установки, а не год часов процесса', async () => {
    const req = await withProcessClockInAnotherYear(() =>
      http().post('/requests').set(...bearer(buyer))
        .send({ title: `DocNo year ${tag}`, items: [{ name: 'Widget', qty: 1, estUnitPriceMinor: 1000 }] })
        .expect(201),
    );
    expect(req.body.request_no).toMatch(new RegExp(`^REQ-${yearIn(ZONE, new Date())}-\\d{4}$`));
    expect(req.body.request_no).not.toContain(`-${FROZEN_YEAR}-`);
  });

  it('номер заказа называет год пояса установки, а не год часов процесса', async () => {
    const po = await withProcessClockInAnotherYear(() =>
      http().post(`/orders/direct/from-request/${approvedRequestId}`).set(...bearer(buyer))
        .send({ supplierOrgId: supplierOrg }).expect(201),
    );
    expect(po.body.po_no).toMatch(new RegExp(`^PO-${yearIn(ZONE, new Date())}-\\d{4}$`));
    expect(po.body.po_no).not.toContain(`-${FROZEN_YEAR}-`);
  });

  // Четыре типа через само место выпуска: так проверяется и то, что выражение с поясом
  // работает для каждого из них (а не только для тех двух, что пройдены по HTTP выше).
  it.each(['REQ', 'PO', 'CTR', 'INV'] as const)(
    '%s: год берётся из базы по поясу установки',
    async (type) => {
      const no = await withProcessClockInAnotherYear(() => nextDocumentNo(m, buyerOrg, type, ZONE));
      expect(no).toMatch(new RegExp(`^${type}-${yearIn(ZONE, new Date())}-\\d{4}$`));
      expect(no).not.toContain(`-${FROZEN_YEAR}-`);
    },
  );

  it('у счёта год берётся из его собственного зафиксированного дня', async () => {
    // Путь счёта отличается нарочно: его день записан в `invoices.issue_date` и при чтении
    // не пересчитывается, поэтому год номера обязан быть годом ИМЕННО этого дня. Год здесь
    // не равен ни текущему, ни подменённому — значит решает переданный день, а не часы.
    const no = await withProcessClockInAnotherYear(() =>
      nextDocumentNoForDay(m, buyerOrg, 'INV', '2031-02-03'),
    );
    expect(no).toMatch(/^INV-2031-\d{4}$/);
  });
});

// Пять мест, в которых год брали из часов процесса, свелись к одному. Это утверждение о
// СТРОЕНИИ, и оно нужно потому, что проверить по HTTP каждый путь (договор из награды,
// заказ по договору, заказ из каталога) стоит дороже, чем он того стоит, а завести год по
// поясу процесса заново — ровно одна строка в следующем модуле.
describe('номера документов выпускает одно место', () => {
  const srcRoot = join(__dirname, '..', 'src');
  const files: string[] = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) files.push(p);
    }
  })(srcRoot);
  const rel = (f: string) => relative(srcRoot, f).split(sep).join('/');
  const having = (re: RegExp) => files.filter((f) => re.test(readFileSync(f, 'utf8'))).map(rel).sort();

  it('счётчик вызывают только из места выпуска', () => {
    expect(having(/next_document_no\(/).filter((f) => !f.startsWith('common/db/migrations/')))
      .toEqual(['common/procurement/document-no.ts']);
  });

  it('формат номера нигде не собирают вручную', () => {
    expect(having(/`(REQ|PO|CTR|INV)-\$\{/)).toEqual([]);
  });

  it('год в номере считает база, а не процесс', () => {
    const src = readFileSync(join(srcRoot, 'common', 'procurement', 'document-no.ts'), 'utf8');
    expect(src).toMatch(/to_char\(now\(\) AT TIME ZONE \$3, 'YYYY'\)/);
    // Строка с годом не должна появиться из JS ни здесь, ни где-либо ещё в выпуске номеров.
    expect(src.replace(/^\s*\/\/.*$/gm, '')).not.toMatch(/getFullYear|getUTCFullYear/);
  });
});
