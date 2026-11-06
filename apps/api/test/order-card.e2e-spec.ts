import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { addApprover } from './helpers';

// `GET /orders/:id` is what the order's own page is built from, and this suite pins the one
// thing that page claims about access: **the chain it came out of is buyer-private, and
// nothing in the application decides that — the policies do.** The query LEFT JOINs the
// request and the department, so a supplier reading the very same order gets NULL in those
// columns on its own. If that ever stops being true the supplier's card starts showing the
// buyer's internal request number and the department its money comes out of, and no test
// above the DB would notice.
describe('order card (API e2e)', () => {
  let app: INestApplication;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ['Authorization', `Bearer ${t}`] as [string, string];
  let buyer: string, approver: string, supplier: string, supplierOrg: string;
  let foreignBuyer: string, foreignSupplier: string;
  let poId: string, requestNo: string, deptCode: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    const reg = async (path: string, name: string, email: string) => {
      const r = await http().post(path).send({ legalName: name, email, password: 'password123', fullName: name }).expect(201);
      return { token: r.body.accessToken as string, org: r.body.org.id as string };
    };
    ({ token: buyer } = await reg('/auth/register/buyer', `Card Buyer ${tag}`, `cardb-${tag}@t.test`));
    approver = await addApprover(app, buyer, tag);
    ({ token: foreignBuyer } = await reg('/auth/register/buyer', `Card BuyerX ${tag}`, `cardbx-${tag}@t.test`));
    ({ token: supplier, org: supplierOrg } = await reg('/auth/register/supplier', `Card Sup ${tag}`, `cards-${tag}@t.test`));
    ({ token: foreignSupplier } = await reg('/auth/register/supplier', `Card SupX ${tag}`, `cardsx-${tag}@t.test`));

    await http().post(`/suppliers/${supplierOrg}/invite`).set(...bearer(buyer)).expect(201);
    const reg2 = await http().get('/suppliers').set(...bearer(buyer)).expect(200);
    const relId = reg2.body.find((r: any) => r.supplier_org_id === supplierOrg).id;
    await http().post(`/suppliers/relationships/${relId}/status`).set(...bearer(buyer)).send({ status: 'APPROVED' }).expect(201);
    await http().put('/requests/method-policies').set(...bearer(buyer))
      .send({ policies: [{ category: '*', minAmountMinor: 0, maxAmountMinor: null, method: 'DIRECT' }] }).expect(200);

    // A department, so the card has one to hide from the supplier.
    deptCode = `CARD-${tag}`;
    const dept = await http().post('/departments').set(...bearer(buyer))
      .send({ code: deptCode, name: 'Card test unit' }).expect(201);

    const req = await http().post('/requests').set(...bearer(buyer))
      .send({
        title: `Card ${tag}`, departmentId: dept.body.id,
        items: [{ name: 'Office chair', qty: 4, estUnitPriceMinor: 90_000 }],
      }).expect(201);
    requestNo = req.body.request_no;
    await http().post(`/requests/${req.body.id}/submit`).set(...bearer(buyer)).expect(201);
    await http().post(`/requests/${req.body.id}/approve`).set(...bearer(approver)).expect(201);
    const po = await http().post(`/orders/direct/from-request/${req.body.id}`).set(...bearer(buyer))
      .send({ supplierOrgId: supplierOrg }).expect(201);
    poId = po.body.id;
    await http().post(`/orders/${poId}/status`).set(...bearer(buyer)).send({ status: 'ISSUED' }).expect(201);
  });

  afterAll(async () => { await app.close(); });

  // The two things the product could not show anywhere before this page existed.
  it('carries what was ordered and how the order got to its status', async () => {
    const r = await http().get(`/orders/${poId}`).set(...bearer(buyer)).expect(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toMatchObject({ name: 'Office chair', line_no: 1 });
    expect(Number(r.body.items[0].qty)).toBe(4);
    // DRAFT → ISSUED, so the history has the step that moved it, not just where it landed.
    expect(r.body.history.length).toBeGreaterThan(0);
    expect(r.body.history.map((h: any) => h.to_status)).toContain('ISSUED');
  });

  it('names the request and the department it is charged to, for the buyer', async () => {
    const r = await http().get(`/orders/${poId}`).set(...bearer(buyer)).expect(200);
    expect(r.body.request_no).toBe(requestNo);
    expect(r.body.request_title).toBe(`Card ${tag}`);
    expect(r.body.department_code).toBe(deptCode);
    // A direct purchase has no contract behind it — the chain genuinely breaks here, and
    // the card says nothing rather than inventing a contract line.
    expect(r.body.contract_no).toBeNull();
    expect(r.body.event_id).toBeNull();
  });

  // The load-bearing one.
  it('shows the supplier the order, and none of the buyer’s internals', async () => {
    const r = await http().get(`/orders/${poId}`).set(...bearer(supplier)).expect(200);
    // Same order, same money, same lines: this is one document with two readers.
    expect(r.body.id).toBe(poId);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.buyer_name).toContain('Card Buyer');
    // …and the buyer-private columns come back empty from the policies themselves.
    expect(r.body.request_no).toBeNull();
    expect(r.body.request_title).toBeNull();
    expect(r.body.department_code).toBeNull();
    // Not merely absent from a hand-picked list of fields — the request number must not
    // appear anywhere in what the supplier is served.
    expect(JSON.stringify(r.body)).not.toContain(requestNo);
    expect(JSON.stringify(r.body)).not.toContain(deptCode);
  });

  it('does not exist for an organisation that is not a party to it', async () => {
    await http().get(`/orders/${poId}`).set(...bearer(foreignBuyer)).expect(404);
    await http().get(`/orders/${poId}`).set(...bearer(foreignSupplier)).expect(404);
  });
});
