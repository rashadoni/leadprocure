import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { addApprover, teardown } from './helpers';

// Карточка-показатель открывает список, уже суженный до того, что она посчитала, —
// и число на карточке обязано равняться длине этого списка.
//
// Владелец: «нажимаю на „неоплаченные" — он должен мне открывать, а не искать, где это
// находится». Открыть мало: если «ждут одобрения: 1» приведёт к списку из четырёх заявок
// или, наоборот, к пустому, человек решит, что одно из двух врёт, — и будет прав.
//
// Поэтому здесь сверяются ДВА запроса на одних и тех же данных: тот, что считает число для
// панели, и тот, что отдаёт строки списку. Каждая проверка смотрит ещё и на то, что отбор
// вообще что-то отсекает (`total` без отбора СТРОГО больше) — иначе «равно» выполнялось бы
// само собой, и проверка молча мерила бы ноль против нуля.
//
// Без серверного отбора ни одна из этих проверок не проходит: до 11.11.2026 списки
// отдавали всё и сужались уже на странице, то есть в пределах показанных 20 строк.
describe('карточка и список считают одно и то же', () => {
  let app: INestApplication;
  let db: Client;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ['Authorization', `Bearer ${t}`] as [string, string];

  let buyer: string, approver: string, supplier: string, supplierOrg: string;
  let openPoId: string;

  const newRequest = async (title: string, priceMinor = 100_000) =>
    (await http().post('/requests').set(...bearer(buyer))
      .send({ title: `${title} ${tag}`, items: [{ name: 'Widget', qty: 10, estUnitPriceMinor: priceMinor }] })
      .expect(201)).body;

  const approved = async (title: string, priceMinor?: number) => {
    const r = await newRequest(title, priceMinor);
    await http().post(`/requests/${r.id}/submit`).set(...bearer(buyer)).expect(201);
    await http().post(`/requests/${r.id}/approve`).set(...bearer(approver)).expect(201);
    return r;
  };

  // Прямой заказ из одобренной заявки; полная приёмка переводит его в ACCEPTED (0012),
  // то есть делает «закрытым» в смысле карточки «Незакрытые заказы».
  const directOrder = async (title: string, receive: boolean) => {
    const req = await approved(title);
    const po = (await http().post(`/orders/direct/from-request/${req.id}`).set(...bearer(buyer))
      .send({ supplierOrgId: supplierOrg }).expect(201)).body;
    await http().post(`/orders/${po.id}/status`).set(...bearer(buyer)).send({ status: 'ISSUED' }).expect(201);
    if (!receive) return po;
    for (const s of ['CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED']) {
      await http().post(`/orders/${po.id}/status`).set(...bearer(supplier)).send({ status: s }).expect(201);
    }
    await http().post(`/orders/${po.id}/receipts`).set(...bearer(buyer))
      .send({ items: [{ poItemId: po.items[0].id, qty: 10 }] }).expect(201);
    return po;
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    // Владельческое подключение: ниже им сдвигается срок закупки, чтобы она закрылась, —
    // под `app_user` этот UPDATE отобрало бы RLS (0 строк), и проверка молча мерила бы
    // прежнее состояние.
    db = new Client({ connectionString: process.env.DATABASE_OWNER_URL ?? process.env.DATABASE_URL });
    await db.connect();
    const reg = async (path: string, name: string, email: string) => {
      const r = await http().post(path).send({ legalName: name, email, password: 'password123', fullName: name }).expect(201);
      return { token: r.body.accessToken as string, org: r.body.org.id as string };
    };
    ({ token: buyer } = await reg('/auth/register/buyer', `Card Buyer ${tag}`, `cb-${tag}@t.test`));
    approver = await addApprover(app, buyer, tag);
    ({ token: supplier, org: supplierOrg } = await reg('/auth/register/supplier', `Card Sup ${tag}`, `cs-${tag}@t.test`));
    await http().post(`/suppliers/${supplierOrg}/invite`).set(...bearer(buyer)).expect(201);
    const relId = (await http().get('/suppliers').set(...bearer(buyer)).expect(200))
      .body.find((r: any) => r.supplier_org_id === supplierOrg).id;
    await http().post(`/suppliers/relationships/${relId}/status`).set(...bearer(buyer))
      .send({ status: 'APPROVED' }).expect(201);

    // Прямая закупка на любую сумму — так заказы появляются без тендера.
    await http().put('/requests/method-policies').set(...bearer(buyer))
      .send({ policies: [{ category: '*', minAmountMinor: 0, maxAmountMinor: null, method: 'DIRECT' }] }).expect(200);

    await newRequest('Чернового');                       // DRAFT — в «ждут одобрения» не входит
    const pending = await newRequest('Ждущего');
    await http().post(`/requests/${pending.id}/submit`).set(...bearer(buyer)).expect(201);  // SUBMITTED

    const paidPo = await directOrder('Оплаченного', true);   // ACCEPTED
    const duePo = await directOrder('Неоплаченного', true);  // ACCEPTED
    openPoId = (await directOrder('Незакрытого', false)).id; // ISSUED

    const payable = (await http().post(`/invoices/from-po/${paidPo.id}`).set(...bearer(supplier))
      .send({ items: [{ poItemId: paidPo.items[0].id, qty: 10, unitPriceMinor: 100_000 }] }).expect(201)).body;
    await http().post(`/invoices/${payable.id}/approve`).set(...bearer(buyer)).expect(201);
    await http().post(`/invoices/${payable.id}/pay`).set(...bearer(buyer)).expect(201);     // PAID
    await http().post(`/invoices/from-po/${duePo.id}`).set(...bearer(supplier))
      .send({ items: [{ poItemId: duePo.items[0].id, qty: 10, unitPriceMinor: 100_000 }] }).expect(201); // не оплачен

    // Тендеры: один объявлен, один остался черновиком.
    await http().put('/requests/method-policies').set(...bearer(buyer))
      .send({ policies: [{ category: '*', minAmountMinor: 0, maxAmountMinor: null, method: 'RFQ' }] }).expect(200);
    const closeAt = new Date(Date.now() + 3600_000).toISOString();
    const openEvent = (await http().post(`/events/from-request/${(await approved('Объявленного')).id}`)
      .set(...bearer(buyer)).send({ closeAt, visibility: 'INVITED' }).expect(201)).body;
    await http().post(`/events/${openEvent.id}/invite`).set(...bearer(buyer)).send({ supplierOrgId: supplierOrg }).expect(201);
    await http().post(`/events/${openEvent.id}/publish`).set(...bearer(buyer)).expect(201);  // OPEN
    await http().post(`/events/from-request/${(await approved('Черновой закупки')).id}`)
      .set(...bearer(buyer)).send({ closeAt, visibility: 'INVITED' }).expect(201);           // DRAFT

    // И ещё одна закупка, которую поставщик ВИДИТ, но которая уже не объявлена: иначе
    // проверка витрины сравнивала бы «один тендер» с «одним тендером» и прошла бы со
    // сломанным отбором — у поставщика черновик невидим под RLS, так что отсекать было бы
    // нечего (замечание из разбора PR #190).
    const closing = (await http().post(`/events/from-request/${(await approved('Закрытого')).id}`)
      .set(...bearer(buyer)).send({ closeAt, visibility: 'INVITED' }).expect(201)).body;
    await http().post(`/events/${closing.id}/invite`).set(...bearer(buyer)).send({ supplierOrgId: supplierOrg }).expect(201);
    await http().post(`/events/${closing.id}/publish`).set(...bearer(buyer)).expect(201);
    await db.query(`UPDATE sourcing_events SET close_at = now() - interval '1 second' WHERE id = $1`, [closing.id]);
    await db.query(`SELECT * FROM close_due_events()`);                                      // CLOSED
  }, 120_000);

  afterAll(async () => {
    await teardown(db, app, () => db.query(`DELETE FROM organizations WHERE legal_name LIKE $1`, [`Card %${tag}%`]));
  });

  const buyerKpi = async () => (await http().get('/dashboard/buyer').set(...bearer(buyer)).expect(200)).body;
  const list = async (path: string, token: string, query: Record<string, string> = {}) =>
    (await http().get(path).query(query).set(...bearer(token)).expect(200)).body;

  it('«Ждут одобрения» открывают ровно ждущие одобрения заявки', async () => {
    const kpi = await buyerKpi();
    const filtered = await list('/requests', buyer, { status: 'pending' });
    const all = await list('/requests', buyer);
    expect(filtered.total).toBe(kpi.pendingApprovals);
    expect(all.total).toBeGreaterThan(filtered.total);
    for (const r of filtered.items) expect(r.status).toBe('SUBMITTED');
  });

  it('«Тендеров в работе» открывают ровно тендеры в работе', async () => {
    const kpi = await buyerKpi();
    const filtered = await list('/events', buyer, { status: 'active' });
    const all = await list('/events', buyer);
    expect(filtered.total).toBe(kpi.activeEvents);
    expect(all.total).toBeGreaterThan(filtered.total);
    for (const e of filtered.items) expect(['OPEN', 'CLOSED', 'OPENING', 'EVALUATION']).toContain(e.status);
  });

  it('«Незакрытые заказы» открывают ровно незакрытые заказы', async () => {
    const kpi = await buyerKpi();
    const filtered = await list('/orders', buyer, { status: 'open' });
    const all = await list('/orders', buyer);
    expect(filtered.total).toBe(kpi.openPos);
    expect(all.total).toBeGreaterThan(filtered.total);
    expect(filtered.items.map((p: any) => p.id)).toContain(openPoId);
    for (const p of filtered.items) expect(['ACCEPTED', 'REJECTED', 'CANCELLED']).not.toContain(p.status);
  });

  // Расход на /buyer/analytics — это принятые заказы ЗА ОКНО МЕСЯЦЕВ, и ссылка карточки
  // несёт то же окно. Окно должно отмеряться тем же столбцом (`created_at`), что и в
  // расчёте расхода, иначе список ответит не на тот вопрос.
  it('«Расход» открывает принятые заказы, и окно месяцев в нём работает', async () => {
    const month = new Date().toISOString().slice(0, 7);
    const thisMonth = await list('/orders', buyer, { status: 'accepted', from: month, to: month });
    expect(thisMonth.total).toBe(2);
    for (const p of thisMonth.items) expect(p.status).toBe('ACCEPTED');
    const lastYear = `${Number(month.slice(0, 4)) - 1}${month.slice(4)}`;
    const old = await list('/orders', buyer, { status: 'accepted', from: lastYear, to: lastYear });
    expect(old.total).toBe(0);
  });

  it('«Не оплачено» открывает ровно неоплаченные счета — и у покупателя, и у поставщика', async () => {
    const all = await list('/invoices', buyer);
    const outstanding = await list('/invoices', buyer, { status: 'outstanding' });
    expect(all.length).toBe(2);
    expect(outstanding.length).toBe(1);
    for (const i of outstanding) expect(['PAID', 'REJECTED']).not.toContain(i.status);
    const paid = await list('/invoices', buyer, { status: 'paid' });
    expect(paid.map((i: any) => i.status)).toEqual(['PAID']);

    const supKpi = (await http().get('/dashboard/supplier').set(...bearer(supplier)).expect(200)).body;
    const supOutstanding = await list('/invoices', supplier, { status: 'outstanding' });
    expect(supOutstanding.length).toBe(supKpi.invoicesPending);
    const supOrders = await list('/orders', supplier, { status: 'open' });
    expect(supOrders.total).toBe(supKpi.ordersInProgress);
  });

  it('«Витрина» открывает поставщику ровно объявленные тендеры', async () => {
    const supKpi = (await http().get('/dashboard/supplier').set(...bearer(supplier)).expect(200)).body;
    const open = await list('/events', supplier, { status: 'open' });
    const all = await list('/events', supplier);
    expect(open.total).toBe(supKpi.openTenders);
    // Отбор действительно отсекает: поставщик видит и закрытую закупку, в которую его звали.
    expect(all.total).toBeGreaterThan(open.total);
    for (const e of open.items) expect(e.status).toBe('OPEN');
  });

  // Валюта — часть отбора карточек на /buyer/analytics: все четыре числа там считаются по
  // выбранной валюте. Значит, она обязана быть и в отборе списка, который карточка
  // открывает. Без неё карточка на USD говорит «0,00» и открывает манатный заказ.
  it('карточки аналитики и их списки согласны ещё и в валюте', async () => {
    const month = new Date().toISOString().slice(0, 7);
    const win = { from: month, to: month };
    const analytics = async (currency: string) =>
      (await http().get('/dashboard/spend-analytics').query({ ...win, currency })
        .set(...bearer(buyer)).expect(200)).body;

    const azn = await analytics('AZN');
    const usd = await analytics('USD');
    // Данные этого набора манатные, поэтому в USD карточки пусты — и список по ссылке
    // такой карточки обязан быть пуст тоже.
    expect(usd.invoices.paidCount).toBe(0);
    expect(usd.invoices.outstandingCount).toBe(0);
    expect(azn.invoices.paidCount).toBe(1);
    expect(azn.invoices.outstandingCount).toBe(1);

    const ordersUsd = await list('/orders', buyer, { status: 'accepted', ...win, currency: 'USD' });
    expect(ordersUsd.total).toBe(0);
    const ordersAzn = await list('/orders', buyer, { status: 'accepted', ...win, currency: 'AZN' });
    expect(ordersAzn.total).toBe(2);

    expect((await list('/invoices', buyer, { status: 'paid', ...win, currency: 'USD' })).length).toBe(0);
    expect((await list('/invoices', buyer, { status: 'outstanding', ...win, currency: 'USD' })).length).toBe(0);
    expect((await list('/invoices', buyer, { status: 'paid', ...win, currency: 'AZN' })).length)
      .toBe(azn.invoices.paidCount);
    expect((await list('/invoices', buyer, { status: 'outstanding', ...win, currency: 'AZN' })).length)
      .toBe(azn.invoices.outstandingCount);
  });

  // Опечатка в адресе — это 400, а не молча снятый отбор: «неоплаченные», понятые как «все»,
  // показали бы оплаченные счета под заголовком «не оплачено».
  it('неизвестное имя отбора отвергается, а не понимается как «без отбора»', async () => {
    for (const path of ['/requests', '/events', '/orders', '/invoices']) {
      await http().get(path).query({ status: 'oustanding' }).set(...bearer(buyer)).expect(400);
      // Имя со ПРОТОТИПА объекта — тоже неизвестное имя. `named[raw]` находило `toString`
      // и падало на разборе в массив: 500 на пользовательский ввод там, где обещано 400
      // (блокирующее замечание из разбора PR #190).
      for (const inherited of ['toString', 'constructor', 'hasOwnProperty']) {
        await http().get(path).query({ status: inherited }).set(...bearer(buyer)).expect(400);
      }
    }
    await http().get('/orders').query({ from: '2026-13' }).set(...bearer(buyer)).expect(400);
    await http().get('/orders').query({ currency: 'манат' }).set(...bearer(buyer)).expect(400);
    await http().get('/invoices').query({ currency: 'azn' }).set(...bearer(buyer)).expect(400);
  });
});
