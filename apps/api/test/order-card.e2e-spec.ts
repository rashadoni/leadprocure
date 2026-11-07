import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
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
  let db: Client;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ['Authorization', `Bearer ${t}`] as [string, string];
  let buyer: string, approver: string, supplier: string, supplierOrg: string;
  let foreignBuyer: string, foreignSupplier: string;
  let poId: string, requestNo: string, deptCode: string;
  let contractPoId: string, contractNo: string, eventId: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    // Owner connection: closing a tender by its own deadline is a clock problem, not an
    // API one, and every spec that needs a real opening does it this way.
    db = new Client({ connectionString: process.env.DATABASE_OWNER_URL ?? process.env.DATABASE_URL });
    await db.connect();

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
      .send({ policies: [
        { category: '*', minAmountMinor: 0, maxAmountMinor: 500_000, method: 'DIRECT' },
        { category: '*', minAmountMinor: 500_000, maxAmountMinor: null, method: 'RFQ' },
      ] }).expect(200);

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

  afterAll(async () => { await db.end(); await app.close(); });

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

  // Without this the whole `LEFT JOIN contracts` could be deleted and every test above
  // would stay green: the direct order asserts only that there is NO contract. On the demo
  // stand this is the rare path too — one order in nine comes from a contract — so it is
  // exactly the one a reader meets least and a test must cover most.
  describe('an order drawn from a contract', () => {
    beforeAll(async () => {
      const req = await http().post('/requests').set(...bearer(buyer))
        .send({ title: `Card tender ${tag}`, items: [{ name: 'Server rack', qty: 1, estUnitPriceMinor: 600_000 }] })
        .expect(201);
      await http().post(`/requests/${req.body.id}/submit`).set(...bearer(buyer)).expect(201);
      await http().post(`/requests/${req.body.id}/approve`).set(...bearer(approver)).expect(201);
      const ev = await http().post(`/events/from-request/${req.body.id}`).set(...bearer(buyer))
        .send({ closeAt: new Date(Date.now() + 3600_000).toISOString(), visibility: 'INVITED' }).expect(201);
      eventId = ev.body.id;
      await http().post(`/events/${eventId}/invite`).set(...bearer(buyer)).send({ supplierOrgId: supplierOrg }).expect(201);
      await http().post(`/events/${eventId}/publish`).set(...bearer(buyer)).expect(201);
      const open = await http().get(`/events/${eventId}`).set(...bearer(buyer)).expect(200);
      await http().post(`/events/${eventId}/bid`).set(...bearer(supplier))
        .send({ items: [{ eventItemId: open.body.items[0].id, unitPriceMinor: 600_000 }] }).expect(201);
      await db.query(`UPDATE sourcing_events SET close_at = now() - interval '1 second' WHERE id = $1`, [eventId]);
      await db.query(`SELECT * FROM close_due_events()`);
      await http().post(`/events/${eventId}/open`).set(...bearer(buyer)).expect(201);
      const opened = (await http().get(`/events/${eventId}`).set(...bearer(buyer)).expect(200)).body;
      // Both criteria, because both are what the event locked at creation: the default is
      // price 70 / delivery 30 (`normalizeCriteria`), and scoring half of them is a
      // different test's subject.
      await http().post(`/events/${eventId}/evaluate`).set(...bearer(buyer))
        .send({ scores: [
          { bidId: opened.bids[0].id, key: 'price', score: 90 },
          { bidId: opened.bids[0].id, key: 'delivery', score: 80 },
        ] }).expect(201);
      await http().post(`/events/${eventId}/award`).set(...bearer(buyer))
        .send({ lotId: opened.lots[0].id, bidId: opened.bids[0].id, justification: 'the only bid received' }).expect(201);
      const awarded = (await http().get(`/events/${eventId}`).set(...bearer(buyer)).expect(200)).body;
      const contract = (await http().post(`/contracts/from-award/${awarded.awards[0].id}`).set(...bearer(buyer)).expect(201)).body;
      contractNo = contract.contract_no;
      await http().post(`/contracts/${contract.id}/activate`).set(...bearer(buyer)).expect(201);
      contractPoId = (await http().post(`/contracts/${contract.id}/orders`).set(...bearer(buyer)).expect(201)).body.id;
    });

    it('names the contract and links to the tender, for the buyer', async () => {
      const r = await http().get(`/orders/${contractPoId}`).set(...bearer(buyer)).expect(200);
      expect(r.body.contract_no).toBe(contractNo);
      expect(r.body.contract_title).toBeTruthy();
      expect(r.body.event_id).toBe(eventId);
    });

    // The contract's own policy is mutual — both parties signed it — so these three are the
    // columns the supplier is MEANT to see, and that is as much a claim as the hidden ones.
    it('shows the supplier the same contract and tender, and still not the request', async () => {
      const r = await http().get(`/orders/${contractPoId}`).set(...bearer(supplier)).expect(200);
      expect(r.body.contract_no).toBe(contractNo);
      expect(r.body.event_id).toBe(eventId);
      expect(r.body.request_no).toBeNull();
      expect(r.body.department_code).toBeNull();
    });
  });

  // The audit's finding, and the rule the «Выдать заказ» button is for. A draft order is
  // the buyer still writing it: it has a number, lines and a total, and until it is issued
  // it is nobody else's business. The policy used to admit both parties from the moment the
  // row existed, so the supplier had it in «Заказы в работе» before the buyer had decided
  // to send it, and issuing changed nothing they could perceive.
  describe('an order still in draft', () => {
    let draftId: string;

    beforeAll(async () => {
      const req = await http().post('/requests').set(...bearer(buyer))
        .send({ title: `Card draft ${tag}`, items: [{ name: 'Desk lamp', qty: 2, estUnitPriceMinor: 30_000 }] })
        .expect(201);
      await http().post(`/requests/${req.body.id}/submit`).set(...bearer(buyer)).expect(201);
      await http().post(`/requests/${req.body.id}/approve`).set(...bearer(approver)).expect(201);
      draftId = (await http().post(`/orders/direct/from-request/${req.body.id}`).set(...bearer(buyer))
        .send({ supplierOrgId: supplierOrg }).expect(201)).body.id;
    });

    it('is the buyer’s alone — the supplier cannot list it or open it', async () => {
      const mine = await http().get('/orders').set(...bearer(buyer)).expect(200);
      expect(mine.body.items.map((p: any) => p.id)).toContain(draftId);

      const theirs = await http().get('/orders').set(...bearer(supplier)).expect(200);
      expect(theirs.body.items.map((p: any) => p.id)).not.toContain(draftId);
      await http().get(`/orders/${draftId}`).set(...bearer(supplier)).expect(404);
      // …and not through the lines either: they carry the money and have no status of
      // their own, so they ask the header for one. This endpoint answers 200 to anybody —
      // it is the policy that empties it, which is why the buyer's own answer is asserted
      // beside it: an empty list that is empty for everyone would prove nothing.
      const theirLines = await http().get(`/orders/${draftId}/receipts`).set(...bearer(supplier)).expect(200);
      expect(theirLines.body.summary).toHaveLength(0);
      const myLines = await http().get(`/orders/${draftId}/receipts`).set(...bearer(buyer)).expect(200);
      expect(myLines.body.summary).toHaveLength(1);
    });

    it('says nothing to the supplier until it is issued, then says it once', async () => {
      const mine = async () => (await http().get('/notifications').set(...bearer(supplier)).expect(200)).body
        .filter((n: any) => n.payload?.po_id === draftId);
      expect(await mine()).toHaveLength(0);

      await http().post(`/orders/${draftId}/status`).set(...bearer(buyer)).send({ status: 'ISSUED' }).expect(201);

      const after = await mine();
      expect(after.map((n: any) => n.type).sort()).toEqual(['DIRECT_ORDER_CREATED', 'PO_STATUS_CHANGED']);
      // …and the order is theirs to read from this moment, lines and all
      const r = await http().get(`/orders/${draftId}`).set(...bearer(supplier)).expect(200);
      expect(r.body.items).toHaveLength(1);
      expect(r.body.po_no).toBeTruthy();
    });
  });

  it('does not exist for an organisation that is not a party to it', async () => {
    await http().get(`/orders/${poId}`).set(...bearer(foreignBuyer)).expect(404);
    await http().get(`/orders/${poId}`).set(...bearer(foreignSupplier)).expect(404);
  });
});
