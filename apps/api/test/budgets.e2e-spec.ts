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

  // Budgets are documents now: created as a DRAFT, submitted, then approved by someone
  // else. Specs that just need a live plan go through here.
  const mkBudget = async (body: Record<string, unknown>, token = buyerA) => {
    const created = await http().post('/budgets').set(...bearer(token)).send(body);
    if (created.status !== 201) return created;
    const id = created.body.id;
    await http().post(`/budgets/${id}/submit`).set(...bearer(token)).expect(201);
    await http().post(`/budgets/${id}/approve`).set(...bearer(approverA)).expect(201);
    const live = await http().get('/budgets').set(...bearer(token));
    return { ...created, body: live.body.find((b: any) => b.id === id) ?? created.body, status: 201 };
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
    await mkBudget({ name: `IT ${tag}`, category: 'IT', periodYear: YEAR, amountMinor: 500_000 });
    await approveRequest(buyerA, 'IT', 200_000);
    const list = await http().get('/budgets').set(...bearer(buyerA)).expect(200);
    const b = list.body.find((x: any) => x.name === `IT ${tag}`);
    expect(b.committedMinor).toBeGreaterThanOrEqual(200_000);
    expect(b.remainingMinor).toBe(b.amountMinor - b.committedMinor);
  });

  it('an over-budget approval warns but the request is still APPROVED', async () => {
    await mkBudget({ name: `Tiny ${tag}`, category: 'TINY', periodYear: YEAR, amountMinor: 50_000 });
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

  it('closing freezes the numbers: later changes cannot move a signed-off period', async () => {
    const past = (await mkBudget({
      name: `Frozen period ${tag}`, category: 'FROZENP', periodType: 'MONTH', periodYear: YEAR - 1, periodMonth: 3, amountMinor: 500_000,
    })).body;
    const r = await approveRequest(buyerA, 'FROZENP', 120_000);
    await db.query(`UPDATE procurement_requests SET approved_at = $2 WHERE id = $1`, [r.id, `${YEAR - 1}-03-10T10:00:00Z`]);

    let b = (await http().get('/budgets').set(...bearer(buyerA))).body.find((x: any) => x.id === past.id);
    expect(b.usedMinor).toBe(120_000);

    await http().post(`/budgets/${past.id}/close`).set(...bearer(buyerA)).expect(201);

    // the request is cancelled AFTER sign-off — live maths would drop the spend to zero
    await http().post(`/requests/${r.id}/cancel`).set(...bearer(buyerA)).send({ reason: 'not needed after all' }).expect(201);

    b = (await http().get('/budgets').set(...bearer(buyerA))).body.find((x: any) => x.id === past.id);
    expect(b.status).toBe('CLOSED');
    expect(b.usedMinor).toBe(120_000); // still what it was signed off as

    // reopening makes it live again, and now the cancellation shows
    await http().post(`/budgets/${past.id}/reopen`).set(...bearer(buyerA)).send({ reason: 'recount' }).expect(201);
    b = (await http().get('/budgets').set(...bearer(buyerA))).body.find((x: any) => x.id === past.id);
    expect(b.usedMinor).toBe(0);
  });

  // ---------- bulk entry ----------

  it('imports budgets from CSV as drafts, and rejects a bad file whole', async () => {
    const dep = (await http().post('/departments').set(...bearer(buyerA)).send({ code: `IMP-${tag}` }).expect(201)).body;
    expect(dep.code).toBe(`IMP-${tag}`);

    const good = [
      'name;amount;department;category;periodtype;year;quarter;reason',
      `Import A ${tag};1200.50;IMP-${tag};IMPCAT1-${tag};YEAR;${YEAR};;plan`,
      `Import B ${tag};900;IMP-${tag};IMPCAT2-${tag};QUARTER;${YEAR};2;plan`,
    ].join('\n');
    const res = await http().post('/budgets/import').set(...bearer(buyerA)).send({ csv: good }).expect(201);
    expect(res.body.imported).toBe(2);

    // an import may never put money in force — everything arrives as a draft
    const list = (await http().get('/budgets').set(...bearer(buyerA))).body;
    const a = list.find((b: any) => b.name === `Import A ${tag}`);
    expect(a.status).toBe('DRAFT');
    expect(a.amountMinor).toBe(120_050); // 1200.50 parsed from digits, not through a float
    expect(list.find((b: any) => b.name === `Import B ${tag}`).periodLabel).toBe(`${YEAR} Q2`);

    // a file with one bad line imports NOTHING: a half-loaded plan hides what is missing
    const bad = [
      'name;amount;department;category;year',
      `Bad one ${tag};500;IMP-${tag};BADCAT-${tag};${YEAR}`,
      `Bad two ${tag};not-a-number;IMP-${tag};BADCAT2-${tag};${YEAR}`,
    ].join('\n');
    const err = await http().post('/budgets/import').set(...bearer(buyerA)).send({ csv: bad }).expect(400);
    expect(String(err.body.message)).toContain('Line 3');
    const after = (await http().get('/budgets').set(...bearer(buyerA))).body;
    expect(after.find((b: any) => b.name === `Bad one ${tag}`)).toBeUndefined();
  });

  it('names an unknown department by line instead of failing obscurely', async () => {
    const csv = ['name;amount;department', `Ghost ${tag};100;NOPE-${tag}`].join('\n');
    const err = await http().post('/budgets/import').set(...bearer(buyerA)).send({ csv }).expect(400);
    expect(String(err.body.message)).toContain(`NOPE-${tag}`);
  });

  // ---------- drill-down and forecast ----------

  it('every number opens into the documents behind it', async () => {
    const dep = (await http().post('/departments').set(...bearer(buyerA)).send({ code: `DRILL-${tag}` }).expect(201)).body;
    const b = (await mkBudget({ name: `Drill ${tag}`, category: 'DRILL', departmentId: dep.id, periodYear: YEAR, amountMinor: 500_000 })).body;
    await approveRequest(buyerA, 'DRILL', 120_000, dep.id);
    await approveRequest(buyerA, 'DRILL', 30_000, dep.id);

    const docs = (await http().get(`/budgets/${b.id}/documents`).set(...bearer(buyerA)).expect(200)).body;
    expect(docs).toHaveLength(2);
    expect(docs.every((d: any) => d.kind === 'REQUEST' && d.bucket === 'committed')).toBe(true);

    // the list adds up to the figure it explains — that is the whole point
    const total = docs.reduce((sum: number, d: any) => sum + d.amountMinor, 0);
    const live = (await http().get('/budgets').set(...bearer(buyerA))).body.find((x: any) => x.id === b.id);
    expect(total).toBe(live.committedMinor);

    const onlyActual = (await http().get(`/budgets/${b.id}/documents?kind=actual`).set(...bearer(buyerA)).expect(200)).body;
    expect(onlyActual).toHaveLength(0);
  });

  it('the rollup forecasts where the period ends up at the current rate', async () => {
    const rows = (await http().get('/budgets/rollup?current=1').set(...bearer(buyerA)).expect(200)).body;
    const row = rows.find((r: any) => r.usedMinor > 0);
    expect(row).toBeTruthy();
    // run-rate: spend so far extrapolated over the whole period
    expect(row.forecastMinor).toBe(Math.round((row.usedMinor / row.elapsedPct) * 100));
    expect(row.forecastOverMinor).toBe(Math.max(0, row.forecastMinor - row.amountMinor));
  });

  it('a parent department rolls up what its units spend', async () => {
    const div = (await http().post('/departments').set(...bearer(buyerA)).send({ code: `DIV-${tag}` }).expect(201)).body;
    const unit = (await http().post('/departments').set(...bearer(buyerA))
      .send({ code: `UNIT-${tag}`, parentId: div.id }).expect(201)).body;

    await mkBudget({ name: `Div own ${tag}`, departmentId: div.id, category: `DIVC-${tag}`, periodYear: YEAR, amountMinor: 100_000 });
    await mkBudget({ name: `Unit own ${tag}`, departmentId: unit.id, category: `UNITC-${tag}`, periodYear: YEAR, amountMinor: 40_000 });
    await approveRequest(buyerA, `UNITC-${tag}`, 25_000, unit.id);

    const rollup = (await http().get('/budgets/rollup').set(...bearer(buyerA)).expect(200)).body;
    const parent = rollup.find((r: any) => r.departmentCode === `DIV-${tag}`);
    const child = rollup.find((r: any) => r.departmentCode === `UNIT-${tag}`);

    // the unit reports itself…
    expect(child.amountMinor).toBe(40_000);
    expect(child.usedMinor).toBe(25_000);
    expect(child.includesChildren).toBe(false);
    // …and the division reports its own plan PLUS the unit's
    expect(parent.amountMinor).toBe(140_000);
    expect(parent.usedMinor).toBe(25_000);
    expect(parent.includesChildren).toBe(true);
    expect(parent.depth).toBeLessThan(child.depth);
  });

  // ---------- who may touch the money ----------

  it('a finance controller owns the budget side without running procurement', async () => {
    await http().post('/settings/users').set(...bearer(buyerA))
      .send({ email: `fin-${tag}@t.test`, fullName: 'Controller', password: 'password123', role: 'BUYER_FINANCE' }).expect(201);
    const fin = (await http().post('/auth/login').send({ email: `fin-${tag}@t.test`, password: 'password123' }).expect(201)).body.accessToken;

    // sees the whole plan, not one department
    const all = (await http().get('/budgets').set(...bearer(fin)).expect(200)).body;
    expect(all.length).toBeGreaterThan(1);

    // can draft, submit and put a plan in force, and can set the thresholds
    const d = (await http().post('/budgets').set(...bearer(fin))
      .send({ name: `Fin ${tag}`, category: 'FIN', periodYear: YEAR, amountMinor: 70_000 }).expect(201)).body;
    await http().post(`/budgets/${d.id}/submit`).set(...bearer(fin)).expect(201);
    await http().post(`/budgets/${d.id}/approve`).set(...bearer(buyerA)).expect(201);
    // same values as the default: this spec proves the RIGHT to set thresholds, and must
    // not move a number the threshold specs below assert on
    await http().put('/budgets/policy').set(...bearer(fin)).send({ warnPct: 80, blockPct: null }).expect(200);

    // but procurement is not their job: they cannot approve a spending request
    const req = await http().post('/requests').set(...bearer(buyerA))
      .send({ title: `Fin req ${tag}`, category: 'FIN', items: [{ name: 'x', qty: 1, estUnitPriceMinor: 1000 }] }).expect(201);
    await http().post(`/requests/${req.body.id}/submit`).set(...bearer(buyerA)).expect(201);
    await http().post(`/requests/${req.body.id}/approve`).set(...bearer(fin)).expect(403);
  });

  it('a department owner drafts their own budget and nobody else’s', async () => {
    const ownerEmail = `own-${tag}@t.test`;
    await http().post('/settings/users').set(...bearer(buyerA))
      .send({ email: ownerEmail, fullName: 'Dept head', password: 'password123', role: 'BUYER_USER' }).expect(201);
    const ownerId = (await http().get('/settings/users').set(...bearer(buyerA))).body.find((u: any) => u.email === ownerEmail).id;
    const mine = (await http().post('/departments').set(...bearer(buyerA))
      .send({ code: `OWNED-${tag}`, ownerUserId: ownerId }).expect(201)).body;
    const theirs = (await http().post('/departments').set(...bearer(buyerA)).send({ code: `OTHER-${tag}` }).expect(201)).body;
    const owner = (await http().post('/auth/login').send({ email: ownerEmail, password: 'password123' }).expect(201)).body.accessToken;

    await http().post('/budgets').set(...bearer(owner))
      .send({ name: `Mine ${tag}`, departmentId: mine.id, periodYear: YEAR, amountMinor: 5_000 }).expect(201);
    // another department, or the org-wide ceiling, is not theirs to plan
    await http().post('/budgets').set(...bearer(owner))
      .send({ name: `Theirs ${tag}`, departmentId: theirs.id, periodYear: YEAR, amountMinor: 5_000 }).expect(403);
    await http().post('/budgets').set(...bearer(owner))
      .send({ name: `Orgwide ${tag}`, periodYear: YEAR, amountMinor: 5_000 }).expect(403);

    // and they read only their own cost centre
    const seen = (await http().get('/budgets').set(...bearer(owner)).expect(200)).body;
    expect(seen.every((b: any) => b.departmentId === mine.id)).toBe(true);
  });

  // ---------- the budget as a document ----------

  it('a new budget is a DRAFT and holds no money until it is approved', async () => {
    const draft = (await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Life ${tag}`, category: 'LIFE', periodYear: YEAR, amountMinor: 300_000 }).expect(201)).body;
    expect(draft.status).toBe('DRAFT');

    // a request that would land on it commits nothing while the plan is still a draft
    await approveRequest(buyerA, 'LIFE', 90_000);
    let b = (await http().get('/budgets').set(...bearer(buyerA))).body.find((x: any) => x.id === draft.id);
    expect(b.usedMinor).toBe(0);

    await http().post(`/budgets/${draft.id}/submit`).set(...bearer(buyerA)).expect(201);
    b = (await http().get('/budgets').set(...bearer(buyerA))).body.find((x: any) => x.id === draft.id);
    expect(b.status).toBe('PENDING');

    await http().post(`/budgets/${draft.id}/approve`).set(...bearer(approverA)).expect(201);
    b = (await http().get('/budgets').set(...bearer(buyerA))).body.find((x: any) => x.id === draft.id);
    expect(b.status).toBe('APPROVED');
    expect(b.usedMinor).toBe(90_000); // the same spend now counts
  });

  it('a budget awaiting approval is frozen; recall unlocks it', async () => {
    const d = (await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Frozen ${tag}`, category: 'FROZEN', periodYear: YEAR, amountMinor: 10_000 }).expect(201)).body;
    await http().post(`/budgets/${d.id}/submit`).set(...bearer(buyerA)).expect(201);
    await http().put(`/budgets/${d.id}`).set(...bearer(buyerA))
      .send({ name: `Frozen ${tag}`, category: 'FROZEN', periodYear: YEAR, amountMinor: 20_000 }).expect(409);
    await http().post(`/budgets/${d.id}/recall`).set(...bearer(buyerA)).expect(201);
    await http().put(`/budgets/${d.id}`).set(...bearer(buyerA))
      .send({ name: `Frozen ${tag}`, category: 'FROZEN', periodYear: YEAR, amountMinor: 20_000 }).expect(200);
  });

  it('the submitter cannot approve their own budget when someone else could', async () => {
    const d = (await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `SoD ${tag}`, category: 'SOD', periodYear: YEAR, amountMinor: 10_000 }).expect(201)).body;
    await http().post(`/budgets/${d.id}/submit`).set(...bearer(buyerA)).expect(201);
    await http().post(`/budgets/${d.id}/approve`).set(...bearer(buyerA)).expect(403);
    await http().post(`/budgets/${d.id}/approve`).set(...bearer(approverA)).expect(201);
  });

  it('a rejected plan goes back to DRAFT with the reason on the record', async () => {
    const d = (await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Rej ${tag}`, category: 'REJ', periodYear: YEAR, amountMinor: 10_000 }).expect(201)).body;
    await http().post(`/budgets/${d.id}/submit`).set(...bearer(buyerA)).expect(201);
    const back = await http().post(`/budgets/${d.id}/reject`).set(...bearer(approverA))
      .send({ reason: 'too high for this department' }).expect(201);
    expect(back.body.status).toBe('DRAFT');
    const trail = await db.query(
      `SELECT payload FROM audit_events WHERE action='BUDGET_REJECTED' AND entity_id=$1`, [d.id],
    );
    expect(trail.rows[0].payload.reason).toContain('too high');
  });

  it('only a draft can be deleted — an approved budget is closed, not erased', async () => {
    const live = (await mkBudget({ name: `Keep ${tag}`, category: 'KEEP', periodYear: YEAR, amountMinor: 10_000 })).body;
    await http().delete(`/budgets/${live.id}`).set(...bearer(buyerA)).expect(409);
    const draft = (await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Trash ${tag}`, category: 'TRASH', periodYear: YEAR, amountMinor: 10_000 }).expect(201)).body;
    await http().delete(`/budgets/${draft.id}`).set(...bearer(buyerA)).expect(200);
  });

  it('a period can only be closed after its last day, and a closed budget is frozen', async () => {
    const current = (await mkBudget({ name: `Close ${tag}`, category: 'CLOSE', periodYear: YEAR, amountMinor: 10_000 })).body;
    await http().post(`/budgets/${current.id}/close`).set(...bearer(buyerA)).expect(400); // period still running

    const past = (await mkBudget({
      name: `Past ${tag}`, category: 'PAST', periodType: 'MONTH', periodYear: YEAR - 1, periodMonth: 1, amountMinor: 10_000,
    })).body;
    const closed = await http().post(`/budgets/${past.id}/close`).set(...bearer(buyerA)).expect(201);
    expect(closed.body.status).toBe('CLOSED');
    await http().put(`/budgets/${past.id}`).set(...bearer(buyerA))
      .send({ name: `Past ${tag}`, category: 'PAST', periodType: 'MONTH', periodYear: YEAR - 1, periodMonth: 1, amountMinor: 20_000, reason: 'x' })
      .expect(409);

    // reopening is possible but must say why, and both hops stay in the trail
    await http().post(`/budgets/${past.id}/reopen`).set(...bearer(buyerA)).send({ reason: 'closed by mistake' }).expect(201);
    const trail = await db.query(
      `SELECT action FROM audit_events WHERE entity_id=$1 AND action IN ('BUDGET_CLOSED','BUDGET_REOPENED')`, [past.id],
    );
    expect(trail.rows).toHaveLength(2);
  });

  it('a closed budget keeps counting its spend, so history stays whole', async () => {
    const past = (await mkBudget({
      name: `Hist ${tag}`, category: 'HIST', periodType: 'MONTH', periodYear: YEAR - 1, periodMonth: 2, amountMinor: 100_000,
    })).body;
    const r = await approveRequest(buyerA, 'HIST', 40_000);
    await db.query(`UPDATE procurement_requests SET approved_at = $2 WHERE id = $1`, [r.id, `${YEAR - 1}-02-10T10:00:00Z`]);
    await http().post(`/budgets/${past.id}/close`).set(...bearer(buyerA)).expect(201);
    const b = (await http().get('/budgets').set(...bearer(buyerA))).body.find((x: any) => x.id === past.id);
    expect(b.status).toBe('CLOSED');
    expect(b.usedMinor).toBe(40_000);
  });

  // ---------- periods: year / quarter / month ----------

  it('the same name in different quarters is two budgets, not a collision', async () => {
    const q1 = await mkBudget({ name: `Q ${tag}`, category: 'QTR', periodType: 'QUARTER', periodYear: YEAR, periodQuarter: 1, amountMinor: 100_000 });
    const q2 = await mkBudget({ name: `Q ${tag}`, category: 'QTR', periodType: 'QUARTER', periodYear: YEAR, periodQuarter: 2, amountMinor: 100_000 });
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
    await mkBudget({ name: `Qnow ${tag}`, category: 'QNOW', periodType: 'QUARTER', periodYear: YEAR, periodQuarter: nowQ, amountMinor: 900_000 });
    await mkBudget({ name: `Qother ${tag}`, category: 'QNOW', periodType: 'QUARTER', periodYear: YEAR, periodQuarter: otherQ, amountMinor: 900_000 });
    await approveRequest(buyerA, 'QNOW', 300_000);
    const list = (await http().get('/budgets').set(...bearer(buyerA)).expect(200)).body;
    expect(list.find((b: any) => b.name === `Qnow ${tag}`).committedMinor).toBe(300_000);
    expect(list.find((b: any) => b.name === `Qother ${tag}`).committedMinor).toBe(0);
  });

  it('a monthly budget counts only its own month', async () => {
    const month = new Date().getUTCMonth() + 1;
    const other = month === 12 ? 1 : month + 1;
    await mkBudget({ name: `Mnow ${tag}`, category: 'MNTH', periodType: 'MONTH', periodYear: YEAR, periodMonth: month, amountMinor: 900_000 });
    await mkBudget({ name: `Moth ${tag}`, category: 'MNTH', periodType: 'MONTH', periodYear: YEAR, periodMonth: other, amountMinor: 900_000 });
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
    await mkBudget({ name: `DecY ${tag}`, category: 'XOVER', periodType: 'MONTH', periodYear: YEAR - 1, periodMonth: 12, amountMinor: 900_000 });
    await mkBudget({ name: `JanY ${tag}`, category: 'XOVER', periodType: 'MONTH', periodYear: YEAR, periodMonth: 1, amountMinor: 900_000 });

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
    await mkBudget({ name: `All ${tag}`, category: 'DUP', periodYear: YEAR, amountMinor: 1_000_000 });
    // …plus a tighter one for the department: the most specific wins, the other stays at 0.
    await mkBudget({ name: `Eng ${tag}`, category: 'DUP', departmentId: dep.id, periodYear: YEAR, amountMinor: 400_000 });

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
    await mkBudget({ name: `Ops any ${tag}`, departmentId: dep.id, periodYear: YEAR, amountMinor: 800_000 });
    await mkBudget({ name: `Ops fuel ${tag}`, category: 'FUEL', departmentId: dep.id, periodYear: YEAR, amountMinor: 200_000 });

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
    await mkBudget({ name: `Mkt ${tag}`, category: 'ADS', departmentId: dep.id, periodYear: YEAR, amountMinor: 30_000 });
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

    await mkBudget({ name: `Actual ${tag}`, category: 'ACT', periodYear: YEAR, amountMinor: 1_000_000 });
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
    await mkBudget({ name: `Release ${tag}`, category: 'RELEASE', periodYear: YEAR, amountMinor: 500_000 });
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
    await mkBudget({ name: `Impact ${tag}`, category: 'IMPACT', periodYear: YEAR, amountMinor: 100_000 });
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
    await mkBudget({ name: `Blocked ${tag}`, category: 'BLOCKED', periodYear: YEAR, amountMinor: 50_000 });

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
    await mkBudget({ name: `Warned ${tag}`, category: 'WARNED', periodYear: YEAR, amountMinor: 100_000 });
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
    await mkBudget({ name: `Owned ${tag}`, category: 'OWNED', departmentId: dep.id, periodYear: YEAR, amountMinor: 100_000 });

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
    const b = (await mkBudget({ name: `Rev ${tag}`, category: 'REV', periodYear: YEAR, amountMinor: 500_000, reason: 'annual plan' })).body;

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

  // An approved budget keeps its identity: the name, scope and period are what was signed
  // off, so renaming one is refused outright rather than quietly rewriting the record.
  it('an approved budget cannot be renamed or re-scoped — only its amount moves', async () => {
    const b = (await http().get('/budgets').set(...bearer(buyerA))).body.find((x: any) => x.name === `Rev ${tag}`);
    await http().put(`/budgets/${b.id}`).set(...bearer(buyerA))
      .send({ name: `Rev renamed ${tag}`, category: 'REV', periodYear: YEAR, amountMinor: 900_000 }).expect(409);
    await http().put(`/budgets/${b.id}`).set(...bearer(buyerA))
      .send({ name: `Rev ${tag}`, category: 'OTHER', periodYear: YEAR, amountMinor: 900_000 }).expect(409);
    const history = (await http().get(`/budgets/${b.id}/revisions`).set(...bearer(buyerA)).expect(200)).body;
    expect(history).toHaveLength(2); // nothing was written
  });

  it('changing an approved amount without a reason is refused', async () => {
    const b = (await http().get('/budgets').set(...bearer(buyerA))).body.find((x: any) => x.name === `Rev ${tag}`);
    await http().put(`/budgets/${b.id}`).set(...bearer(buyerA))
      .send({ name: `Rev ${tag}`, category: 'REV', periodYear: YEAR, amountMinor: 950_000 }).expect(400);
  });

  it('carries an unspent remainder into the next period as a traceable revision', async () => {
    const q1 = (await mkBudget({ name: `Roll Q1 ${tag}`, category: 'ROLL', periodType: 'QUARTER', periodYear: YEAR, periodQuarter: 1, amountMinor: 300_000 })).body;
    const q2 = (await mkBudget({ name: `Roll Q2 ${tag}`, category: 'ROLL', periodType: 'QUARTER', periodYear: YEAR, periodQuarter: 2, amountMinor: 200_000 })).body;

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
    const spent = (await mkBudget({ name: `Spent ${tag}`, category: 'SPENT', periodType: 'QUARTER', periodYear: YEAR, periodQuarter: 1, amountMinor: 10_000 })).body;
    const target = (await mkBudget({ name: `Spent target ${tag}`, category: 'SPENT', periodType: 'QUARTER', periodYear: YEAR, periodQuarter: 2, amountMinor: 10_000 })).body;
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
    await mkBudget({ name: `Curated ${tag}`, category: `CUR-${tag}`, periodYear: YEAR, amountMinor: 1000 });
  });

  // ---------- catalog call-offs: spend with no request behind it ----------

  it('a catalog order charges its department’s budget even with no request', async () => {
    const dep = (await http().post('/departments').set(...bearer(buyerA)).send({ code: `CAT-${tag}` }).expect(201)).body;
    // category-agnostic budget: a call-off carries no category, so only '*' may claim it
    await mkBudget({ name: `Catalog dep ${tag}`, departmentId: dep.id, periodYear: YEAR, amountMinor: 400_000 });

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
    await mkBudget({ name: `Fx ${tag}`, category: 'FXCAT', periodYear: YEAR, amountMinor: 1_000_000 });
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
  // Segregation of duties has to count every role that may approve. With BUYER_FINANCE left
  // out of the "is there anybody else?" query, an admin who submitted could sign their own
  // budget in an org whose only other member is a finance user.
  it('an admin cannot self-approve when the org has a finance user who could approve instead', async () => {
    const email = `fin2-${tag}@t.test`;
    await http().post('/settings/users').set(...bearer(buyerA))
      .send({ email, fullName: 'Finance Two', password: 'password123', role: 'BUYER_FINANCE' }).expect(201);
    await http().post('/categories').set(...bearer(buyerA)).send({ code: 'SODFIN' }).expect(201);

    const made = await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `SoD fin ${tag}`, category: 'SODFIN', periodYear: YEAR, amountMinor: 100_000 }).expect(201);
    await http().post(`/budgets/${made.body.id}/submit`).set(...bearer(buyerA)).expect(201);
    const res = await http().post(`/budgets/${made.body.id}/approve`).set(...bearer(buyerA)).expect(403);
    expect(String(res.body.message)).toContain('segregation of duties');

    // and the finance user can approve it, which is the point of refusing the submitter
    const finTok = (await http().post('/auth/login').send({ email, password: 'password123' }).expect(201)).body.accessToken;
    await http().post(`/budgets/${made.body.id}/approve`).set(...bearer(finTok)).expect(201);


  // ---- Monthly phasing: the plan's shape over time ----------------------------------
  // Pace and forecast used to assume spend arrives evenly. For seasonal budgets that reads
  // a department as overspending in spring and comfortable in autumn, both times wrongly.
  describe('monthly phasing', () => {
    let phasedId: string;

    it('an unphased budget still reports an even split, so the editor opens on reality', async () => {
      // its own category: by this point the directory is curated, and the scope EXCLUDE
      // constraint would collide with an earlier test's budget for the same year
      await http().post('/categories').set(...bearer(buyerA)).send({ code: 'PHASE' }).expect(201);
      const made = await mkBudget({ name: `Phase ${tag}`, category: 'PHASE', periodYear: YEAR, amountMinor: 1_200_000 });
      phasedId = made.body.id;
      const ph = (await http().get(`/budgets/${phasedId}/phasing`).set(...bearer(buyerA)).expect(200)).body;
      expect(ph.phased).toBe(false);
      expect(ph.months).toHaveLength(12);
      expect(ph.months[0].shareBp).toBe(833); // 10000/12 rounded
      expect(ph.months.every((m: any) => /^\d{4}-\d{2}$/.test(m.month))).toBe(true);
    });

    it('refuses a set that does not add up to 100%', async () => {
      const months = Array.from({ length: 12 }, (_, i) => ({ month: `${YEAR}-${String(i + 1).padStart(2, '0')}`, shareBp: 800 }));
      const res = await http().put(`/budgets/${phasedId}/phasing`).set(...bearer(buyerA)).send({ months }).expect(400);
      expect(String(res.body.message)).toContain('100.00%');
    });

    it('refuses a month outside the period, and a period left incomplete', async () => {
      const full = Array.from({ length: 12 }, (_, i) => ({ month: `${YEAR}-${String(i + 1).padStart(2, '0')}`, shareBp: i === 11 ? 833 + 4 : 833 }));
      const stray = [...full.slice(0, 11), { month: `${YEAR + 1}-01`, shareBp: 837 }];
      const out = await http().put(`/budgets/${phasedId}/phasing`).set(...bearer(buyerA)).send({ months: stray }).expect(400);
      expect(String(out.body.message)).toContain('outside the budget period');

      const short = await http().put(`/budgets/${phasedId}/phasing`).set(...bearer(buyerA))
        .send({ months: full.slice(0, 6).map((m) => ({ ...m, shareBp: 1666 })) }).expect(400);
      expect(String(short.body.message)).toContain('missing');
    });

    it('stores a seasonal split and reports each month in money', async () => {
      // everything lands in December: the sharpest case pace has to survive
      const months = Array.from({ length: 12 }, (_, i) => ({
        month: `${YEAR}-${String(i + 1).padStart(2, '0')}`, shareBp: i === 11 ? 10000 : 0,
      }));
      const saved = (await http().put(`/budgets/${phasedId}/phasing`).set(...bearer(buyerA)).send({ months }).expect(200)).body;
      expect(saved.phased).toBe(true);
      expect(saved.months[11].shareBp).toBe(10000);
      expect(saved.months[11].amountMinor).toBe(1_200_000);
      expect(saved.months[0].amountMinor).toBe(0);
    });

    it('pace follows the plan, not the calendar', async () => {
      // Compared against itself rather than against the calendar: the org-wide row mixes
      // budgets of several periods, so no single calendar share is the right baseline.
      const orgPace = async () => (await http().get(`/budgets/rollup?year=${YEAR}`).set(...bearer(buyerA)).expect(200))
        .body.find((r: any) => r.departmentId === null).elapsedPct;

      await http().put(`/budgets/${phasedId}/phasing`).set(...bearer(buyerA)).send({ months: [] }).expect(200);
      const unphased = await orgPace();

      // An even phasing must reproduce the even proration it replaces. This is the assertion
      // that catches a phasing which silently evaluates to nothing.
      const flat = Array.from({ length: 12 }, (_, i) => ({
        month: `${YEAR}-${String(i + 1).padStart(2, '0')}`, shareBp: i === 11 ? 10000 - 11 * 833 : 833,
      }));
      await http().put(`/budgets/${phasedId}/phasing`).set(...bearer(buyerA)).send({ months: flat }).expect(200);
      const even = await orgPace();
      expect(Math.abs(even - unphased)).toBeLessThan(1);

      // Everything in December: the plan says almost nothing should be spent yet, so the
      // organisation reads as further behind than the calendar would ever suggest.
      const dec = Array.from({ length: 12 }, (_, i) => ({
        month: `${YEAR}-${String(i + 1).padStart(2, '0')}`, shareBp: i === 11 ? 10000 : 0,
      }));
      await http().put(`/budgets/${phasedId}/phasing`).set(...bearer(buyerA)).send({ months: dec }).expect(200);
      expect(await orgPace()).toBeLessThan(unphased - 1);
    });

    it('clearing the phasing returns the budget to an even split', async () => {
      const cleared = (await http().put(`/budgets/${phasedId}/phasing`).set(...bearer(buyerA)).send({ months: [] }).expect(200)).body;
      expect(cleared.phased).toBe(false);
      expect(cleared.months[11].shareBp).toBe(833);
    });

    it('a closed period cannot be re-phased', async () => {
      // last year's plan: a budget can only be closed once its period is over
      const past = await mkBudget({ name: `Phase past ${tag}`, category: 'PHASE', periodYear: YEAR - 1, amountMinor: 600_000 });
      await http().post(`/budgets/${past.body.id}/close`).set(...bearer(buyerA)).expect(201);
      const months = Array.from({ length: 12 }, (_, i) => ({
        month: `${YEAR - 1}-${String(i + 1).padStart(2, '0')}`, shareBp: i === 11 ? 837 : 833,
      }));
      const res = await http().put(`/budgets/${past.body.id}/phasing`).set(...bearer(buyerA)).send({ months }).expect(409);
      expect(String(res.body.message)).toContain('reopen');
    });
  });

  // ---- Export for the accounting system --------------------------------------------
  it('a draft plan does not inflate the rollup: only signed-off budgets are a ceiling', async () => {
    await http().post('/categories').set(...bearer(buyerA)).send({ code: 'DRAFTROLL' }).expect(201);
    const before = (await http().get(`/budgets/rollup?year=${YEAR}`).set(...bearer(buyerA)).expect(200)).body
      .find((r: any) => r.departmentId === null).amountMinor;
    // created, never submitted — a proposal nobody has signed
    await http().post('/budgets').set(...bearer(buyerA))
      .send({ name: `Draft roll ${tag}`, category: 'DRAFTROLL', periodYear: YEAR, amountMinor: 9_000_000 }).expect(201);
    const after = (await http().get(`/budgets/rollup?year=${YEAR}`).set(...bearer(buyerA)).expect(200)).body
      .find((r: any) => r.departmentId === null).amountMinor;
    expect(after).toBe(before);
  });

  describe('1C export', () => {
    it('emits a row per month, and the months add up to the plan exactly', async () => {
      await http().post('/categories').set(...bearer(buyerA)).send({ code: 'ONEC' }).expect(201);
      // 100.00 over 12 months does not divide evenly — the rounding has to land somewhere
      const made = await mkBudget({ name: `1C ${tag}`, category: 'ONEC', periodYear: YEAR, amountMinor: 10_000 });
      const csv = (await http().get(`/budgets/export/1c?year=${YEAR}`).set(...bearer(buyerA)).expect(200)).text;
      const rows = csv.replace(/^\ufeff/, '').trim().split('\r\n');
      expect(rows[0]).toContain('Период');
      const mine = rows.slice(1).filter((r) => r.includes(`1C ${tag}`));
      expect(mine).toHaveLength(12);
      const sum = mine.reduce((n, r) => n + Math.round(Number(r.split(';')[7].replace(/"/g, '')) * 100), 0);
      expect(sum).toBe(made.body.amountMinor);
      expect(mine[0]).toContain(`"${YEAR}-01"`);
      expect(mine[11]).toContain(`"${YEAR}-12"`);
    });

    it('a phased budget exports the shares finance entered, not an even split', async () => {
      const b = (await http().get(`/budgets?year=${YEAR}`).set(...bearer(buyerA))).body
        .find((x: any) => x.name === `1C ${tag}`);
      const months = Array.from({ length: 12 }, (_, i) => ({
        month: `${YEAR}-${String(i + 1).padStart(2, '0')}`, shareBp: i === 0 ? 5000 : i === 1 ? 5000 : 0,
      }));
      await http().put(`/budgets/${b.id}/phasing`).set(...bearer(buyerA)).send({ months }).expect(200);

      const csv = (await http().get(`/budgets/export/1c?year=${YEAR}`).set(...bearer(buyerA)).expect(200)).text;
      const mine = csv.trim().split('\r\n').slice(1).filter((r) => r.includes(`1C ${tag}`));
      const amount = (row: string) => Number(row.split(';')[7].replace(/"/g, ''));
      expect(amount(mine[0])).toBe(50);
      expect(amount(mine[1])).toBe(50);
      expect(amount(mine[5])).toBe(0);
    });

    it('a plain user cannot pull the whole plan out of the system', async () => {
      const tok = (await http().post('/auth/login')
        .send({ email: `bu-${tag}@t.test`, password: 'password123' }).expect(201)).body.accessToken;
      await http().get('/budgets/export/1c').set(...bearer(tok)).expect(403);
});
  });
});
