import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { addApprover } from './helpers';

// P2P: supplier invoices a received PO; the 3-way match (invoice ↔ PO ↔ receipt) drives
// MATCHED/DISPUTED; the buyer approves and pays.
describe('invoices + 3-way match', () => {
  let app: INestApplication;
  let db: Client;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ['Authorization', `Bearer ${t}`] as [string, string];

  let buyer: string, supplier: string, s2: string, supplierOrg: string;
  let approver: string;
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
    approver = await addApprover(app, buyer, tag);
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
    await http().post(`/requests/${req.body.id}/approve`).set(...bearer(approver)).expect(201);
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

  // Regression: the match used to be a snapshot frozen at submit — an invoice sent
  // before the goods arrived stayed DISPUTED forever, even once fully received.
  it('an invoice submitted before the receipt flips DISPUTED → MATCHED when the GRN lands', async () => {
    const req = await http().post('/requests').set(...bearer(buyer))
      .send({ title: `Inv pre-GRN ${tag}`, items: [{ name: 'Gadget', qty: 4, estUnitPriceMinor: 50_000 }] }).expect(201);
    await http().post(`/requests/${req.body.id}/submit`).set(...bearer(buyer)).expect(201);
    await http().post(`/requests/${req.body.id}/approve`).set(...bearer(approver)).expect(201);
    const po = await http().post(`/orders/direct/from-request/${req.body.id}`).set(...bearer(buyer))
      .send({ supplierOrgId: supplierOrg }).expect(201);
    const po2 = po.body.id as string;
    const item2 = po.body.items[0].id as string;
    await http().post(`/orders/${po2}/status`).set(...bearer(buyer)).send({ status: 'ISSUED' }).expect(201);
    for (const s of ['CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED']) {
      await http().post(`/orders/${po2}/status`).set(...bearer(supplier)).send({ status: s }).expect(201);
    }

    // invoice BEFORE any receipt → disputed, received 0
    const inv = await http().post(`/invoices/from-po/${po2}`).set(...bearer(supplier))
      .send({ items: [{ poItemId: item2, qty: 4, unitPriceMinor: 50_000 }] }).expect(201);
    expect(inv.body.status).toBe('DISPUTED');
    expect(Number(inv.body.match.lines[0].received)).toBe(0);

    // the goods arrive → the GRN re-runs the match, no manual override needed
    await http().post(`/orders/${po2}/receipts`).set(...bearer(buyer)).send({ items: [{ poItemId: item2, qty: 4 }] }).expect(201);
    const after = await http().get(`/invoices/${inv.body.id}`).set(...bearer(buyer)).expect(200);
    expect(after.body.status).toBe('MATCHED');
    expect(after.body.match.ok).toBe(true);
    expect(Number(after.body.match.lines[0].received)).toBe(4);

    // a MATCHED invoice approves without an override reason
    const ok = await http().post(`/invoices/${inv.body.id}/approve`).set(...bearer(buyer)).expect(201);
    expect(ok.body.status).toBe('APPROVED');
  });

  it('a partial receipt is not enough — the invoice stays DISPUTED until fully billable', async () => {
    const req = await http().post('/requests').set(...bearer(buyer))
      .send({ title: `Inv partial ${tag}`, items: [{ name: 'Bolt', qty: 10, estUnitPriceMinor: 1_000 }] }).expect(201);
    await http().post(`/requests/${req.body.id}/submit`).set(...bearer(buyer)).expect(201);
    await http().post(`/requests/${req.body.id}/approve`).set(...bearer(approver)).expect(201);
    const po = await http().post(`/orders/direct/from-request/${req.body.id}`).set(...bearer(buyer))
      .send({ supplierOrgId: supplierOrg }).expect(201);
    const po3 = po.body.id as string;
    const item3 = po.body.items[0].id as string;
    await http().post(`/orders/${po3}/status`).set(...bearer(buyer)).send({ status: 'ISSUED' }).expect(201);
    for (const s of ['CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED']) {
      await http().post(`/orders/${po3}/status`).set(...bearer(supplier)).send({ status: s }).expect(201);
    }
    const inv = await http().post(`/invoices/from-po/${po3}`).set(...bearer(supplier))
      .send({ items: [{ poItemId: item3, qty: 10, unitPriceMinor: 1_000 }] }).expect(201);
    expect(inv.body.status).toBe('DISPUTED');

    await http().post(`/orders/${po3}/receipts`).set(...bearer(buyer)).send({ items: [{ poItemId: item3, qty: 6 }] }).expect(201);
    let cur = await http().get(`/invoices/${inv.body.id}`).set(...bearer(buyer)).expect(200);
    expect(cur.body.status).toBe('DISPUTED'); // 10 billed > 6 received
    expect(Number(cur.body.match.lines[0].received)).toBe(6);

    await http().post(`/orders/${po3}/receipts`).set(...bearer(buyer)).send({ items: [{ poItemId: item3, qty: 4 }] }).expect(201);
    cur = await http().get(`/invoices/${inv.body.id}`).set(...bearer(buyer)).expect(200);
    expect(cur.body.status).toBe('MATCHED');
  });
});
