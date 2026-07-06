import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';

// Spend analytics: "spend" = ACCEPTED POs only; the monthly series is zero-filled over
// 12 months; top suppliers rank by accepted volume; everything is RLS-scoped per buyer.
describe('spend analytics (API e2e)', () => {
  let app: INestApplication;
  let db: Client;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ['Authorization', `Bearer ${t}`] as [string, string];
  let buyer: string, buyerB: string, supplier: string, supplierOrg: string;
  let poId: string;

  beforeAll(async () => {
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
    ({ token: buyer } = await reg('/auth/register/buyer', `Ana Buyer ${tag}`, `ab-${tag}@t.test`));
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
      await http().post(`/requests/${req.body.id}/approve`).set(...bearer(buyer)).expect(201);
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
});
