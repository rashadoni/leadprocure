import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { addApprover } from './helpers';

// Spend analytics: "spend" = ACCEPTED POs only; the monthly series is zero-filled over
// 12 months; top suppliers rank by accepted volume; everything is RLS-scoped per buyer.
describe('spend analytics (API e2e)', () => {
  let app: INestApplication;
  let db: Client;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ['Authorization', `Bearer ${t}`] as [string, string];
  let buyer: string, buyerB: string, supplier: string, supplierOrg: string;
  let approver: string;
  let poId: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    // owner connection: the department-split test re-tags a PO, which RLS would silently
    // drop on the app_user role (no request context → default deny).
    db = new Client({ connectionString: process.env.DATABASE_OWNER_URL ?? process.env.DATABASE_URL });
    await db.connect();
    const reg = async (path: string, name: string, email: string) => {
      const r = await http().post(path).send({ legalName: name, email, password: 'password123', fullName: name }).expect(201);
      return { token: r.body.accessToken as string, org: r.body.org.id as string };
    };
    ({ token: buyer } = await reg('/auth/register/buyer', `Ana Buyer ${tag}`, `ab-${tag}@t.test`));
    approver = await addApprover(app, buyer, tag);
    ({ token: buyerB } = await reg('/auth/register/buyer', `Ana BuyerB ${tag}`, `ab2-${tag}@t.test`));
    ({ token: supplier, org: supplierOrg } = await reg('/auth/register/supplier', `Ana Sup ${tag}`, `as-${tag}@t.test`));

    await http().post(`/suppliers/${supplierOrg}/invite`).set(...bearer(buyer)).expect(201);
    const reg2 = await http().get('/suppliers').set(...bearer(buyer)).expect(200);
    const relId = reg2.body.find((r: any) => r.supplier_org_id === supplierOrg).id;
    await http().post(`/suppliers/relationships/${relId}/status`).set(...bearer(buyer)).send({ status: 'APPROVED' }).expect(201);
    await http().put('/requests/method-policies').set(...bearer(buyer))
      .send({ policies: [{ category: '*', minAmountMinor: 0, maxAmountMinor: null, method: 'DIRECT' }] }).expect(200);

    // one PO driven to ACCEPTED (counts as spend), one left ISSUED (must not count)
    const mkPo = async (title: string) => {
      const req = await http().post('/requests').set(...bearer(buyer))
        .send({ title, items: [{ name: 'Widget', qty: 2, estUnitPriceMinor: 150_000 }] }).expect(201);
      await http().post(`/requests/${req.body.id}/submit`).set(...bearer(buyer)).expect(201);
      await http().post(`/requests/${req.body.id}/approve`).set(...bearer(approver)).expect(201);
      const po = await http().post(`/orders/direct/from-request/${req.body.id}`).set(...bearer(buyer))
        .send({ supplierOrgId: supplierOrg }).expect(201);
      await http().post(`/orders/${po.body.id}/status`).set(...bearer(buyer)).send({ status: 'ISSUED' }).expect(201);
      return po.body.id as string;
    };
    poId = await mkPo(`Ana accepted ${tag}`);
    for (const s of ['CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED']) {
      await http().post(`/orders/${poId}/status`).set(...bearer(supplier)).send({ status: s }).expect(201);
    }
    await http().post(`/orders/${poId}/status`).set(...bearer(buyer)).send({ status: 'ACCEPTED' }).expect(201);
    await mkPo(`Ana pending ${tag}`); // stays ISSUED — excluded from spend
  });

  afterAll(async () => {
    await db.query(`DELETE FROM organizations WHERE legal_name LIKE $1`, [`Ana %${tag}%`]);
    await db.end();
    await app.close();
  });

  it('suppliers cannot access buyer analytics (403)', async () => {
    await http().get('/dashboard/spend-analytics').set(...bearer(supplier)).expect(403);
  });

  it('returns a zero-filled 12-month series and counts only ACCEPTED POs', async () => {
    const res = await http().get('/dashboard/spend-analytics').set(...bearer(buyer)).expect(200);
    expect(res.body.monthly).toHaveLength(12);
    const thisMonth = new Date().toISOString().slice(0, 7);
    const current = res.body.monthly.find((m: any) => m.month === thisMonth);
    expect(current.totalMinor).toBe(300_000); // 2 × 150k, the ISSUED PO excluded
    const total = res.body.monthly.reduce((s: number, m: any) => s + m.totalMinor, 0);
    expect(total).toBe(300_000);
  });

  it('ranks top suppliers by accepted volume', async () => {
    const res = await http().get('/dashboard/spend-analytics').set(...bearer(buyer)).expect(200);
    expect(res.body.topSuppliers).toHaveLength(1);
    expect(res.body.topSuppliers[0].name).toBe(`Ana Sup ${tag}`);
    expect(res.body.topSuppliers[0].totalMinor).toBe(300_000);
    expect(res.body.topSuppliers[0].poCount).toBe(1);
  });

  it('direct (contract-less) POs land in the uncategorized bucket', async () => {
    const res = await http().get('/dashboard/spend-analytics').set(...bearer(buyer)).expect(200);
    expect(res.body.byCategory).toHaveLength(1);
    expect(res.body.byCategory[0].category).toBe('—');
    expect(res.body.byCategory[0].totalMinor).toBe(300_000);
  });

  // A direct PO has no contract → no event → no request, so the category split can only
  // call it "—". The department split reads the PO's own column and still knows whose
  // spend it is — that is the whole point of denormalizing it.
  it('spend by department keys off the order itself, not the request chain', async () => {
    const res = await http().get('/dashboard/spend-analytics').set(...bearer(buyer)).expect(200);
    expect(res.body.byDepartment).toHaveLength(1);
    expect(res.body.byDepartment[0].totalMinor).toBe(300_000);

    const dep = (await http().post('/departments').set(...bearer(buyer))
      .send({ code: `ANA-${tag}` }).expect(201)).body;
    await db.query(
      `UPDATE purchase_orders SET department_id = $1
       WHERE buyer_org_id = (SELECT buyer_org_id FROM departments WHERE id = $1)`,
      [dep.id],
    );
    const after = await http().get('/dashboard/spend-analytics').set(...bearer(buyer)).expect(200);
    expect(after.body.byDepartment[0].department).toBe(`ANA-${tag}`);
    expect(after.body.byDepartment[0].totalMinor).toBe(300_000);
    // the category split is unchanged: it never had a chain to walk
    expect(after.body.byCategory[0].category).toBe('—');
  });

  it('budget pace compares the share spent with the share of the period gone', async () => {
    const year = new Date().getUTCFullYear();
    const dep = (await http().get('/departments').set(...bearer(buyer))).body.find((d: any) => d.code === `ANA-${tag}`);
    await http().post('/budgets').set(...bearer(buyer))
      .send({ name: `Pace ${tag}`, departmentId: dep.id, periodYear: year, amountMinor: 1_000_000 }).expect(201);

    const rows = (await http().get('/budgets/rollup?current=1').set(...bearer(buyer)).expect(200)).body;
    const row = rows.find((r: any) => r.departmentCode === `ANA-${tag}`);
    expect(row).toBeTruthy();
    // the annual period contains today, so elapsed is strictly between the ends
    expect(row.elapsedPct).toBeGreaterThan(0);
    expect(row.elapsedPct).toBeLessThanOrEqual(100);
    expect(row.paceDeltaPct).toBe(Math.round((row.utilizationPct - row.elapsedPct) * 10) / 10);
  });

  it('a period that has not started yet reads 0% elapsed, never negative', async () => {
    const nextYear = new Date().getUTCFullYear() + 1;
    const dep = (await http().get('/departments').set(...bearer(buyer))).body.find((d: any) => d.code === `ANA-${tag}`);
    await http().post('/budgets').set(...bearer(buyer))
      .send({ name: `Future ${tag}`, departmentId: dep.id, periodYear: nextYear, amountMinor: 500_000 }).expect(201);

    const rows = (await http().get(`/budgets/rollup?year=${nextYear}`).set(...bearer(buyer)).expect(200)).body;
    const row = rows.find((r: any) => r.departmentCode === `ANA-${tag}`);
    expect(row.elapsedPct).toBe(0);
    expect(row.paceDeltaPct).toBe(0); // nothing spent, nothing elapsed
  });

  it('invoice block reports zero when nothing is invoiced', async () => {
    const res = await http().get('/dashboard/spend-analytics').set(...bearer(buyer)).expect(200);
    expect(res.body.invoices.paidMinor).toBe(0);
    expect(res.body.invoices.outstandingCount).toBe(0);
  });

  it("RLS isolation: buyer B sees zeros, not buyer A's spend", async () => {
    const res = await http().get('/dashboard/spend-analytics').set(...bearer(buyerB)).expect(200);
    expect(res.body.monthly.reduce((s: number, m: any) => s + m.totalMinor, 0)).toBe(0);
    expect(res.body.topSuppliers).toHaveLength(0);
    expect(res.body.byCategory).toHaveLength(0);
    expect(res.body.savings.events).toBe(0);
  });

  // ---- Year on year ---------------------------------------------------------------
  // "We spent 40k on fuel" is not a finding. "We spent 40k, against 25k last year" is.
  describe('year-on-year comparison', () => {
    it('every split carries the same window a year earlier', async () => {
      const res = await http().get('/dashboard/spend-analytics').set(...bearer(buyer)).expect(200);
      for (const row of [...res.body.byCategory, ...res.body.byDepartment]) {
        expect(row).toHaveProperty('prevTotalMinor');
        expect(row).toHaveProperty('deltaMinor');
        expect(row.deltaMinor).toBe(row.totalMinor - row.prevTotalMinor);
      }
      expect(res.body.monthly.every((m: any) => typeof m.prevTotalMinor === 'number')).toBe(true);
    });

    it('with nothing last year, the delta is the whole amount and the percentage is null', async () => {
      const res = await http().get('/dashboard/spend-analytics').set(...bearer(buyer)).expect(200);
      const dep = res.body.byDepartment.find((r: any) => r.totalMinor > 0);
      expect(dep.prevTotalMinor).toBe(0);
      expect(dep.deltaMinor).toBe(dep.totalMinor);
      expect(dep.deltaPct).toBeNull(); // growth from zero has no percentage, and faking one lies
    });

    it('a real prior year produces a real percentage', async () => {
      // backdate one accepted order by exactly a year, then read the same calendar window
      const thisMonth = new Date().toISOString().slice(0, 7);
      await db.query(
        `UPDATE purchase_orders SET created_at = created_at - interval '1 year'
         WHERE id = (SELECT id FROM purchase_orders WHERE status = 'ACCEPTED'
                     AND buyer_org_id = (SELECT id FROM organizations WHERE legal_name = $1) LIMIT 1)`,
        [`Ana Buyer ${tag}`],
      );
      const res = await http().get(`/dashboard/spend-analytics?from=${thisMonth}&to=${thisMonth}`)
        .set(...bearer(buyer)).expect(200);
      const dep = res.body.byDepartment.find((r: any) => r.prevTotalMinor > 0);
      expect(dep).toBeTruthy();
      expect(dep.prevTotalMinor).toBe(300_000);
      // The whole of this department's spend moved into last year, so this year reads zero.
      // The row must still come back: a department that stopped spending is the single most
      // useful thing a year-on-year view can show, and dropping it would hide exactly that.
      expect(dep.totalMinor).toBe(0);
      expect(dep.deltaMinor).toBe(-300_000);
      expect(dep.deltaPct).toBe(-100);
    });

    // The window above the page used to bound the chart and the category split, while the
    // department split quietly reported all time.
    it('the department split obeys the selected window', async () => {
      const longAgo = '2000-01';
      const res = await http().get(`/dashboard/spend-analytics?from=${longAgo}&to=${longAgo}`)
        .set(...bearer(buyer)).expect(200);
      expect(res.body.byDepartment.every((r: any) => r.totalMinor === 0)).toBe(true);
    });
  });
});
