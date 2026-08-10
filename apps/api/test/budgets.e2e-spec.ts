import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { addApprover } from './helpers';

// Budgets & commitment control: APPROVED requests commit against a matching budget
// (category + calendar year + currency). Utilization is derived; over-budget approvals
// warn but never block; budgets are private to the buyer (RLS).
describe('budgets & commitment control (API e2e)', () => {
  let app: INestApplication;
  let db: Client;
  const tag = randomUUID().slice(0, 8);
  const YEAR = new Date().getFullYear();
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ['Authorization', `Bearer ${t}`] as [string, string];
  let buyerA: string, buyerB: string, approverA: string;

  const reg = async (name: string, email: string) => {
    const r = await http().post('/auth/register/buyer').send({ legalName: name, email, password: 'password123', fullName: name }).expect(201);
    return r.body.accessToken as string;
  };

  // create → submit → approve a request in a category with a known line total.
  const approveRequest = async (token: string, category: string, unitPriceMinor: number) => {
    const req = await http().post('/requests').set(...bearer(token))
      .send({ title: `Req ${tag} ${randomUUID().slice(0, 4)}`, category, items: [{ name: 'x', qty: 1, estUnitPriceMinor: unitPriceMinor }] })
      .expect(201);
    await http().post(`/requests/${req.body.id}/submit`).set(...bearer(token)).expect(201);
    const done = await http().post(`/requests/${req.body.id}/approve`).set(...bearer(approverA)).expect(201);
    return done.body;
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    // owner connection: the cross-year test re-dates a request, which RLS would silently
    // drop on the app_user role (no request context → default deny).
    db = new Client({ connectionString: process.env.DATABASE_OWNER_URL ?? process.env.DATABASE_URL });
    await db.connect();
    buyerA = await reg(`Bgt A ${tag}`, `ba-${tag}@t.test`);
    approverA = await addApprover(app, buyerA, tag);
    buyerB = await reg(`Bgt B ${tag}`, `bb-${tag}@t.test`);
    // a wildcard method policy so approvals resolve a procurement method
    for (const tok of [buyerA, buyerB]) {
      await http().put('/requests/method-policies').set(...bearer(tok))
        .send({ policies: [{ category: '*', minAmountMinor: 0, maxAmountMinor: null, method: 'DIRECT' }] }).expect(200);
    }
  });

  afterAll(async () => {
    await db.query(`DELETE FROM organizations WHERE legal_name LIKE $1`, [`Bgt %${tag}%`]);
    await db.end();
    await app.close();
  });

  it('with no matching budget, approval succeeds and returns empty budgetWarnings', async () => {
    const r = await approveRequest(buyerA, 'MISC', 50_000);
    expect(r.status).toBe('APPROVED');
    expect(r.budgetWarnings).toEqual([]);
  });

  it('an approved request commits against its category budget', async () => {
    await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `IT ${tag}`, category: 'IT', periodYear: YEAR, amountMinor: 500_000 }).expect(201);
    await approveRequest(buyerA, 'IT', 200_000);
    const list = await http().get('/budgets').set(...bearer(buyerA)).expect(200);
    const b = list.body.find((x: any) => x.name === `IT ${tag}`);
    expect(b.committedMinor).toBeGreaterThanOrEqual(200_000);
    expect(b.remainingMinor).toBe(b.amountMinor - b.committedMinor);
  });

  it('an over-budget approval warns but the request is still APPROVED', async () => {
    await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Tiny ${tag}`, category: 'TINY', periodYear: YEAR, amountMinor: 50_000 }).expect(201);
    const r = await approveRequest(buyerA, 'TINY', 120_000);
    expect(r.status).toBe('APPROVED');
    expect(r.budgetWarnings.length).toBeGreaterThan(0);
    expect(r.budgetWarnings[0].overByMinor).toBeGreaterThan(0);
    expect(r.budgetWarnings[0].category).toBe('TINY');
  });

  it('a category budget ignores requests in other categories', async () => {
    const r = await approveRequest(buyerA, 'HR', 999_999);
    expect(r.budgetWarnings).toEqual([]);
  });

  it('a different currency does not match (no FX)', async () => {
    await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Usd ${tag}`, category: 'IT', periodYear: YEAR, amountMinor: 1, currency: 'USD' }).expect(201);
    // the IT request above is in AZN, so the USD budget stays at zero committed
    const list = await http().get('/budgets').set(...bearer(buyerA)).expect(200);
    const usd = list.body.find((x: any) => x.name === `Usd ${tag}`);
    expect(usd.committedMinor).toBe(0);
  });

  it("buyer B cannot see buyer A's budgets (RLS isolation)", async () => {
    const list = await http().get('/budgets').set(...bearer(buyerB)).expect(200);
    expect(list.body.find((x: any) => x.name === `IT ${tag}`)).toBeUndefined();
    expect(list.body.length).toBe(0);
  });

  it('rejects a budget with a negative amount (DTO validation)', async () => {
    await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Bad ${tag}`, periodYear: YEAR, amountMinor: -5 }).expect(400);
  });

  it('a duplicate (name, period) budget is a clean 409, not a 500', async () => {
    const body = { name: `Dup ${tag}`, category: 'IT', periodYear: YEAR, amountMinor: 100_000 };
    await http().post('/budgets').set(...bearer(buyerA)).send(body).expect(201);
    await http().post('/budgets').set(...bearer(buyerA)).send(body).expect(409);
  });

  // ---------- periods: year / quarter / month ----------

  it('the same name in different quarters is two budgets, not a collision', async () => {
    const q1 = await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Q ${tag}`, category: 'QTR', periodType: 'QUARTER', periodYear: YEAR, periodQuarter: 1, amountMinor: 100_000 }).expect(201);
    const q2 = await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Q ${tag}`, category: 'QTR', periodType: 'QUARTER', periodYear: YEAR, periodQuarter: 2, amountMinor: 100_000 }).expect(201);
    expect(q1.body.periodLabel).toBe(`${YEAR} Q1`);
    expect(q1.body.periodStart).toBe(`${YEAR}-01-01`);
    expect(q1.body.periodEnd).toBe(`${YEAR}-03-31`);
    expect(q2.body.periodStart).toBe(`${YEAR}-04-01`);
    expect(q2.body.periodEnd).toBe(`${YEAR}-06-30`);
  });

  it('a quarterly budget only counts approvals inside its own quarter', async () => {
    // approve now, then check the quarter that contains today vs. a different one
    const nowQ = Math.floor(new Date().getUTCMonth() / 3) + 1;
    const otherQ = nowQ === 4 ? 1 : nowQ + 1;
    await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Qnow ${tag}`, category: 'QNOW', periodType: 'QUARTER', periodYear: YEAR, periodQuarter: nowQ, amountMinor: 900_000 }).expect(201);
    await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Qother ${tag}`, category: 'QNOW', periodType: 'QUARTER', periodYear: YEAR, periodQuarter: otherQ, amountMinor: 900_000 }).expect(201);
    await approveRequest(buyerA, 'QNOW', 300_000);
    const list = (await http().get('/budgets').set(...bearer(buyerA)).expect(200)).body;
    expect(list.find((b: any) => b.name === `Qnow ${tag}`).committedMinor).toBe(300_000);
    expect(list.find((b: any) => b.name === `Qother ${tag}`).committedMinor).toBe(0);
  });

  it('a monthly budget counts only its own month', async () => {
    const month = new Date().getUTCMonth() + 1;
    const other = month === 12 ? 1 : month + 1;
    await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Mnow ${tag}`, category: 'MNTH', periodType: 'MONTH', periodYear: YEAR, periodMonth: month, amountMinor: 900_000 }).expect(201);
    await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Moth ${tag}`, category: 'MNTH', periodType: 'MONTH', periodYear: YEAR, periodMonth: other, amountMinor: 900_000 }).expect(201);
    await approveRequest(buyerA, 'MNTH', 120_000);
    const list = (await http().get('/budgets').set(...bearer(buyerA)).expect(200)).body;
    expect(list.find((b: any) => b.name === `Mnow ${tag}`).committedMinor).toBe(120_000);
    expect(list.find((b: any) => b.name === `Moth ${tag}`).committedMinor).toBe(0);
  });

  it('QUARTER without a quarter number is a 400, not a silent annual budget', async () => {
    await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `NoQ ${tag}`, periodType: 'QUARTER', periodYear: YEAR, amountMinor: 1000 }).expect(400);
  });

  // The regression this whole change exists for: commitment is dated by APPROVAL, so a
  // request raised on 28 Dec and approved on 5 Jan belongs to January — not to last year.
  it('a December request approved in January commits to January, not to last year', async () => {
    const dec = `${YEAR - 1}-12-28T10:00:00Z`;
    const jan = `${YEAR}-01-05T10:00:00Z`;
    await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `DecY ${tag}`, category: 'XOVER', periodType: 'MONTH', periodYear: YEAR - 1, periodMonth: 12, amountMinor: 900_000 }).expect(201);
    await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `JanY ${tag}`, category: 'XOVER', periodType: 'MONTH', periodYear: YEAR, periodMonth: 1, amountMinor: 900_000 }).expect(201);

    const done = await approveRequest(buyerA, 'XOVER', 70_000);
    // Re-date the request the way the calendar would have: created in December, approved
    // in January. (The API always stamps now(); only history can straddle a year.)
    await db.query(`UPDATE procurement_requests SET created_at=$2, approved_at=$3 WHERE id=$1`, [done.id, dec, jan]);

    const list = (await http().get('/budgets').set(...bearer(buyerA)).expect(200)).body;
    expect(list.find((b: any) => b.name === `JanY ${tag}`).committedMinor).toBe(70_000);
    expect(list.find((b: any) => b.name === `DecY ${tag}`).committedMinor).toBe(0);
  });

  it('filters the list by period type and year', async () => {
    const quarters = (await http().get(`/budgets?periodType=QUARTER&year=${YEAR}`).set(...bearer(buyerA)).expect(200)).body;
    expect(quarters.length).toBeGreaterThan(0);
    expect(quarters.every((b: any) => b.periodType === 'QUARTER' && b.periodYear === YEAR)).toBe(true);
    const lastYear = (await http().get(`/budgets?year=${YEAR - 1}`).set(...bearer(buyerA)).expect(200)).body;
    expect(lastYear.every((b: any) => b.periodYear === YEAR - 1)).toBe(true);
  });
});
