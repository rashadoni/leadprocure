import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';

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
  let buyerA: string, buyerB: string;

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
    const done = await http().post(`/requests/${req.body.id}/approve`).set(...bearer(token)).expect(201);
    return done.body;
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    buyerA = await reg(`Bgt A ${tag}`, `ba-${tag}@t.test`);
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
});
