import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { addApprover } from './helpers';

// Real authenticated procurement -> receipt -> invoice -> recorded settlement.
// Only historical obligation timestamps are changed through the fixture owner connection.
describe('budget rollup: settled obligation periods and department isolation', () => {
  let app: INestApplication, db: Client;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ['Authorization', `Bearer ${token}`] as [string, string];
  let buyer: string, other: string, approver: string, supplier: string, supplierOrg: string, user: string;
  let parent: string, child: string, sibling: string;
  const invoices: string[] = [];
  let before: any[];
  const rollup = async (query: Record<string, unknown>, token = buyer) =>
    (await http().get('/budgets/rollup').query(query).set(...bearer(token)).expect(200)).body as any[];
  const row = (rows: any[], id: string | null) => {
    const found = rows.find((r: any) => r.departmentId === id);
    expect(found).toBeTruthy();
    return found;
  };
  // departmentId null = the org-wide ceiling (no department), MATCHED_CTE's last resort.
  const budget = async (departmentId: string | null, year: number, month?: number) => {
    const created = await http().post('/budgets').set(...bearer(buyer)).send({
      name: `Paid ${tag} ${departmentId ?? 'org'} ${year} ${month ?? 'year'}`, category: month ? 'MONTHLY' : '*',
      ...(departmentId ? { departmentId } : {}),
      periodYear: year, periodType: month ? 'MONTH' : 'YEAR', ...(month ? { periodMonth: month } : {}), amountMinor: 100_000_000,
    }).expect(201);
    await http().post(`/budgets/${created.body.id}/submit`).set(...bearer(buyer)).expect(201);
    await http().post(`/budgets/${created.body.id}/approve`).set(...bearer(approver)).expect(201);
  };
  const invoice = async (amount: number, departmentId: string | null, date: string, currency = 'AZN', catalog = false, noIssue = false) => {
    let po: any;
    let requestId: string | undefined;
    if (catalog) {
      const cat = (await http().post('/catalogs').set(...bearer(buyer))
        .send({ supplierOrgId: supplierOrg, title: `Paid catalog ${tag} ${amount}`, currency }).expect(201)).body;
      const item = (await http().post(`/catalogs/${cat.id}/items`).set(...bearer(buyer))
        .send({ name: 'Paper', unitPriceMinor: amount, vatRateBp: 0 }).expect(201)).body.items[0];
      await http().post(`/catalogs/${cat.id}/activate`).set(...bearer(buyer)).expect(201);
      const order = (await http().post(`/catalogs/${cat.id}/order`).set(...bearer(buyer))
        .send({ departmentId, items: [{ catalogItemId: item.id, qty: 1 }] }).expect(201)).body;
      po = (await http().get(`/orders/${order.id}`).set(...bearer(buyer)).expect(200)).body;
    } else {
      const req = (await http().post('/requests').set(...bearer(buyer)).send({
        title: `Paid request ${tag} ${amount}`, departmentId,
        items: [{ name: 'Paper', qty: 1, estUnitPriceMinor: amount, vatRateBp: 0 }],
      }).expect(201)).body;
      requestId = req.id;
      await http().post(`/requests/${req.id}/submit`).set(...bearer(buyer)).expect(201);
      await http().post(`/requests/${req.id}/approve`).set(...bearer(approver)).expect(201);
      po = (await http().post(`/orders/direct/from-request/${req.id}`).set(...bearer(buyer))
        .send({ supplierOrgId: supplierOrg }).expect(201)).body;
    }
    await http().post(`/orders/${po.id}/status`).set(...bearer(buyer)).send({ status: 'ISSUED' }).expect(201);
    for (const status of ['CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED']) {
      await http().post(`/orders/${po.id}/status`).set(...bearer(supplier)).send({ status }).expect(201);
    }
    await http().post(`/orders/${po.id}/receipts`).set(...bearer(buyer))
      .send({ items: [{ poItemId: po.items[0].id, qty: 1 }] }).expect(201);
    const inv = (await http().post(`/invoices/from-po/${po.id}`).set(...bearer(supplier))
      .send({ items: [{ poItemId: po.items[0].id, qty: 1, unitPriceMinor: amount }] }).expect(201)).body;
    expect(inv.status).toBe('MATCHED');
    expect(Number(inv.gross_minor)).toBe(amount);
    await http().post(`/invoices/${inv.id}/approve`).set(...bearer(buyer)).expect(201);
    invoices.push(inv.id);
    if (requestId) {
      await db.query('UPDATE procurement_requests SET approved_at = $2 WHERE id = $1', [requestId, date]);
      // Deliberately different from approval: invoice/PO creation must not select the period.
      await db.query("UPDATE purchase_orders SET issued_at = '2036-01-01T00:00:00Z', created_at = '2036-01-01T00:00:00Z' WHERE id = $1", [po.id]);
    } else {
      await db.query('UPDATE purchase_orders SET issued_at = $2, created_at = $3 WHERE id = $1',
        [po.id, noIssue ? null : date, noIssue ? date : '2035-01-01T00:00:00Z']);
    }
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    db = new Client({ connectionString: process.env.DATABASE_OWNER_URL ?? process.env.DATABASE_URL });
    await db.connect();
    const register = async (kind: string, suffix: string) => (await http().post(`/auth/register/${kind}`).send({
      legalName: `Paid ${suffix} ${tag}`, email: `paid-${suffix}-${tag}@t.test`, password: 'password123', fullName: suffix,
    }).expect(201)).body;
    buyer = (await register('buyer', 'buyer')).accessToken;
    other = (await register('buyer', 'other')).accessToken;
    const sup = await register('supplier', 'supplier');
    supplier = sup.accessToken; supplierOrg = sup.org.id;
    approver = await addApprover(app, buyer, tag);
    await http().put('/requests/method-policies').set(...bearer(buyer))
      .send({ policies: [{ category: '*', minAmountMinor: 0, maxAmountMinor: null, method: 'DIRECT' }] }).expect(200);
    await http().post(`/suppliers/${supplierOrg}/invite`).set(...bearer(buyer)).expect(201);
    const rel = (await http().get('/suppliers').set(...bearer(buyer)).expect(200)).body
      .find((r: any) => r.supplier_org_id === supplierOrg);
    await http().post(`/suppliers/relationships/${rel.id}/status`).set(...bearer(buyer)).send({ status: 'APPROVED' }).expect(201);
    parent = (await http().post('/departments').set(...bearer(buyer)).send({ code: `P-${tag}` }).expect(201)).body.id;
    child = (await http().post('/departments').set(...bearer(buyer)).send({ code: `A-${tag}`, parentId: parent }).expect(201)).body.id;
    sibling = (await http().post('/departments').set(...bearer(buyer)).send({ code: `B-${tag}`, parentId: parent }).expect(201)).body.id;
    await budget(child, 2034); await budget(child, 2035);
    await budget(child, 2034, 1); await budget(child, 2034, 3);
    await budget(sibling, 2034); await budget(sibling, 2034, 1);
    await budget(null, 2034); // org-wide: the only plan covering the parent department
    await invoice(1100, child, '2034-01-31T23:59:59.999Z');
    await invoice(2200, child, '2034-02-01T00:00:00Z');
    await invoice(3300, child, '2034-03-31T23:59:59.999Z');
    await invoice(4400, child, '2034-12-31T23:59:59.999Z');
    await invoice(5500, child, '2035-01-01T00:00:00Z');
    await invoice(6600, child, '2034-01-15T00:00:00Z', 'EUR', true);
    await invoice(7700, sibling, '2034-01-15T00:00:00Z');
    await invoice(8800, sibling, '2034-03-15T00:00:00Z'); // sibling has no March plan
    await invoice(900, child, '2034-03-15T00:00:00Z', 'AZN', true);
    await invoice(1000, child, '2034-01-15T00:00:00Z', 'AZN', true, true);
    // parent has no budget of its own, so only the org-wide plan carries this one
    await invoice(1300, parent, '2034-06-15T00:00:00Z');
    before = await rollup({ year: 2034, periodType: 'YEAR' });
    for (const id of invoices) await http().post(`/invoices/${id}/pay`).set(...bearer(buyer)).expect(201);
    const email = `paid-user-${tag}@t.test`;
    await http().post('/settings/users').set(...bearer(buyer))
      .send({ email, fullName: 'Scoped user', password: 'password123', role: 'BUYER_USER' }).expect(201);
    const userId = (await http().get('/settings/users').set(...bearer(buyer)).expect(200)).body.find((u: any) => u.email === email).id;
    await http().post(`/settings/users/${userId}/department`).set(...bearer(buyer)).send({ departmentId: child }).expect(201);
    user = (await http().post('/auth/login').send({ email, password: 'password123' }).expect(201)).body.accessToken;
  }, 60000);

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM organizations WHERE legal_name LIKE $1', [`Paid %${tag}`]);
      await db.end();
    }
    if (app) await app.close();
  });

  it('limits annual settlement by obligation year and currency without inflating spend', async () => {
    const current = await rollup({ year: 2034, periodType: 'YEAR' });
    expect(row(current, child).paidMinor).toBe(12900);
    expect(row(current, sibling).paidMinor).toBe(16500);
    expect(row(current, parent).paidMinor).toBe(29400);
    expect(row(await rollup({ year: 2035, periodType: 'YEAR' }), child).paidMinor).toBe(5500);
    for (const id of [child, sibling, parent]) {
      expect(row(before, id).paidMinor).toBe(0);
      for (const field of ['actualMinor', 'committedMinor', 'usedMinor']) expect(row(current, id)[field]).toBe(row(before, id)[field]);
    }
  });

  it('uses a union of selected months, excluding gaps and counting overlapping periods once', async () => {
    const months = await rollup({ year: 2034, periodType: 'MONTH' });
    expect(row(months, child).paidMinor).toBe(6300);
    expect(row(months, sibling).paidMinor).toBe(7700);
    expect(row(months, parent).paidMinor).toBe(14000); // sibling March cannot borrow child's March window
    // With annual + monthly budgets selected, the same invoice still counts only once.
    expect(row(await rollup({ year: 2034 }), child).paidMinor).toBe(12900);
  });

  it('keeps the last UTC day, excludes the next midnight and uses request approval', async () => {
    const january = await rollup({ year: 2034, periodType: 'MONTH', from: '2034-01-01', to: '2034-01-31' });
    expect(row(january, child).paidMinor).toBe(2100); // 1100 Jan31 approval + 1000 catalog creation
    expect(row(january, parent).paidMinor).toBe(9800);
  });

  it('dates requestless catalog settlement by issue, falling back to creation', async () => {
    const march = await rollup({ year: 2034, periodType: 'MONTH', from: '2034-03-01', to: '2034-03-31' });
    expect(row(march, child).paidMinor).toBe(4200); // 3300 request approval + 900 catalog issue, not its 2035 creation
  });

  it('settles against the org-wide plan when no department in the chain has a budget', async () => {
    const current = await rollup({ year: 2034, periodType: 'YEAR' });
    // The same spend is this plan's commitment, so reporting 0 paid beside it was wrong.
    expect(row(current, null).usedMinor).toBe(1300);
    expect(row(current, null).paidMinor).toBe(1300);
    expect(row(before, null).paidMinor).toBe(0);
    // and it is counted once: the department chain must not also absorb it
    expect(row(current, parent).paidMinor).toBe(29400);
    expect(row(current, child).paidMinor).toBe(12900);
    expect(row(current, sibling).paidMinor).toBe(16500);
  });

  it('does not leak sibling settlement through a shared ancestor or another buyer', async () => {
    const scoped = await rollup({ year: 2034, periodType: 'YEAR' }, user);
    expect(scoped.map((r: any) => r.departmentId).sort()).toEqual([child, parent].sort());
    expect(row(scoped, child).paidMinor).toBe(12900);
    expect(row(scoped, parent).paidMinor).toBe(12900);
    expect(await rollup({ year: 2034 }, other)).toEqual([]);
  });
});

