import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { addApprover } from './helpers';

describe('runtime budget and procurement audit integration', () => {
  let app: INestApplication, owner: Client;
  let buyer: string, approver: string, finance: string, plain: string, org: string;
  let depA: string, depB: string;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ['Authorization', `Bearer ${token}`] as [string, string];
  const year = new Date().getUTCFullYear();

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication(); app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
    owner = new Client({ connectionString: process.env.DATABASE_OWNER_URL }); await owner.connect();
    const reg = await http().post('/auth/register/buyer').send({ legalName: `Integration ${tag}`, fullName: 'Admin', email: `int-${tag}@t.test`, password: 'password123' }).expect(201);
    buyer = reg.body.accessToken; org = reg.body.org.id;
    approver = await addApprover(app, buyer, `integration-${tag}`);
    const makeUser = async (name: string, role: string) => {
      const email = `${name}-${tag}@t.test`;
      await http().post('/settings/users').set(...auth(buyer)).send({ email, role, fullName: name, password: 'password123' }).expect(201);
      return (await http().post('/auth/login').send({ email, password: 'password123' }).expect(201)).body.accessToken;
    };
    finance = await makeUser('finance', 'BUYER_FINANCE'); plain = await makeUser('plain', 'BUYER_USER');
    const users = (await http().get('/settings/users').set(...auth(buyer)).expect(200)).body;
    const userId = users.find((u: any) => u.email === `plain-${tag}@t.test`).id;
    depA = (await http().post('/departments').set(...auth(buyer)).send({ code: `A-${tag}`, ownerUserId: userId }).expect(201)).body.id;
    depB = (await http().post('/departments').set(...auth(buyer)).send({ code: `B-${tag}` }).expect(201)).body.id;
    await http().put('/requests/method-policies').set(...auth(buyer)).send({ policies: [{ category: '*', minAmountMinor: 0, maxAmountMinor: null, method: 'DIRECT' }] }).expect(200);
  });
  afterAll(async () => {
    if (owner) { await owner.query('ROLLBACK'); await owner.query('DELETE FROM organizations WHERE id=$1', [org]); await owner.end(); }
    if (app) await app.close();
  });
  const draftBudget = async (name: string, category: string, amountMinor: number, departmentId?: string) =>
    (await http().post('/budgets').set(...auth(buyer)).send({ name: `${name}-${tag}`, category, amountMinor, periodYear: year, ...(departmentId ? { departmentId } : {}) }).expect(201)).body.id;
  const requestFor = async (category: string, departmentId?: string, estUnitPriceMinor = 800) => {
    const r = await http().post('/requests').set(...auth(buyer)).send({ title: `Request ${tag}`, category, ...(departmentId ? { departmentId } : {}), items: [{ name: 'Item', qty: 1, estUnitPriceMinor }] }).expect(201);
    await http().post(`/requests/${r.body.id}/submit`).set(...auth(buyer)).expect(201); return r.body.id;
  };

  it('enforces department scope on direct budget reads and state changes', async () => {
    const own = await draftBudget('Own', 'OWN', 10000, depA);
    const other = await draftBudget('Other', 'OTHER', 10000, depB);
    for (const suffix of ['documents', 'phasing', 'revisions']) {
      await http().get(`/budgets/${other}/${suffix}`).set(...auth(plain)).expect(403);
      await http().get(`/budgets/${own}/${suffix}`).set(...auth(plain)).expect(200);
    }
    const hiddenRequest = await requestFor('OTHER', depB);
    // Activate the other department plan so the impact lookup would otherwise expose it.
    await http().post(`/budgets/${other}/submit`).set(...auth(buyer)).expect(201);
    await http().post(`/budgets/${other}/approve`).set(...auth(approver)).expect(201);
    await http().get(`/budgets/impact/${hiddenRequest}`).set(...auth(plain)).expect(403);
    const otherDraft = await draftBudget('Other draft', 'OTHER_DRAFT', 10000, depB);
    await http().post(`/budgets/${otherDraft}/submit`).set(...auth(plain)).expect(403);
    await http().delete(`/budgets/${otherDraft}`).set(...auth(plain)).expect(403);
    await http().post(`/budgets/${otherDraft}/submit`).set(...auth(buyer)).expect(201);
    await http().post(`/budgets/${otherDraft}/recall`).set(...auth(plain)).expect(403);
    await http().post(`/budgets/${own}/submit`).set(...auth(plain)).expect(201);
    await http().post(`/budgets/${own}/recall`).set(...auth(plain)).expect(201);
  });

  it('finance can complete its assigned chain step, but cannot approve ordinary procurement', async () => {
    await http().put('/requests/approval-policies').set(...auth(buyer)).send({ policies: [{ minAmountMinor: 0, maxAmountMinor: null, steps: [{ order: 1, role: 'BUYER_APPROVER' }, { order: 2, role: 'BUYER_FINANCE' }] }] }).expect(200);
    const id = await requestFor('CHAIN');
    await http().get(`/requests/${id}`).set(...auth(finance)).expect(200);
    await http().post(`/requests/${id}/approve`).set(...auth(finance)).expect(403);
    const first = await http().post(`/requests/${id}/approve`).set(...auth(approver)).expect(201);
    expect(first.body.status).toBe('SUBMITTED');
    const last = await http().post(`/requests/${id}/approve`).set(...auth(finance)).expect(201);
    expect(last.body.status).toBe('APPROVED');
    await http().put('/requests/approval-policies').set(...auth(buyer)).send({ policies: [] }).expect(200);
    const ordinary = await requestFor('PLAIN');
    await http().post(`/requests/${ordinary}/approve`).set(...auth(finance)).expect(403);
    await http().post('/requests').set(...auth(finance)).send({ title: 'Finance cannot buy' }).expect(403);
  });

  it('a draft cannot mask an active limit and competing approvals cannot overspend it', async () => {
    const live = await draftBudget('Live', 'LIMIT', 1000);
    await http().post(`/budgets/${live}/submit`).set(...auth(buyer)).expect(201);
    await http().post(`/budgets/${live}/approve`).set(...auth(approver)).expect(201);
    await draftBudget('Shadow', 'LIMIT', 1000000, depA);
    await http().put('/budgets/policy').set(...auth(finance)).send({ warnPct: 80, blockPct: 100, allowOverride: false }).expect(200);
    const ids = [await requestFor('LIMIT', depA), await requestFor('LIMIT', depA)];
    const impact = await http().get(`/budgets/impact/${ids[0]}`).set(...auth(buyer)).expect(200);
    expect(impact.body.budgetId).toBe(live);
    await owner.query('BEGIN');
    await owner.query('SELECT pg_advisory_xact_lock(hashtextextended($1,85))', [org]);
    const pending = ids.map(id => http().post(`/requests/${id}/approve`).set(...auth(approver)).then(r => r));
    let blocked = 0;
    let settled: PromiseSettledResult<any>[] = [];
    try {
      for (let i = 0; i < 150; i++) {
        await owner.query('SELECT pg_stat_clear_snapshot()');
        const r = await owner.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE '%hashtextextended($1,85)%'");
        blocked = r.rows[0].n; if (blocked >= 2) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } finally { await owner.query('ROLLBACK'); settled = await Promise.allSettled(pending); }
    const outcomes = settled.map(r => { if (r.status === 'rejected') throw r.reason; return r.value; });
    expect(blocked).toBeGreaterThanOrEqual(2);
    expect(outcomes.map(r => r.status).sort()).toEqual([201, 403]);
    const b = (await http().get('/budgets').set(...auth(buyer)).expect(200)).body.find((x: any) => x.id === live);
    expect(b.usedMinor).toBe(800);
  });

  it('blocks positive spend against zero and a one-minor-unit breach despite display rounding', async () => {
    for (const [category, limit, requestAmount] of [['ZERO', 0, 800], ['MINOR', 100000, 100001]] as const) {
      const id = await draftBudget(category, category, limit);
      await http().post(`/budgets/${id}/submit`).set(...auth(buyer)).expect(201);
      await http().post(`/budgets/${id}/approve`).set(...auth(approver)).expect(201);
      const req = await requestFor(category, undefined, requestAmount);
      const impact = await http().get(`/budgets/impact/${req}`).set(...auth(buyer)).expect(200);
      expect(impact.body.wouldBlock).toBe(true);
      await http().post(`/requests/${req}/approve`).set(...auth(approver)).expect(403);
    }
  });

  it('preserves financial department references and rejects absent membership updates', async () => {
    await http().delete(`/departments/${depB}`).set(...auth(buyer)).expect(409);
    await http().post(`/settings/users/${randomUUID()}/department`).set(...auth(buyer)).send({ departmentId: depA }).expect(400);
  });
});
