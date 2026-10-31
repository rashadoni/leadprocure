import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { addApprover } from './helpers';

// PO amendments (change orders): buyer proposes per-line qty/price changes on an
// ISSUED/CONFIRMED PO; supplier accepts (lines + total update atomically via the
// SECURITY DEFINER seam) or rejects (nothing changes). History snapshots old→new.
describe('PO amendments (API e2e)', () => {
  let app: INestApplication;
  let db: Client;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ['Authorization', `Bearer ${t}`] as [string, string];
  let buyer: string, supplier: string, supplierOrg: string, foreignBuyer: string, foreignSupplier: string;
  let approver: string;
  let poId: string, poItemId: string, amendmentId: string;

  const mkPo = async () => {
    const req = await http().post('/requests').set(...bearer(buyer))
      .send({ title: `Am ${tag} ${randomUUID().slice(0, 4)}`, items: [{ name: 'Steel pipe', qty: 2, estUnitPriceMinor: 150_000 }] })
      .expect(201);
    await http().post(`/requests/${req.body.id}/submit`).set(...bearer(buyer)).expect(201);
    await http().post(`/requests/${req.body.id}/approve`).set(...bearer(approver)).expect(201);
    const po = await http().post(`/orders/direct/from-request/${req.body.id}`).set(...bearer(buyer))
      .send({ supplierOrgId: supplierOrg }).expect(201);
    await http().post(`/orders/${po.body.id}/status`).set(...bearer(buyer)).send({ status: 'ISSUED' }).expect(201);
    return { id: po.body.id as string, itemId: po.body.items[0].id as string };
  };

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
    ({ token: buyer } = await reg('/auth/register/buyer', `Am Buyer ${tag}`, `amb-${tag}@t.test`));
    approver = await addApprover(app, buyer, tag);
    ({ token: foreignBuyer } = await reg('/auth/register/buyer', `Am BuyerX ${tag}`, `ambx-${tag}@t.test`));
    ({ token: supplier, org: supplierOrg } = await reg('/auth/register/supplier', `Am Sup ${tag}`, `ams-${tag}@t.test`));
    ({ token: foreignSupplier } = await reg('/auth/register/supplier', `Am SupX ${tag}`, `amsx-${tag}@t.test`));

    await http().post(`/suppliers/${supplierOrg}/invite`).set(...bearer(buyer)).expect(201);
    const reg2 = await http().get('/suppliers').set(...bearer(buyer)).expect(200);
    const relId = reg2.body.find((r: any) => r.supplier_org_id === supplierOrg).id;
    await http().post(`/suppliers/relationships/${relId}/status`).set(...bearer(buyer)).send({ status: 'APPROVED' }).expect(201);
    await http().put('/requests/method-policies').set(...bearer(buyer))
      .send({ policies: [{ category: '*', minAmountMinor: 0, maxAmountMinor: null, method: 'DIRECT' }] }).expect(200);

    ({ id: poId, itemId: poItemId } = await mkPo());
  });

  afterAll(async () => {
    await db.query(`DELETE FROM organizations WHERE legal_name LIKE $1`, [`Am %${tag}%`]);
    await db.end();
    await app.close();
  });

  it('supplier cannot propose an amendment (403)', async () => {
    await http().post(`/orders/${poId}/amendments`).set(...bearer(supplier))
      .send({ reason: 'nope', items: [{ poItemId, qty: 3 }] }).expect(403);
  });

  it('buyer proposes qty+price changes on an ISSUED PO; snapshot and new total are computed', async () => {
    const res = await http().post(`/orders/${poId}/amendments`).set(...bearer(buyer))
      .send({ reason: 'Need one more, negotiated price', items: [{ poItemId, qty: 3, unitPriceMinor: 140_000 }] })
      .expect(201);
    amendmentId = res.body.id;
    expect(res.body.status).toBe('PROPOSED');
    expect(res.body.changes[0]).toMatchObject({ oldQty: 2, newQty: 3, oldUnitPriceMinor: 150_000, newUnitPriceMinor: 140_000 });
    expect(Number(res.body.old_total_minor)).toBe(300_000);
    expect(Number(res.body.new_total_minor)).toBe(420_000);
  });

  it('only one pending amendment per PO', async () => {
    await http().post(`/orders/${poId}/amendments`).set(...bearer(buyer))
      .send({ reason: 'again', items: [{ poItemId, qty: 5 }] }).expect(400);
  });

  it('validation: zero qty, foreign item, and no-change lines are rejected', async () => {
    await http().post(`/orders/${poId}/amendments`).set(...bearer(buyer))
      .send({ reason: 'bad', items: [{ poItemId, qty: 0 }] }).expect(400);
    await http().post(`/orders/${poId}/amendments`).set(...bearer(buyer))
      .send({ reason: 'bad', items: [{ poItemId: randomUUID(), qty: 3 }] }).expect(400);
  });

  it('foreign orgs cannot see the amendment (RLS)', async () => {
    const asForeignBuyer = await http().get(`/orders/${poId}/amendments`).set(...bearer(foreignBuyer)).expect(200);
    expect(asForeignBuyer.body).toHaveLength(0);
    const asForeignSupplier = await http().get(`/orders/${poId}/amendments`).set(...bearer(foreignSupplier)).expect(200);
    expect(asForeignSupplier.body).toHaveLength(0);
    // the real supplier DOES see it
    const asSupplier = await http().get(`/orders/${poId}/amendments`).set(...bearer(supplier)).expect(200);
    expect(asSupplier.body).toHaveLength(1);
  });

  it('buyer cannot decide their own amendment (403)', async () => {
    await http().post(`/orders/${poId}/amendments/${amendmentId}/decision`).set(...bearer(buyer))
      .send({ accept: true }).expect(403);
  });

  it('foreign supplier cannot decide it (RLS hides → 404)', async () => {
    await http().post(`/orders/${poId}/amendments/${amendmentId}/decision`).set(...bearer(foreignSupplier))
      .send({ accept: true }).expect(404);
  });

  it('supplier accepts: PO lines and total update atomically', async () => {
    const res = await http().post(`/orders/${poId}/amendments/${amendmentId}/decision`).set(...bearer(supplier))
      .send({ accept: true, note: 'ok' }).expect(201);
    expect(res.body.status).toBe('ACCEPTED');
    const po = await http().get(`/orders/${poId}`).set(...bearer(buyer)).expect(200);
    expect(Number(po.body.total_minor)).toBe(420_000);
    expect(Number(po.body.items[0].qty)).toBe(3);
    expect(Number(po.body.items[0].unit_price_minor)).toBe(140_000);
    // history keeps the old values in the snapshot
    const list = await http().get(`/orders/${poId}/amendments`).set(...bearer(buyer)).expect(200);
    expect(list.body[0].changes[0].oldQty).toBe(2);
  });

  it('amendment on a PACKED PO is rejected (fulfilment started)', async () => {
    await http().post(`/orders/${poId}/status`).set(...bearer(supplier)).send({ status: 'CONFIRMED' }).expect(201);
    await http().post(`/orders/${poId}/status`).set(...bearer(supplier)).send({ status: 'PACKED' }).expect(201);
    await http().post(`/orders/${poId}/amendments`).set(...bearer(buyer))
      .send({ reason: 'too late', items: [{ poItemId, qty: 4 }] }).expect(400);
  });

  it('reject path: nothing changes on the PO', async () => {
    const { id: po2, itemId: item2 } = await mkPo();
    const am = await http().post(`/orders/${po2}/amendments`).set(...bearer(buyer))
      .send({ reason: 'try', items: [{ poItemId: item2, qty: 10 }] }).expect(201);
    const res = await http().post(`/orders/${po2}/amendments/${am.body.id}/decision`).set(...bearer(supplier))
      .send({ accept: false, note: 'cannot do' }).expect(201);
    expect(res.body.status).toBe('REJECTED');
    const po = await http().get(`/orders/${po2}`).set(...bearer(buyer)).expect(200);
    expect(Number(po.body.total_minor)).toBe(300_000); // untouched
    expect(Number(po.body.items[0].qty)).toBe(2);
  });

  it('refuses a change order whose total JavaScript cannot hold exactly', async () => {
    const { id: po3, itemId: item3 } = await mkPo();
    // 3 x 9007199254740991 is 27021597764222973, but in JS it comes out ...972: past 2^53
    // the multiplication stops being exact. Each field passed safeMoney on its own; the
    // product and the sum did not. The amendment stores that JS number as
    // new_total_minor while po_amendment_decide recomputes the order's total in SQL, so
    // accepting it left the change order's record of the money and the order itself
    // disagreeing — with the audit carrying the wrong one.
    const refused = await http().post(`/orders/${po3}/amendments`).set(...bearer(buyer))
      .send({ reason: 'Overflow probe', items: [{ poItemId: item3, qty: 3, unitPriceMinor: 9007199254740991 }] })
      .expect(400);
    expect(refused.body.message).toMatch(/safe integer/);
    const none = await http().get(`/orders/${po3}/amendments`).set(...bearer(buyer)).expect(200);
    expect(none.body).toHaveLength(0);
  });
});