// The org-wide plan (no department) is MATCHED_CTE's last resort, so its settlement follows
// the same test as its commitment: the invoice's OWN department has no plan for the day —
// an ancestor's plan does not stand in, because matching never walks up the tree — and the
// plan's category claims it. Its own orgs and departments, so the matrix above is untouched.
describe('budget rollup: settlement of the org-wide plan', () => {
  let app: INestApplication, db: Client;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ['Authorization', `Bearer ${token}`] as [string, string];
  let buyer: string, approver: string, supplier: string, supplierOrg: string;
  let top: string, mid: string, leaf: string;
  const rollup = async (query: Record<string, unknown>) =>
    (await http().get('/budgets/rollup').query(query).set(...bearer(buyer)).expect(200)).body as any[];
  const dep = (rows: any[], id: string | null) => {
    const found = rows.find((r: any) => r.departmentId === id);
    expect(found).toBeTruthy();
    return found;
  };
  const budget = async (departmentId: string | null, year: number, category: string) => {
    const created = await http().post('/budgets').set(...bearer(buyer)).send({
      name: `Org ${tag} ${departmentId ?? 'org'} ${year} ${category}`, category,
      ...(departmentId ? { departmentId } : {}),
      periodYear: year, periodType: 'YEAR', amountMinor: 100_000_000,
    }).expect(201);
    await http().post(`/budgets/${created.body.id}/submit`).set(...bearer(buyer)).expect(201);
    await http().post(`/budgets/${created.body.id}/approve`).set(...bearer(approver)).expect(201);
  };
  // Real procurement through to a settled invoice. Only the obligation date is moved, and
  // the order is dated far outside every selection so it cannot pick the period instead.
  const settled = async (amount: number, departmentId: string, category: string, date: string) => {
    const req = (await http().post('/requests').set(...bearer(buyer)).send({
      title: `Org settle ${tag} ${amount}`, departmentId, category,
      items: [{ name: 'Paper', qty: 1, estUnitPriceMinor: amount, vatRateBp: 0 }],
    }).expect(201)).body;
    await http().post(`/requests/${req.id}/submit`).set(...bearer(buyer)).expect(201);
    await http().post(`/requests/${req.id}/approve`).set(...bearer(approver)).expect(201);
    const po = (await http().post(`/orders/direct/from-request/${req.id}`).set(...bearer(buyer))
      .send({ supplierOrgId: supplierOrg }).expect(201)).body;
    await http().post(`/orders/${po.id}/status`).set(...bearer(buyer)).send({ status: 'ISSUED' }).expect(201);
    for (const status of ['CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED']) {
      await http().post(`/orders/${po.id}/status`).set(...bearer(supplier)).send({ status }).expect(201);
    }
    await http().post(`/orders/${po.id}/receipts`).set(...bearer(buyer))
      .send({ items: [{ poItemId: po.items[0].id, qty: 1 }] }).expect(201);
    const inv = (await http().post(`/invoices/from-po/${po.id}`).set(...bearer(supplier))
      .send({ items: [{ poItemId: po.items[0].id, qty: 1, unitPriceMinor: amount }] }).expect(201)).body;
    expect(inv.status).toBe('MATCHED');
    await http().post(`/invoices/${inv.id}/approve`).set(...bearer(buyer)).expect(201);
    await http().post(`/invoices/${inv.id}/pay`).set(...bearer(buyer)).expect(201);
    await db.query('UPDATE procurement_requests SET approved_at = $2 WHERE id = $1', [req.id, date]);
    await db.query("UPDATE purchase_orders SET issued_at = '2040-01-01T00:00:00Z', created_at = '2040-01-01T00:00:00Z' WHERE id = $1", [po.id]);
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    db = new Client({ connectionString: process.env.DATABASE_OWNER_URL ?? process.env.DATABASE_URL });
    await db.connect();
    const register = async (kind: string, suffix: string) => (await http().post(`/auth/register/${kind}`).send({
      legalName: `Org ${suffix} ${tag}`, email: `org-${suffix}-${tag}@t.test`, password: 'password123', fullName: suffix,
    }).expect(201)).body;
    buyer = (await register('buyer', 'buyer')).accessToken;
    const sup = await register('supplier', 'supplier');
    supplier = sup.accessToken; supplierOrg = sup.org.id;
    approver = await addApprover(app, buyer, tag);
    await http().put('/requests/method-policies').set(...bearer(buyer))
      .send({ policies: [{ category: '*', minAmountMinor: 0, maxAmountMinor: null, method: 'DIRECT' }] }).expect(200);
    await http().post(`/suppliers/${supplierOrg}/invite`).set(...bearer(buyer)).expect(201);
    const rel = (await http().get('/suppliers').set(...bearer(buyer)).expect(200)).body
      .find((r: any) => r.supplier_org_id === supplierOrg);
    await http().post(`/suppliers/relationships/${rel.id}/status`).set(...bearer(buyer)).send({ status: 'APPROVED' }).expect(201);
    top = (await http().post('/departments').set(...bearer(buyer)).send({ code: `T-${tag}` }).expect(201)).body.id;
    mid = (await http().post('/departments').set(...bearer(buyer)).send({ code: `M-${tag}`, parentId: top }).expect(201)).body.id;
    leaf = (await http().post('/departments').set(...bearer(buyer)).send({ code: `L-${tag}`, parentId: mid }).expect(201)).body.id;
    await budget(mid, 2034, '*');       // an ancestor of leaf has a plan; leaf itself has none
    await budget(null, 2034, '*');      // and this is the plan leaf's request actually matched
    await budget(null, 2035, 'FACILITIES'); // claims only its own category
    await settled(1300, leaf, '*', '2034-06-15T00:00:00Z');
    await settled(2600, top, 'IT', '2035-06-15T00:00:00Z');
  }, 60000);

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM organizations WHERE legal_name LIKE $1', [`Org %${tag}`]);
      await db.end();
    }
    if (app) await app.close();
  });

  it('reports settlement on the plan that carried the commitment, not only on an ancestor', async () => {
    const rows = await rollup({ year: 2034, periodType: 'YEAR' });
    // leaf has no plan, so MATCHED_CTE charged its commitment to the org-wide plan; the
    // settlement now stands beside it instead of reading 0.
    expect(dep(rows, null).usedMinor).toBe(1300);
    expect(dep(rows, null).paidMinor).toBe(1300);
    // The department tree is unchanged: an ancestor whose own period covers the day still
    // reports its units' settlement.
    expect(dep(rows, mid).paidMinor).toBe(1300);
    expect(dep(rows, top).paidMinor).toBe(1300);
    expect(rows.find((r: any) => r.departmentId === leaf)).toBeFalsy();
  });

  it('leaves an obligation the org-wide plan never claimed outside it', async () => {
    const rows = await rollup({ year: 2035, periodType: 'YEAR' });
    expect(dep(rows, null).usedMinor).toBe(0);
    expect(dep(rows, null).paidMinor).toBe(0);
    const outside = (await http().get('/budgets/unbudgeted').query({ from: '2035-01-01', to: '2035-12-31' })
      .set(...bearer(buyer)).expect(200)).body;
    expect(outside.map((r: any) => [r.category, r.amountMinor])).toEqual([['IT', 2600]]);
  });
});
