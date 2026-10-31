import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { PAID_BASES } from '@leadprocure/shared';
import { AppModule } from '../src/app.module';
import { addApprover } from './helpers';

// Two endpoints report settled invoices and deliberately report DIFFERENT numbers.
// PAID_BASES in @leadprocure/shared states both definitions; this suite pins them against
// each other on ONE fixture, so neither can quietly drift into the other:
//
//   'invoice_ledger'     GET /dashboard/spend-analytics → invoices.paidMinor
//                        every invoice recorded in the window, dated by the invoice, with
//                        no budget consulted and no question asked about the order
//   'budget_obligation'  GET /budgets/rollup → paidMinor
//                        settlement of obligations the budget engine still counts, dated
//                        by the obligation
//
// The two consequences a finance reader actually hits are the two cases below: a paid
// invoice on a withdrawn order appears on one page and not the other, and an invoice
// recorded in a month other than its obligation's falls in a different month on each.
describe('paid: the invoice ledger and plan settlement are different measures', () => {
  let app: INestApplication, db: Client;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ['Authorization', `Bearer ${token}`] as [string, string];
  let buyer: string, approver: string, supplier: string, supplierOrg: string, dep: string;

  const rollup = async (query: Record<string, unknown>) =>
    (await http().get('/budgets/rollup').query(query).set(...bearer(buyer)).expect(200)).body as any[];
  const row = (rows: any[], id: string | null) => {
    const found = rows.find((r: any) => r.departmentId === id);
    expect(found).toBeTruthy();
    return found;
  };
  // One month of the invoice ledger. 'YYYY-MM' on both ends; the page sends the
  // 'YYYY-MM-01' form of the same month, and monthStart() accepts either.
  const ledger = async (month: string) =>
    (await http().get('/dashboard/spend-analytics').query({ from: month, to: month, currency: 'AZN' })
      .set(...bearer(buyer)).expect(200)).body.invoices as any;

  const budget = async (departmentId: string | null, year: number, category: string, month?: number) => {
    const created = await http().post('/budgets').set(...bearer(buyer)).send({
      name: `Basis ${tag} ${departmentId ?? 'org'} ${year} ${category} ${month ?? 'year'}`, category,
      ...(departmentId ? { departmentId } : {}),
      periodYear: year, periodType: month ? 'MONTH' : 'YEAR',
      ...(month ? { periodMonth: month } : {}), amountMinor: 100_000_000,
    }).expect(201);
    await http().post(`/budgets/${created.body.id}/submit`).set(...bearer(buyer)).expect(201);
    await http().post(`/budgets/${created.body.id}/approve`).set(...bearer(approver)).expect(201);
  };

  const deliver = async (poId: string, poItemId: string) => {
    await http().post(`/orders/${poId}/status`).set(...bearer(buyer)).send({ status: 'ISSUED' }).expect(201);
    for (const status of ['CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED']) {
      await http().post(`/orders/${poId}/status`).set(...bearer(supplier)).send({ status }).expect(201);
    }
    await http().post(`/orders/${poId}/receipts`).set(...bearer(buyer))
      .send({ items: [{ poItemId, qty: 1 }] }).expect(201);
  };

  // A real approved request → order → receipt → invoice → payment, with the obligation and
  // the invoice deliberately recorded in DIFFERENT months. Only those two timestamps are
  // moved, through the fixture owner connection; the order is dated far outside every
  // window under test so it cannot pick a period for either page.
  const divergentMonths = async (
    amount: number, approvedAt: string, recordedAt: string,
    vatRateBp = 0, vatMode: 'EXCLUSIVE' | 'INCLUSIVE' = 'EXCLUSIVE',
  ) => {
    const req = (await http().post('/requests').set(...bearer(buyer)).send({
      title: `Basis divergent ${tag}`, departmentId: dep, vatMode,
      items: [{ name: 'Paper', qty: 1, estUnitPriceMinor: amount, vatRateBp }],
    }).expect(201)).body;
    await http().post(`/requests/${req.id}/submit`).set(...bearer(buyer)).expect(201);
    await http().post(`/requests/${req.id}/approve`).set(...bearer(approver)).expect(201);
    const po = (await http().post(`/orders/direct/from-request/${req.id}`).set(...bearer(buyer))
      .send({ supplierOrgId: supplierOrg }).expect(201)).body;
    await deliver(po.id, po.items[0].id);
    const inv = (await http().post(`/invoices/from-po/${po.id}`).set(...bearer(supplier))
      .send({ items: [{ poItemId: po.items[0].id, qty: 1, unitPriceMinor: amount }] }).expect(201)).body;
    expect(inv.status).toBe('MATCHED');
    await http().post(`/invoices/${inv.id}/approve`).set(...bearer(buyer)).expect(201);
    await http().post(`/invoices/${inv.id}/pay`).set(...bearer(buyer)).expect(201);
    await db.query('UPDATE procurement_requests SET approved_at = $2 WHERE id = $1', [req.id, approvedAt]);
    await db.query("UPDATE purchase_orders SET issued_at = '2045-01-01T00:00:00Z', created_at = '2045-01-01T00:00:00Z' WHERE id = $1", [po.id]);
    await db.query('UPDATE invoices SET created_at = $2 WHERE id = $1', [inv.id, recordedAt]);
  };

  // Paid in advance on a catalog call-off, then the order withdrawn. MATCHED_CTE drops such
  // an order from both of its branches, so no plan carries it and the unbudgeted report
  // does not list it either — but the cash left the organisation all the same. Invoiced
  // with nothing received, so it is DISPUTED and payment takes a written override.
  const withdrawnAfterPaying = async (amount: number, orderedAt: string, recordedAt: string) => {
    const cat = (await http().post('/catalogs').set(...bearer(buyer))
      .send({ supplierOrgId: supplierOrg, title: `Basis call-off ${tag}`, currency: 'AZN' }).expect(201)).body;
    const item = (await http().post(`/catalogs/${cat.id}/items`).set(...bearer(buyer))
      .send({ name: 'Paper', unitPriceMinor: amount, vatRateBp: 0 }).expect(201)).body.items[0];
    await http().post(`/catalogs/${cat.id}/activate`).set(...bearer(buyer)).expect(201);
    const order = (await http().post(`/catalogs/${cat.id}/order`).set(...bearer(buyer))
      .send({ items: [{ catalogItemId: item.id, qty: 1 }] }).expect(201)).body;
    const po = (await http().get(`/orders/${order.id}`).set(...bearer(buyer)).expect(200)).body;
    expect(po.department_id ?? null).toBeNull(); // no request, so no department and no category
    await http().post(`/orders/${po.id}/status`).set(...bearer(buyer)).send({ status: 'ISSUED' }).expect(201);
    const inv = (await http().post(`/invoices/from-po/${po.id}`).set(...bearer(supplier))
      .send({ items: [{ poItemId: po.items[0].id, qty: 1, unitPriceMinor: amount }] }).expect(201)).body;
    expect(inv.status).toBe('DISPUTED');
    await http().post(`/invoices/${inv.id}/approve`).set(...bearer(buyer))
      .send({ reason: 'Paid in advance, order withdrawn afterwards' }).expect(201);
    await http().post(`/invoices/${inv.id}/pay`).set(...bearer(buyer)).expect(201);
    await http().post(`/orders/${po.id}/status`).set(...bearer(buyer)).send({ status: 'CANCELLED' }).expect(201);
    expect((await http().get(`/invoices/${inv.id}`).set(...bearer(buyer)).expect(200)).body.status).toBe('PAID');
    await db.query('UPDATE purchase_orders SET issued_at = $2, created_at = $2 WHERE id = $1', [po.id, orderedAt]);
    await db.query('UPDATE invoices SET created_at = $2 WHERE id = $1', [inv.id, recordedAt]);
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
      legalName: `Basis ${suffix} ${tag}`, email: `basis-${suffix}-${tag}@t.test`, password: 'password123', fullName: suffix,
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
    dep = (await http().post('/departments').set(...bearer(buyer)).send({ code: `D-${tag}` }).expect(201)).body.id;
    // The plan that carries the 2043 obligation, plus one monthly plan either side of it.
    // The monthly pair claims another category, so it only supplies a period window — the
    // department rule the rollup reports — and never competes to carry the obligation.
    await budget(dep, 2043, '*');
    await budget(dep, 2043, 'MONTHLY', 3);
    await budget(dep, 2043, 'MONTHLY', 9);
    // A plan whose period covers the withdrawn call-off, so "0" below is the obligation
    // test talking and not a missing budget.
    await budget(null, 2044, '*');
    // Plans for the two VAT cases: an EXCLUSIVE order of 1000 and an INCLUSIVE one of 1180.
    await budget(dep, 2046, '*');
    await budget(dep, 2047, '*');
    await divergentMonths(5500, '2043-03-15T12:00:00Z', '2043-09-20T12:00:00Z');
    await withdrawnAfterPaying(4400, '2044-06-10T12:00:00Z', '2044-06-20T12:00:00Z');
    await divergentMonths(1000, '2046-05-15T12:00:00Z', '2046-05-20T12:00:00Z', 1800);
    await divergentMonths(1180, '2047-05-15T12:00:00Z', '2047-05-20T12:00:00Z', 1800, 'INCLUSIVE');
  }, 60000);

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM organizations WHERE legal_name LIKE $1', [`Basis %${tag}`]);
      await db.end();
    }
    if (app) await app.close();
  });

  it('declares which settlement measure each endpoint reports', async () => {
    // The pages build their labels from these names, so a rename here is a visible change
    // on screen rather than a silent one.
    expect(PAID_BASES).toEqual(['invoice_ledger', 'budget_obligation']);
    const invoices = await ledger('2043-09');
    expect(invoices.basis).toBe('invoice_ledger');
    // The page-level dateBasis describes the purchase-order panels; this block does not
    // follow it, and says so rather than letting the page assume.
    expect(invoices.dateBasis).toBe('invoice_created_at');
    const rows = await rollup({ year: 2043, periodType: 'YEAR' });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.paidBasis).toBe('budget_obligation');
    // Two different members of the one union: neither endpoint may claim the other's.
    expect(PAID_BASES).toContain(invoices.basis);
    expect(PAID_BASES).toContain(rows[0].paidBasis);
    expect(invoices.basis).not.toBe(rows[0].paidBasis);
  });

  it('keeps cash paid on a withdrawn order in the invoice ledger', async () => {
    // The order is gone; the money is not. An accounts-payable view that dropped this
    // would hide exactly the leak it exists to show.
    const invoices = await ledger('2044-06');
    expect(invoices.paidMinor).toBe(4400);
    expect(invoices.paidCount).toBe(1);
    expect(invoices.outstandingMinor).toBe(0);
  });

  it('keeps the same settlement off every plan, because no plan still carries it', async () => {
    const rows = await rollup({ year: 2044, periodType: 'YEAR' });
    // A plan covers the period, so this is the obligation rule answering, not a gap.
    expect(row(rows, null).usedMinor).toBe(0);
    expect(row(rows, null).paidMinor).toBe(0);
    // Nor is the obligation reported as unbudgeted spend: there is no obligation left.
    expect((await http().get('/budgets/unbudgeted').query({ from: '2044-01-01', to: '2044-12-31' })
      .set(...bearer(buyer)).expect(200)).body).toEqual([]);
  });

  it('reports settlement beside the commitment it settles, in the same plan period', async () => {
    const rows = await rollup({ year: 2043, periodType: 'YEAR' });
    expect(row(rows, dep).actualMinor).toBe(5500);
    expect(row(rows, dep).paidMinor).toBe(5500);
    // Beside, never summed in: an invoice settles an order already counted as actual.
    expect(row(rows, dep).usedMinor).toBe(5500);
    // A department row is credited because the obligation's day falls in its OWN plan
    // period, not because that plan carried it — here the two happen to agree. Where they
    // part (a department plan for another category, so the org-wide plan carried it) is
    // pinned by the 2036 case in budget-paid-period.e2e-spec.ts, and the label on screen
    // is worded for the looser rule because of it.
  });

  it('settles an EXCLUSIVE order on its own net basis, while the ledger stays gross', async () => {
    // The default EXCLUSIVE vat_mode makes an order's total the raw sum of its lines, i.e.
    // NET, while the invoice's gross carries the VAT. The plan figure follows the ORDER, so
    // it lands on 1000 beside an actual of 1000 instead of the 1180 it used to report in
    // the same table row. The ledger is unchanged: an accounts-payable view reports the
    // invoice as billed. This is the pair that pins the two bases apart on VAT.
    const rows = await rollup({ year: 2046, periodType: 'YEAR' });
    expect(row(rows, dep).actualMinor).toBe(1000);
    expect(row(rows, dep).paidMinor).toBe(1000);
    expect((await ledger('2046-05')).paidMinor).toBe(1180);
  });

  it('settles an INCLUSIVE order on its gross, because that is what its order total is', async () => {
    // INCLUSIVE puts the VAT inside the line, so the order's total IS the gross and the
    // two bases coincide — the CASE must pick gross here, not net, or an INCLUSIVE order
    // would report 1000 against an actual of 1180 and the defect would simply change sign.
    const rows = await rollup({ year: 2047, periodType: 'YEAR' });
    expect(row(rows, dep).actualMinor).toBe(1180);
    expect(row(rows, dep).paidMinor).toBe(1180);
    expect((await ledger('2047-05')).paidMinor).toBe(1180);
  });

  it('puts one settlement in different months on the two pages, by design', async () => {
    // Budgets date it by the obligation — the request was approved in March.
    expect(row(await rollup({ year: 2043, periodType: 'MONTH', from: '2043-03-01', to: '2043-03-31' }), dep).paidMinor).toBe(5500);
    expect(row(await rollup({ year: 2043, periodType: 'MONTH', from: '2043-09-01', to: '2043-09-30' }), dep).paidMinor).toBe(0);
    // The ledger dates it by the invoice — recorded in September.
    expect((await ledger('2043-09')).paidMinor).toBe(5500);
    expect((await ledger('2043-03')).paidMinor).toBe(0);
  });
});
