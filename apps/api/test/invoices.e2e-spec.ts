import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';

// P2P: supplier invoices a received PO; the 3-way match (invoice ↔ PO ↔ receipt) drives
// MATCHED/DISPUTED; the buyer approves and pays.
describe('invoices + 3-way match', () => {
  let app: INestApplication;
  let db: Client;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ['Authorization', `Bearer ${t}`] as [string, string];

  let buyer: string, supplier: string, s2: string, supplierOrg: string;
  let poId: string, poItemId: string;

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
    ({ token: buyer } = await reg('/auth/register/buyer', `Inv Buyer ${tag}`, `ib-${tag}@t.test`));
    ({ token: supplier, org: supplierOrg } = await reg('/auth/register/supplier', `Inv Sup ${tag}`, `is-${tag}@t.test`));
    ({ token: s2 } = await reg('/auth/register/supplier', `Inv Sup2 ${tag}`, `is2-${tag}@t.test`));

    // approve supplier in the registry + DIRECT method → a direct PO
    await http().post(`/suppliers/${supplierOrg}/invite`).set(...bearer(buyer)).expect(201);
    const reg2 = await http().get('/suppliers').set(...bearer(buyer)).expect(200);
    const relId = reg2.body.find((r: any) => r.supplier_org_id === supplierOrg).id;
    await http().post(`/suppliers/relationships/${relId}/status`).set(...bearer(buyer)).send({ status: 'APPROVED' }).expect(201);
    await http().put('/requests/method-policies').set(...bearer(buyer))
      .send({ policies: [{ category: '*', minAmountMinor: 0, maxAmountMinor: null, method: 'DIRECT' }] }).expect(200);

    const req = await http().post('/requests').set(...bearer(buyer))
      .send({ title: `Inv ${tag}`, items: [{ name: 'Widget', qty: 10, estUnitPriceMinor: 100_000 }] }).expect(201);
    await http().post(`/requests/${req.body.id}/submit`).set(...bearer(buyer)).expect(201);
    await http().post(`/requests/${req.body.id}/approve`).set(...bearer(buyer)).expect(201);
    const po = await http().post(`/orders/direct/from-request/${req.body.id}`).set(...bearer(buyer)).send({ supplierOrgId: supplierOrg }).expect(201);
    poId = po.body.id;
    poItemId = po.body.items[0].id;

    // deliver + fully receive so the invoice can match
    await http().post(`/orders/${poId}/status`).set(...bearer(buyer)).send({ status: 'ISSUED' }).expect(201);
    for (const s of ['CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED']) {
      await http().post(`/orders/${poId}/status`).set(...bearer(supplier)).send({ status: s }).expect(201);
    }
    await http().post(`/orders/${poId}/receipts`).set(...bearer(buyer)).send({ items: [{ poItemId, qty: 10 }] }).expect(201);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM organizations WHERE legal_name LIKE $1`, [`Inv %${tag}%`]);
    await db.end();
    await app.close();
  });

  it('an invoice at PO price for received qty is MATCHED', async () => {
    const inv = await http().post(`/invoices/from-po/${poId}`).set(...bearer(supplier))
      .send({ items: [{ poItemId, qty: 10, unitPriceMinor: 100_000 }] }).expect(201);
    expect(inv.body.status).toBe('MATCHED');
    expect(Number(inv.body.net_minor)).toBe(1_000_000);
    expect(Number(inv.body.vat_minor)).toBe(180_000);
    expect(Number(inv.body.gross_minor)).toBe(1_180_000);
    expect(inv.body.match.ok).toBe(true);
  });

  it('an over-priced invoice is DISPUTED by the 3-way match', async () => {
    const inv = await http().post(`/invoices/from-po/${poId}`).set(...bearer(supplier))
      .send({ items: [{ poItemId, qty: 10, unitPriceMinor: 120_000 }] }).expect(201);
    expect(inv.body.status).toBe('DISPUTED');
    expect(inv.body.match.lines[0].price_ok).toBe(false);
  });

  it('buyer approves and pays a matched invoice', async () => {
    const list = await http().get('/invoices').set(...bearer(buyer)).expect(200);
    const matched = list.body.find((i: any) => i.status === 'MATCHED');
    await http().post(`/invoices/${matched.id}/approve`).set(...bearer(buyer)).expect(201);
    const paid = await http().post(`/invoices/${matched.id}/pay`).set(...bearer(buyer)).expect(201);
    expect(paid.body.status).toBe('PAID');
  });

  it('Peppol UBL export produces a BIS-3.0-shaped XML with correct totals', async () => {
    const list = await http().get('/invoices').set(...bearer(buyer)).expect(200);
    const paid = list.body.find((i: any) => i.status === 'PAID') ?? list.body[0];
    const res = await http().get(`/invoices/${paid.id}/ubl`).set(...bearer(buyer)).expect(200);
    expect(res.headers['content-type']).toContain('application/xml');
    const xml = res.text;
    expect(xml).toContain('urn:fdc:peppol.eu:2017:poacc:billing:3.0');
    expect(xml).toContain(`<cbc:ID>${paid.invoice_no}</cbc:ID>`);
    expect(xml).toContain('<cbc:PayableAmount currencyID="AZN">11800.00</cbc:PayableAmount>'); // 1.18M minor
    expect(xml).toContain('<cbc:TaxAmount currencyID="AZN">1800.00</cbc:TaxAmount>');
    expect(xml).toContain('<cac:InvoiceLine>');
  });

  it('supplier cannot approve its own invoice; foreign supplier cannot invoice or see', async () => {
    const list = await http().get('/invoices').set(...bearer(supplier)).expect(200);
    const someId = list.body[0].id;
    await http().post(`/invoices/${someId}/approve`).set(...bearer(supplier)).expect(403);
    await http().post(`/invoices/from-po/${poId}`).set(...bearer(s2)).send({ items: [{ poItemId, qty: 1, unitPriceMinor: 1 }] }).expect(404);
    const list2 = await http().get('/invoices').set(...bearer(s2)).expect(200);
    expect(list2.body.map((i: any) => i.id)).not.toContain(someId);
  });
});
