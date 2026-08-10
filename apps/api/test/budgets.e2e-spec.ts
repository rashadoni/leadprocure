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
  let orderedRequestId: string; // the request that gets a real PO, reused by the cancel test

  const reg = async (name: string, email: string) => {
    const r = await http().post('/auth/register/buyer').send({ legalName: name, email, password: 'password123', fullName: name }).expect(201);
    return r.body.accessToken as string;
  };

  // create → submit → approve a request in a category with a known line total.
  const approveRequest = async (token: string, category: string, unitPriceMinor: number, departmentId?: string) => {
    const req = await http().post('/requests').set(...bearer(token))
      .send({
        title: `Req ${tag} ${randomUUID().slice(0, 4)}`, category,
        ...(departmentId ? { departmentId } : {}),
        items: [{ name: 'x', qty: 1, estUnitPriceMinor: unitPriceMinor }],
      })
      .expect(201);
    await http().post(`/requests/${req.body.id}/submit`).set(...bearer(token)).expect(201);
    const done = await http().post(`/requests/${req.body.id}/approve`).set(...bearer(approverA)).expect(201);
    return done.body;
  };

  // A catalog call-off: a PO with no request behind it. Lazily builds one ACTIVE catalog
  // (supplier + one item) and re-orders from it.
  let catalogId: string, catalogItemId: string;
  const orderFromCatalog = async (departmentId: string | undefined, qty: number, unitPriceMinor: number) => {
    if (!catalogId) {
      const sup = (await http().post('/auth/register/supplier')
        .send({ legalName: `Bgt Cat Sup ${tag}`, email: `bcs-${tag}@t.test`, password: 'password123', fullName: 'Cat Sup' })
        .expect(201)).body;
      const cat = await http().post('/catalogs').set(...bearer(buyerA))
        .send({ supplierOrgId: sup.org.id, title: `Cat ${tag}` }).expect(201);
      catalogId = cat.body.id;
      // addItem returns the whole catalog, so the item id comes off its items array
      const withItem = await http().post(`/catalogs/${catalogId}/items`).set(...bearer(buyerA))
        .send({ name: 'Paper', unitPriceMinor: 1 }).expect(201);
      catalogItemId = withItem.body.items[0].id;
      await http().post(`/catalogs/${catalogId}/activate`).set(...bearer(buyerA)).expect(201);
    }
    const res = await http().post(`/catalogs/${catalogId}/order`).set(...bearer(buyerA))
      .send({ items: [{ catalogItemId, qty }], ...(departmentId ? { departmentId } : {}) })
      .expect(201);
    // the catalog item is priced at 1 minor unit, so the order total is set explicitly here
    await db.query(`UPDATE purchase_orders SET total_minor = $2 WHERE id = $1`, [res.body.id, qty * unitPriceMinor]);
    return res.body.id as string;
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

  it('refuses a non-AZN budget outright — budgets are AZN-only', async () => {
    await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Usd ${tag}`, category: 'IT', periodYear: YEAR, amountMinor: 1, currency: 'USD' }).expect(400);
    // an explicit AZN is still accepted, so older clients keep working
    await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Azn ${tag}`, category: `AZNCAT-${tag}`, periodYear: YEAR, amountMinor: 1000, currency: 'AZN' })
      .expect(201);
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
    // its own category: category 'IT' is already covered by the budget above, and a second
    // budget on a covered scope is now refused by the overlap rule (different failure).
    const body = { name: `Dup ${tag}`, category: `DUPCAT-${tag}`, periodYear: YEAR, amountMinor: 100_000 };
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

  // ---------- per-department budgets: exactly one budget per request ----------

  it('an org-wide and a department budget on the same spend do NOT double-count', async () => {
    const dep = (await http().post('/departments').set(...bearer(buyerA)).send({ code: `ENG-${tag}` }).expect(201)).body;
    // org-wide ceiling for the category…
    await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `All ${tag}`, category: 'DUP', periodYear: YEAR, amountMinor: 1_000_000 }).expect(201);
    // …plus a tighter one for the department: the most specific wins, the other stays at 0.
    await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Eng ${tag}`, category: 'DUP', departmentId: dep.id, periodYear: YEAR, amountMinor: 400_000 }).expect(201);

    await approveRequest(buyerA, 'DUP', 150_000, dep.id);
    const list = (await http().get('/budgets').set(...bearer(buyerA)).expect(200)).body;
    expect(list.find((b: any) => b.name === `Eng ${tag}`).committedMinor).toBe(150_000);
    expect(list.find((b: any) => b.name === `All ${tag}`).committedMinor).toBe(0);
  });

  it('a request with no department falls through to the org-wide budget', async () => {
    await approveRequest(buyerA, 'DUP', 60_000);
    const list = (await http().get('/budgets').set(...bearer(buyerA)).expect(200)).body;
    expect(list.find((b: any) => b.name === `All ${tag}`).committedMinor).toBe(60_000);
    expect(list.find((b: any) => b.name === `Eng ${tag}`).committedMinor).toBe(150_000);
  });

  it('department + category beats department-only', async () => {
    const dep = (await http().post('/departments').set(...bearer(buyerA)).send({ code: `OPS-${tag}` }).expect(201)).body;
    await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Ops any ${tag}`, departmentId: dep.id, periodYear: YEAR, amountMinor: 800_000 }).expect(201);
    await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Ops fuel ${tag}`, category: 'FUEL', departmentId: dep.id, periodYear: YEAR, amountMinor: 200_000 }).expect(201);

    await approveRequest(buyerA, 'FUEL', 90_000, dep.id);
    const list = (await http().get('/budgets').set(...bearer(buyerA)).expect(200)).body;
    expect(list.find((b: any) => b.name === `Ops fuel ${tag}`).committedMinor).toBe(90_000);
    expect(list.find((b: any) => b.name === `Ops any ${tag}`).committedMinor).toBe(0);
  });

  it('a second budget on an already-covered scope is a 409, not silent ambiguity', async () => {
    await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `All twin ${tag}`, category: 'DUP', periodYear: YEAR, amountMinor: 5_000 }).expect(409);
  });

  it('lists and filters budgets by department', async () => {
    const deps = (await http().get('/departments').set(...bearer(buyerA))).body;
    const eng = deps.find((d: any) => d.code === `ENG-${tag}`);
    const only = (await http().get(`/budgets?departmentId=${eng.id}`).set(...bearer(buyerA)).expect(200)).body;
    expect(only.length).toBeGreaterThan(0);
    expect(only.every((b: any) => b.departmentId === eng.id)).toBe(true);
    expect(only[0].departmentCode).toBe(`ENG-${tag}`);
  });

  it('over-budget warning names the department that blew its budget', async () => {
    const dep = (await http().post('/departments').set(...bearer(buyerA)).send({ code: `MKT-${tag}` }).expect(201)).body;
    await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Mkt ${tag}`, category: 'ADS', departmentId: dep.id, periodYear: YEAR, amountMinor: 30_000 }).expect(201);
    const r = await approveRequest(buyerA, 'ADS', 100_000, dep.id);
    expect(r.status).toBe('APPROVED');
    expect(r.budgetWarnings).toHaveLength(1);
    expect(r.budgetWarnings[0].departmentCode).toBe(`MKT-${tag}`);
    expect(r.budgetWarnings[0].overByMinor).toBe(70_000);
  });

  it('approved spend that matches no budget shows up in the unbudgeted report', async () => {
    const r = await approveRequest(buyerA, `NOBUDGET-${tag}`, 45_000);
    const report = (await http().get('/budgets/unbudgeted').set(...bearer(buyerA)).expect(200)).body;
    const row = report.find((x: any) => x.requestId === r.id);
    expect(row).toBeTruthy();
    expect(row.amountMinor).toBe(45_000);
  });

  it('a BUYER_USER sees only their own department’s budgets', async () => {
    const deps = (await http().get('/departments').set(...bearer(buyerA))).body;
    const eng = deps.find((d: any) => d.code === `ENG-${tag}`);
    await http().post('/settings/users').set(...bearer(buyerA))
      .send({ email: `bu-${tag}@t.test`, fullName: 'Budget User', password: 'password123', role: 'BUYER_USER' }).expect(201);
    const userId = (await http().get('/settings/users').set(...bearer(buyerA))).body.find((u: any) => u.email === `bu-${tag}@t.test`).id;
    const userTok = (await http().post('/auth/login').send({ email: `bu-${tag}@t.test`, password: 'password123' }).expect(201)).body.accessToken;

    // no home department yet → nothing to see, not the whole org's plan
    expect((await http().get('/budgets').set(...bearer(userTok)).expect(200)).body).toHaveLength(0);

    await http().post(`/settings/users/${userId}/department`).set(...bearer(buyerA)).send({ departmentId: eng.id }).expect(201);
    const scoped = (await http().get('/budgets').set(...bearer(userTok)).expect(200)).body;
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((b: any) => b.departmentId === eng.id)).toBe(true);
    // and the unbudgeted report is not theirs to read
    await http().get('/budgets/unbudgeted').set(...bearer(userTok)).expect(403);
  });

  // ---------- plan / commitment / actual ----------

  it('a purchase order replaces its request’s estimate — the spend is never counted twice', async () => {
    // supplier the buyer may order from directly
    const supReg = (await http().post('/auth/register/supplier')
      .send({ legalName: `Bgt Sup ${tag}`, email: `bs-${tag}@t.test`, password: 'password123', fullName: 'Sup' })
      .expect(201)).body;
    const supOrgId = supReg.org.id as string;
    await http().post(`/suppliers/${supOrgId}/invite`).set(...bearer(buyerA)).expect(201);
    const rel = (await http().get('/suppliers').set(...bearer(buyerA)).expect(200)).body
      .find((r: any) => r.supplier_org_id === supOrgId);
    await http().post(`/suppliers/relationships/${rel.id}/status`).set(...bearer(buyerA))
      .send({ status: 'APPROVED' }).expect(201);

    await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Actual ${tag}`, category: 'ACT', periodYear: YEAR, amountMinor: 1_000_000 }).expect(201);
    const req = await approveRequest(buyerA, 'ACT', 100_000);
    orderedRequestId = req.id;

    let b = (await http().get('/budgets').set(...bearer(buyerA))).body.find((x: any) => x.name === `Actual ${tag}`);
    expect(b.committedMinor).toBe(100_000);
    expect(b.actualMinor).toBe(0);
    expect(b.usedMinor).toBe(100_000);

    // the order comes in at the estimate: commitment converts to actual, total unchanged
    const po = await http().post(`/orders/direct/from-request/${req.id}`).set(...bearer(buyerA))
      .send({ supplierOrgId: supOrgId }).expect(201);
    b = (await http().get('/budgets').set(...bearer(buyerA))).body.find((x: any) => x.name === `Actual ${tag}`);
    expect(b.committedMinor).toBe(0);
    expect(b.actualMinor).toBe(100_000);
    expect(b.usedMinor).toBe(100_000);

    // and when the order lands ABOVE the estimate, the budget follows the real money
    await db.query(`UPDATE purchase_orders SET total_minor = 130000 WHERE id = $1`, [po.body.id]);
    b = (await http().get('/budgets').set(...bearer(buyerA))).body.find((x: any) => x.name === `Actual ${tag}`);
    expect(b.actualMinor).toBe(130_000);
    expect(b.usedMinor).toBe(130_000);
    expect(b.remainingMinor).toBe(b.amountMinor - 130_000);
  });

  it('cancelling an abandoned approved request releases its commitment', async () => {
    await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Release ${tag}`, category: 'RELEASE', periodYear: YEAR, amountMinor: 500_000 }).expect(201);
    const req = await approveRequest(buyerA, 'RELEASE', 200_000);
    let b = (await http().get('/budgets').set(...bearer(buyerA))).body.find((x: any) => x.name === `Release ${tag}`);
    expect(b.usedMinor).toBe(200_000);

    await http().post(`/requests/${req.id}/cancel`).set(...bearer(buyerA))
      .send({ reason: 'no longer needed' }).expect(201);
    b = (await http().get('/budgets').set(...bearer(buyerA))).body.find((x: any) => x.name === `Release ${tag}`);
    expect(b.usedMinor).toBe(0);
    expect(b.remainingMinor).toBe(b.amountMinor);
  });

  it('a request with a live order cannot be cancelled behind the order’s back', async () => {
    await http().post(`/requests/${orderedRequestId}/cancel`).set(...bearer(buyerA))
      .send({ reason: 'trying to release money that is already spent' }).expect(400);
  });

  // ---------- thresholds: warn, block, override ----------

  it('exposes the budget impact of a request BEFORE it is approved', async () => {
    await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Impact ${tag}`, category: 'IMPACT', periodYear: YEAR, amountMinor: 100_000 }).expect(201);
    const req = await http().post('/requests').set(...bearer(buyerA))
      .send({ title: `Impact ${tag}`, category: 'IMPACT', items: [{ name: 'x', qty: 1, estUnitPriceMinor: 92_000 }] })
      .expect(201);
    await http().post(`/requests/${req.body.id}/submit`).set(...bearer(buyerA)).expect(201);

    const impact = (await http().get(`/budgets/impact/${req.body.id}`).set(...bearer(approverA)).expect(200)).body;
    expect(impact.budgetName).toBe(`Impact ${tag}`);
    expect(impact.currentUsedMinor).toBe(0);
    expect(impact.projectedUsedMinor).toBe(92_000);
    expect(impact.projectedPct).toBe(92);
    expect(impact.wouldWarn).toBe(true);   // default warn threshold is 80%
    expect(impact.wouldBlock).toBe(false); // and nothing blocks by default
  });

  it('the default policy warns at 80% and blocks nothing', async () => {
    const p = (await http().get('/budgets/policy').set(...bearer(buyerA)).expect(200)).body;
    expect(p).toEqual({ warnPct: 80, blockPct: null, allowOverride: true });
  });

  it('rejects a policy that would block before it warns', async () => {
    await http().put('/budgets/policy').set(...bearer(buyerA)).send({ warnPct: 90, blockPct: 80 }).expect(400);
  });

  it('an armed block refuses the approval — and the request stays SUBMITTED', async () => {
    await http().put('/budgets/policy').set(...bearer(buyerA)).send({ warnPct: 80, blockPct: 100 }).expect(200);
    await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Blocked ${tag}`, category: 'BLOCKED', periodYear: YEAR, amountMinor: 50_000 }).expect(201);

    const req = await http().post('/requests').set(...bearer(buyerA))
      .send({ title: `Blocked ${tag}`, category: 'BLOCKED', items: [{ name: 'x', qty: 1, estUnitPriceMinor: 120_000 }] })
      .expect(201);
    await http().post(`/requests/${req.body.id}/submit`).set(...bearer(buyerA)).expect(201);
    await http().post(`/requests/${req.body.id}/approve`).set(...bearer(approverA)).expect(403);

    // the whole approval was rolled back, not half-applied
    const after = (await http().get(`/requests/${req.body.id}`).set(...bearer(buyerA)).expect(200)).body;
    expect(after.status).toBe('SUBMITTED');
    expect(after.approved_at).toBeNull();
    const b = (await http().get('/budgets').set(...bearer(buyerA))).body.find((x: any) => x.name === `Blocked ${tag}`);
    expect(b.usedMinor).toBe(0);
  });

  it('an admin can override the block with a written reason; an approver cannot', async () => {
    // created by the approver so the admin is free to approve it (segregation of duties)
    const req = await http().post('/requests').set(...bearer(approverA))
      .send({ title: `Override ${tag}`, category: 'BLOCKED', items: [{ name: 'x', qty: 1, estUnitPriceMinor: 70_000 }] })
      .expect(201);
    await http().post(`/requests/${req.body.id}/submit`).set(...bearer(approverA)).expect(201);

    // an approver's override attempt is refused: overriding is an admin act
    await http().post(`/requests/${req.body.id}/approve`).set(...bearer(approverA))
      .send({ budgetOverrideReason: 'urgent' }).expect(403);

    const done = await http().post(`/requests/${req.body.id}/approve`).set(...bearer(buyerA))
      .send({ budgetOverrideReason: 'urgent safety purchase, CFO agreed' }).expect(201);
    expect(done.body.status).toBe('APPROVED');
    const overrides = await db.query(
      `SELECT payload FROM audit_events WHERE action='BUDGET_BLOCK_OVERRIDDEN' AND payload->>'request_id' = $1`,
      [req.body.id],
    );
    expect(overrides.rows).toHaveLength(1);
    expect(overrides.rows[0].payload.reason).toContain('CFO');
  });

  it('with overrides disabled, even an admin is refused', async () => {
    await http().put('/budgets/policy').set(...bearer(buyerA))
      .send({ warnPct: 80, blockPct: 100, allowOverride: false }).expect(200);
    const req = await http().post('/requests').set(...bearer(approverA))
      .send({ title: `NoOverride ${tag}`, category: 'BLOCKED', items: [{ name: 'x', qty: 1, estUnitPriceMinor: 60_000 }] })
      .expect(201);
    await http().post(`/requests/${req.body.id}/submit`).set(...bearer(approverA)).expect(201);
    await http().post(`/requests/${req.body.id}/approve`).set(...bearer(buyerA))
      .send({ budgetOverrideReason: 'please' }).expect(403);

    // back to the default so the remaining specs see unblocked behaviour
    await http().put('/budgets/policy').set(...bearer(buyerA))
      .send({ warnPct: 80, blockPct: null, allowOverride: true }).expect(200);
  });

  it('crossing the warn threshold notifies the buyer org', async () => {
    await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Warned ${tag}`, category: 'WARNED', periodYear: YEAR, amountMinor: 100_000 }).expect(201);
    await approveRequest(buyerA, 'WARNED', 85_000);
    const notes = (await http().get('/notifications').set(...bearer(buyerA)).expect(200)).body;
    const note = notes.find((n: any) => n.type === 'BUDGET_THRESHOLD_CROSSED' && n.payload.budget === `Warned ${tag}`);
    expect(note).toBeTruthy();
    expect(note.payload.utilization).toBe('85%');
  });

  it('the warning is addressed to the department owner when one is named', async () => {
    const ownerId = (await http().get('/settings/users').set(...bearer(buyerA)))
      .body.find((u: any) => u.email === `apprv-${tag}@t.test`).id;
    const dep = (await http().post('/departments').set(...bearer(buyerA))
      .send({ code: `OWN-${tag}`, ownerUserId: ownerId }).expect(201)).body;
    await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Owned ${tag}`, category: 'OWNED', departmentId: dep.id, periodYear: YEAR, amountMinor: 100_000 })
      .expect(201);

    await approveRequest(buyerA, 'OWNED', 90_000, dep.id);
    const row = await db.query(
      `SELECT recipient_user_id FROM notifications
       WHERE type='BUDGET_THRESHOLD_CROSSED' AND payload->>'budget' = $1`,
      [`Owned ${tag}`],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].recipient_user_id).toBe(ownerId); // not a blast to the whole org
  });

  // ---------- department rollup: the finance headline ----------

  it('rolls plan / committed / actual up per department, with paid reported beside them', async () => {
    const rollup = (await http().get('/budgets/rollup').set(...bearer(buyerA)).expect(200)).body;
    expect(rollup.length).toBeGreaterThan(0);

    const orgWide = rollup.find((r: any) => r.departmentId === null);
    expect(orgWide).toBeTruthy();
    // sums match the per-budget rows the table shows
    const budgets = (await http().get('/budgets').set(...bearer(buyerA))).body;
    const expected = budgets
      .filter((b: any) => b.departmentId === null)
      .reduce((s: number, b: any) => s + b.committedMinor + b.actualMinor, 0);
    expect(orgWide.usedMinor).toBe(expected);
    // paid is its own number, never folded into used
    expect(orgWide).toHaveProperty('paidMinor');
    expect(orgWide.usedMinor).toBe(orgWide.committedMinor + orgWide.actualMinor);
  });

  it('a settled invoice shows up as paid under its department, without inflating actual', async () => {
    const dep = (await http().get('/departments').set(...bearer(buyerA))).body.find((d: any) => d.code === `ENG-${tag}`);
    const before = (await http().get('/budgets/rollup').set(...bearer(buyerA)).expect(200)).body
      .find((r: any) => r.departmentId === dep.id);

    // an invoice already settled against that cost centre
    // a PO of THIS buyer — an invoice against another org's order is invisible under RLS
    const po = (await db.query(
      `SELECT id, buyer_org_id, supplier_org_id FROM purchase_orders
       WHERE buyer_org_id = (SELECT buyer_org_id FROM departments WHERE id = $1) LIMIT 1`,
      [dep.id],
    )).rows[0];
    await db.query(
      `INSERT INTO invoices(buyer_org_id, supplier_org_id, po_id, invoice_no, currency, net_minor, vat_minor,
         gross_minor, status, department_id)
       VALUES ($1,$2,$3,$4,'AZN',40000,0,40000,'PAID',$5)`,
      [po.buyer_org_id, po.supplier_org_id, po.id, `INV-PAID-${tag}`, dep.id],
    );

    const after = (await http().get('/budgets/rollup').set(...bearer(buyerA)).expect(200)).body
      .find((r: any) => r.departmentId === dep.id);
    expect(after.paidMinor).toBe(before.paidMinor + 40_000);
    expect(after.actualMinor).toBe(before.actualMinor); // settlement is not extra spend
    expect(after.usedMinor).toBe(before.usedMinor);
  });

  // ---------- revisions & rollover ----------

  it('records the opening plan and every later change as a revision', async () => {
    const b = (await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Rev ${tag}`, category: 'REV', periodYear: YEAR, amountMinor: 500_000, reason: 'annual plan' })
      .expect(201)).body;

    let history = (await http().get(`/budgets/${b.id}/revisions`).set(...bearer(buyerA)).expect(200)).body;
    expect(history).toHaveLength(1);
    expect(history[0].amountBeforeMinor).toBeNull();
    expect(history[0].amountAfterMinor).toBe(500_000);
    expect(history[0].reason).toBe('annual plan');

    await http().put(`/budgets/${b.id}`).set(...bearer(buyerA))
      .send({ name: `Rev ${tag}`, category: 'REV', periodYear: YEAR, amountMinor: 900_000, reason: 'Q2 uplift' })
      .expect(200);

    history = (await http().get(`/budgets/${b.id}/revisions`).set(...bearer(buyerA)).expect(200)).body;
    expect(history).toHaveLength(2);
    expect(history[1].amountBeforeMinor).toBe(500_000);
    expect(history[1].amountAfterMinor).toBe(900_000);
    expect(history[1].deltaMinor).toBe(400_000);
    expect(history[1].reason).toBe('Q2 uplift');
    expect(history[1].createdByName).toBeTruthy();
  });

  it('renaming a budget without touching the amount adds no revision', async () => {
    const b = (await http().get('/budgets').set(...bearer(buyerA))).body.find((x: any) => x.name === `Rev ${tag}`);
    await http().put(`/budgets/${b.id}`).set(...bearer(buyerA))
      .send({ name: `Rev renamed ${tag}`, category: 'REV', periodYear: YEAR, amountMinor: 900_000 }).expect(200);
    const history = (await http().get(`/budgets/${b.id}/revisions`).set(...bearer(buyerA)).expect(200)).body;
    expect(history).toHaveLength(2);
  });

  it('carries an unspent remainder into the next period as a traceable revision', async () => {
    const q1 = (await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Roll Q1 ${tag}`, category: 'ROLL', periodType: 'QUARTER', periodYear: YEAR, periodQuarter: 1, amountMinor: 300_000 })
      .expect(201)).body;
    const q2 = (await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Roll Q2 ${tag}`, category: 'ROLL', periodType: 'QUARTER', periodYear: YEAR, periodQuarter: 2, amountMinor: 200_000 })
      .expect(201)).body;

    const after = (await http().post(`/budgets/${q2.id}/rollover`).set(...bearer(buyerA))
      .send({ sourceBudgetId: q1.id }).expect(201)).body;
    expect(after.amountMinor).toBe(500_000); // 200k plan + 300k unspent

    const history = (await http().get(`/budgets/${q2.id}/revisions`).set(...bearer(buyerA)).expect(200)).body;
    expect(history).toHaveLength(2);
    expect(history[1].rolloverFromBudgetId).toBe(q1.id);
    expect(history[1].rolloverFromName).toBe(`Roll Q1 ${tag}`);

    // and the same remainder cannot be carried twice
    await http().post(`/budgets/${q2.id}/rollover`).set(...bearer(buyerA))
      .send({ sourceBudgetId: q1.id }).expect(409);
  });

  it('refuses to carry forward from a budget with nothing left', async () => {
    const spent = (await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Spent ${tag}`, category: 'SPENT', periodType: 'QUARTER', periodYear: YEAR, periodQuarter: 1, amountMinor: 10_000 })
      .expect(201)).body;
    const target = (await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Spent target ${tag}`, category: 'SPENT', periodType: 'QUARTER', periodYear: YEAR, periodQuarter: 2, amountMinor: 10_000 })
      .expect(201)).body;
    // consume the source entirely
    await db.query(`UPDATE budgets SET amount_minor = 0 WHERE id = $1`, [spent.id]);
    await http().post(`/budgets/${target.id}/rollover`).set(...bearer(buyerA))
      .send({ sourceBudgetId: spent.id }).expect(400);
  });

  // ---------- export & guardrails ----------

  it('exports the filtered budgets as CSV with plan / committed / actual', async () => {
    const res = await http().get(`/budgets/export?year=${YEAR}`).set(...bearer(buyerA)).expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('budgets.csv');
    const [header, ...lines] = res.text.split('\r\n');
    expect(header).toContain('Обязательства');
    expect(header).toContain('Факт');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0].split(';')).toHaveLength(13);
  });

  it('a budget in a category the buyer never curated is refused', async () => {
    // buyer A has a category directory by now only if one was created — make it explicit
    await http().post('/categories').set(...bearer(buyerA)).send({ code: `CUR-${tag}` }).expect(201);
    await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Typo ${tag}`, category: `cur-${tag}`, periodYear: YEAR, amountMinor: 1000 }).expect(400);
    // the curated code itself is fine
    await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Curated ${tag}`, category: `CUR-${tag}`, periodYear: YEAR, amountMinor: 1000 }).expect(201);
  });

  // ---------- catalog call-offs: spend with no request behind it ----------

  it('a catalog order charges its department’s budget even with no request', async () => {
    const dep = (await http().post('/departments').set(...bearer(buyerA)).send({ code: `CAT-${tag}` }).expect(201)).body;
    // category-agnostic budget: a call-off carries no category, so only '*' may claim it
    await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Catalog dep ${tag}`, departmentId: dep.id, periodYear: YEAR, amountMinor: 400_000 }).expect(201);

    const poId = await orderFromCatalog(dep.id, 3, 25_000); // 3 × 250.00
    expect(poId).toBeTruthy();

    const b = (await http().get('/budgets').set(...bearer(buyerA))).body.find((x: any) => x.name === `Catalog dep ${tag}`);
    expect(b.actualMinor).toBe(75_000);
    expect(b.committedMinor).toBe(0);   // no request behind it, so nothing was ever committed
    expect(b.usedMinor).toBe(75_000);
  });

  it('a category budget never absorbs an unclassified catalog order', async () => {
    const dep = (await http().get('/departments').set(...bearer(buyerA))).body.find((d: any) => d.code === `CAT-${tag}`);
    // this buyer has a curated category directory by now, so the code must be in it
    await http().post('/categories').set(...bearer(buyerA)).send({ code: 'STATIONERY' }).expect(201);
    await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Catalog cat ${tag}`, category: 'STATIONERY', departmentId: dep.id, periodYear: YEAR, amountMinor: 900_000 })
      .expect(201);
    await orderFromCatalog(dep.id, 1, 10_000);
    const list = (await http().get('/budgets').set(...bearer(buyerA))).body;
    expect(list.find((x: any) => x.name === `Catalog cat ${tag}`).usedMinor).toBe(0);
    expect(list.find((x: any) => x.name === `Catalog dep ${tag}`).usedMinor).toBe(85_000);
  });

  // Requests are AZN by construction, but a contract inherits its tender's evaluation
  // currency, so an ORDER can be foreign. It must never be added to an AZN budget at face
  // value, and it must not vanish either.
  it('a foreign-currency order neither pollutes the AZN budget nor disappears', async () => {
    await http().post('/categories').set(...bearer(buyerA)).send({ code: 'FXCAT' }).expect(201);
    await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Fx ${tag}`, category: 'FXCAT', periodYear: YEAR, amountMinor: 1_000_000 }).expect(201);
    const req = await approveRequest(buyerA, 'FXCAT', 200_000);

    let b = (await http().get('/budgets').set(...bearer(buyerA))).body.find((x: any) => x.name === `Fx ${tag}`);
    expect(b.committedMinor).toBe(200_000);

    // an order placed in USD against that AZN request
    const poId = await orderFromCatalog(undefined, 1, 999);
    await db.query(
      `UPDATE purchase_orders SET request_id = $2, currency = 'USD', total_minor = 500000 WHERE id = $1`,
      [poId, req.id],
    );

    b = (await http().get('/budgets').set(...bearer(buyerA))).body.find((x: any) => x.name === `Fx ${tag}`);
    expect(b.actualMinor).toBe(0);          // the USD total is NOT mixed into an AZN budget
    expect(b.committedMinor).toBe(200_000); // and the AZN estimate stays as the commitment

    const report = (await http().get('/budgets/unbudgeted').set(...bearer(buyerA)).expect(200)).body;
    const row = report.find((x: any) => x.id === poId);
    expect(row).toBeTruthy();               // visible, not silently dropped
    expect(row.currency).toBe('USD');
    expect(row.amountMinor).toBe(500_000);
  });

  it('a catalog order with no department at all lands in the unbudgeted report', async () => {
    const poId = await orderFromCatalog(undefined, 2, 5_000);
    const report = (await http().get('/budgets/unbudgeted').set(...bearer(buyerA)).expect(200)).body;
    const row = report.find((x: any) => x.id === poId);
    expect(row).toBeTruthy();
    expect(row.kind).toBe('ORDER');
    expect(row.amountMinor).toBe(10_000);
  });

  it('filters the list by period type and year', async () => {
    const quarters = (await http().get(`/budgets?periodType=QUARTER&year=${YEAR}`).set(...bearer(buyerA)).expect(200)).body;
    expect(quarters.length).toBeGreaterThan(0);
    expect(quarters.every((b: any) => b.periodType === 'QUARTER' && b.periodYear === YEAR)).toBe(true);
    const lastYear = (await http().get(`/budgets?year=${YEAR - 1}`).set(...bearer(buyerA)).expect(200)).body;
    expect(lastYear.every((b: any) => b.periodYear === YEAR - 1)).toBe(true);
  });
});
