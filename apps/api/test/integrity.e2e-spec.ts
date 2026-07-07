import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { addApprover } from './helpers';

// Procurement-integrity controls (audit remediation). Proves: segregation of duties,
// evaluation criteria locked before opening, award tied to evaluation with a justification
// for a non-top / single bid, disqualification, award cancellation & re-award, the DISPUTED
// invoice override, and VÖEN validation.
describe('procurement integrity controls (API e2e)', () => {
  let app: INestApplication;
  let db: Client;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ['Authorization', `Bearer ${t}`] as [string, string];
  let buyer: string, approver: string, s1: string, s1Org: string, s2: string, s2Org: string;
  let eventId: string, lotId: string, itemId: string, bid1: string, bid2: string;

  const reg = async (path: string, name: string, email: string) => {
    const r = await http().post(path).send({ legalName: name, email, password: 'password123', fullName: name }).expect(201);
    return { token: r.body.accessToken as string, org: r.body.org.id as string };
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    db = new Client({ connectionString: process.env.DATABASE_OWNER_URL ?? process.env.DATABASE_URL });
    await db.connect();
    ({ token: buyer } = await reg('/auth/register/buyer', `Intg Buyer ${tag}`, `ib-${tag}@t.test`));
    approver = await addApprover(app, buyer, tag);
    ({ token: s1, org: s1Org } = await reg('/auth/register/supplier', `Intg S1 ${tag}`, `is1-${tag}@t.test`));
    ({ token: s2, org: s2Org } = await reg('/auth/register/supplier', `Intg S2 ${tag}`, `is2-${tag}@t.test`));
    await http().put('/requests/method-policies').set(...bearer(buyer))
      .send({ policies: [{ category: '*', minAmountMinor: 0, maxAmountMinor: null, method: 'RFQ' }] }).expect(200);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM organizations WHERE legal_name LIKE $1`, [`Intg %${tag}%`]);
    await db.end();
    await app.close();
  });

  it('SoD: the creator cannot approve their own request (403); a different approver can', async () => {
    const req = await http().post('/requests').set(...bearer(buyer))
      .send({ title: `SoD ${tag}`, items: [{ name: 'x', qty: 1, estUnitPriceMinor: 100_000 }] }).expect(201);
    await http().post(`/requests/${req.body.id}/submit`).set(...bearer(buyer)).expect(201);
    await http().post(`/requests/${req.body.id}/approve`).set(...bearer(buyer)).expect(403); // self-approval blocked
    await http().post(`/requests/${req.body.id}/approve`).set(...bearer(approver)).expect(201);
  });

  it('VÖEN must be 10 digits', async () => {
    await http().post('/auth/register/buyer')
      .send({ legalName: 'Bad VOEN', voen: 'ABC', email: `bv-${tag}@t.test`, password: 'password123', fullName: 'x' })
      .expect(400);
  });

  it('sets up a 2-bid sealed RFQ and drives it to EVALUATION', async () => {
    const req = await http().post('/requests').set(...bearer(buyer))
      .send({ title: `Tender ${tag}`, items: [{ name: 'Widget', qty: 10, estUnitPriceMinor: 100_000 }] }).expect(201);
    await http().post(`/requests/${req.body.id}/submit`).set(...bearer(buyer)).expect(201);
    await http().post(`/requests/${req.body.id}/approve`).set(...bearer(approver)).expect(201);
    // criteria are locked at creation
    const ev = await http().post(`/events/from-request/${req.body.id}`).set(...bearer(buyer))
      .send({ closeAt: new Date(Date.now() + 3600_000).toISOString(), visibility: 'INVITED',
              criteria: [{ key: 'price', weight: 70 }, { key: 'delivery', weight: 30 }] }).expect(201);
    eventId = ev.body.id; lotId = ev.body.lots[0].id; itemId = ev.body.items[0].id;
    expect(ev.body.evaluation_criteria).toHaveLength(2);
    for (const org of [s1Org, s2Org]) await http().post(`/events/${eventId}/invite`).set(...bearer(buyer)).send({ supplierOrgId: org }).expect(201);
    await http().post(`/events/${eventId}/publish`).set(...bearer(buyer)).expect(201);
    bid1 = (await http().post(`/events/${eventId}/bid`).set(...bearer(s1)).send({ items: [{ eventItemId: itemId, unitPriceMinor: 90_000 }], deliveryDays: 10 }).expect(201)).body.id;
    bid2 = (await http().post(`/events/${eventId}/bid`).set(...bearer(s2)).send({ items: [{ eventItemId: itemId, unitPriceMinor: 95_000 }], deliveryDays: 20 }).expect(201)).body.id;
    await db.query(`UPDATE sourcing_events SET close_at = now() - interval '1 second' WHERE id=$1`, [eventId]);
    await db.query(`SELECT * FROM close_due_events()`);
    await http().post(`/events/${eventId}/open`).set(...bearer(buyer)).expect(201);
  });

  it('award is refused before any evaluation exists', async () => {
    await http().post(`/events/${eventId}/award`).set(...bearer(buyer)).send({ lotId, bidId: bid1 }).expect(400);
  });

  it('evaluate uses the LOCKED criteria; an unknown criterion key is rejected', async () => {
    await http().post(`/events/${eventId}/evaluate`).set(...bearer(buyer))
      .send({ scores: [{ bidId: bid1, key: 'bribe', score: 100 }] }).expect(400); // not a locked criterion
    const res = await http().post(`/events/${eventId}/evaluate`).set(...bearer(buyer))
      .send({ scores: [
        { bidId: bid1, key: 'price', score: 95 }, { bidId: bid1, key: 'delivery', score: 90 }, // bid1 top
        { bidId: bid2, key: 'price', score: 60 }, { bidId: bid2, key: 'delivery', score: 60 },
      ] }).expect(201);
    expect(res.body.ranking[0].bid_id).toBe(bid1); // bid1 is the top-ranked
  });

  it('awarding the NON-top bid requires a justification', async () => {
    await http().post(`/events/${eventId}/award`).set(...bearer(buyer)).send({ lotId, bidId: bid2 }).expect(400);
    await http().post(`/events/${eventId}/award`).set(...bearer(buyer))
      .send({ lotId, bidId: bid2, justification: 'bid1 later withdrew capacity' }).expect(201);
  });

  it('an awarded event can be cancelled with a reason, then re-awarded to the top bid', async () => {
    // cancel needs a reason
    await http().post(`/events/${eventId}/cancel-award`).set(...bearer(buyer)).send({ lotId }).expect(400);
    const cancelled = await http().post(`/events/${eventId}/cancel-award`).set(...bearer(buyer))
      .send({ lotId, reason: 'wrong award, re-running' }).expect(201);
    expect(cancelled.body.status).toBe('EVALUATION');
    // re-award to the TOP bid — no justification needed now
    await http().post(`/events/${eventId}/award`).set(...bearer(buyer)).send({ lotId, bidId: bid1 }).expect(201);
    const detail = await http().get(`/events/${eventId}`).set(...bearer(buyer)).expect(200);
    expect(detail.body.status).toBe('AWARDED');
    const active = detail.body.awards.filter((a: any) => !a.cancelled_at);
    expect(active).toHaveLength(1);
    expect(active[0].winning_bid_id).toBe(bid1);
  });

  it('disqualification needs a reason and a disqualified bid cannot be awarded', async () => {
    // set up a fresh single-lot tender where we disqualify the top bid
    const req = await http().post('/requests').set(...bearer(buyer))
      .send({ title: `DQ ${tag}`, items: [{ name: 'Y', qty: 5, estUnitPriceMinor: 100_000 }] }).expect(201);
    await http().post(`/requests/${req.body.id}/submit`).set(...bearer(buyer)).expect(201);
    await http().post(`/requests/${req.body.id}/approve`).set(...bearer(approver)).expect(201);
    const ev = await http().post(`/events/from-request/${req.body.id}`).set(...bearer(buyer))
      .send({ closeAt: new Date(Date.now() + 3600_000).toISOString(), visibility: 'INVITED' }).expect(201);
    const eid = ev.body.id, lot = ev.body.lots[0].id, item = ev.body.items[0].id;
    for (const org of [s1Org, s2Org]) await http().post(`/events/${eid}/invite`).set(...bearer(buyer)).send({ supplierOrgId: org }).expect(201);
    await http().post(`/events/${eid}/publish`).set(...bearer(buyer)).expect(201);
    const dqBid = (await http().post(`/events/${eid}/bid`).set(...bearer(s1)).send({ items: [{ eventItemId: item, unitPriceMinor: 80_000 }] }).expect(201)).body.id;
    await http().post(`/events/${eid}/bid`).set(...bearer(s2)).send({ items: [{ eventItemId: item, unitPriceMinor: 90_000 }] }).expect(201);
    await db.query(`UPDATE sourcing_events SET close_at = now() - interval '1 second' WHERE id=$1`, [eid]);
    await db.query(`SELECT * FROM close_due_events()`);
    await http().post(`/events/${eid}/open`).set(...bearer(buyer)).expect(201);

    await http().post(`/events/${eid}/bids/${dqBid}/disqualify`).set(...bearer(buyer)).send({ reason: 'ab' }).expect(400); // reason too short
    await http().post(`/events/${eid}/bids/${dqBid}/disqualify`).set(...bearer(buyer)).send({ reason: 'incomplete tender documents' }).expect(201);
    // evaluate then try to award the disqualified bid → rejected as ineligible
    await http().post(`/events/${eid}/evaluate`).set(...bearer(buyer))
      .send({ scores: [{ bidId: dqBid, key: 'price', score: 100 }] }).expect(400); // scoring a disqualified bid rejected
    await http().post(`/events/${eid}/award`).set(...bearer(buyer)).send({ lotId: lot, bidId: dqBid, justification: 'x' }).expect(400);
  });

  it('a DISPUTED invoice can only be approved with an override reason', async () => {
    // direct order → deliver → receive nothing → invoice above PO → DISPUTED
    await http().post(`/suppliers/${s1Org}/invite`).set(...bearer(buyer)).expect(201);
    const rel = (await http().get('/suppliers').set(...bearer(buyer)).expect(200)).body.find((r: any) => r.supplier_org_id === s1Org);
    await http().post(`/suppliers/relationships/${rel.id}/status`).set(...bearer(buyer)).send({ status: 'APPROVED' }).expect(201);
    await http().put('/requests/method-policies').set(...bearer(buyer))
      .send({ policies: [{ category: '*', minAmountMinor: 0, maxAmountMinor: 500_000, method: 'DIRECT' }, { category: '*', minAmountMinor: 500_000, maxAmountMinor: null, method: 'RFQ' }] }).expect(200);
    const req = await http().post('/requests').set(...bearer(buyer))
      .send({ title: `Disp ${tag}`, items: [{ name: 'Z', qty: 2, estUnitPriceMinor: 100_000 }] }).expect(201);
    await http().post(`/requests/${req.body.id}/submit`).set(...bearer(buyer)).expect(201);
    await http().post(`/requests/${req.body.id}/approve`).set(...bearer(approver)).expect(201);
    const po = await http().post(`/orders/direct/from-request/${req.body.id}`).set(...bearer(buyer)).send({ supplierOrgId: s1Org }).expect(201);
    const poId = po.body.id, poItemId = po.body.items[0].id;
    await http().post(`/orders/${poId}/status`).set(...bearer(buyer)).send({ status: 'ISSUED' }).expect(201);
    for (const st of ['CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED']) await http().post(`/orders/${poId}/status`).set(...bearer(s1)).send({ status: st }).expect(201);
    await http().post(`/orders/${poId}/receipts`).set(...bearer(buyer)).send({ items: [{ poItemId, qty: 2 }] }).expect(201);
    // invoice ABOVE the PO price → 3-way match fails → DISPUTED
    const inv = await http().post(`/invoices/from-po/${poId}`).set(...bearer(s1))
      .send({ items: [{ poItemId, qty: 2, unitPriceMinor: 130_000 }] }).expect(201);
    expect(inv.body.status).toBe('DISPUTED');
    await http().post(`/invoices/${inv.body.id}/approve`).set(...bearer(buyer)).expect(400); // no reason
    await http().post(`/invoices/${inv.body.id}/approve`).set(...bearer(buyer)).send({ reason: 'price variance accepted by CFO' }).expect(201);
  });

  it('an incomplete lot bid is non-responsive (400); a full bid is accepted', async () => {
    const req = await http().post('/requests').set(...bearer(buyer))
      .send({ title: `Resp ${tag}`, items: [
        { name: 'A', qty: 1, estUnitPriceMinor: 300_000 },
        { name: 'B', qty: 1, estUnitPriceMinor: 300_000 }, // 600k → RFQ regardless of policy state
      ] }).expect(201);
    await http().post(`/requests/${req.body.id}/submit`).set(...bearer(buyer)).expect(201);
    await http().post(`/requests/${req.body.id}/approve`).set(...bearer(approver)).expect(201);
    const ev = await http().post(`/events/from-request/${req.body.id}`).set(...bearer(buyer))
      .send({ closeAt: new Date(Date.now() + 3600_000).toISOString(), visibility: 'INVITED' }).expect(201);
    const eid = ev.body.id, items = ev.body.items;
    await http().post(`/events/${eid}/invite`).set(...bearer(buyer)).send({ supplierOrgId: s1Org }).expect(201);
    await http().post(`/events/${eid}/publish`).set(...bearer(buyer)).expect(201);
    // only 1 of the lot's 2 items priced → rejected
    await http().post(`/events/${eid}/bid`).set(...bearer(s1))
      .send({ items: [{ eventItemId: items[0].id, unitPriceMinor: 50_000 }] }).expect(400);
    // full coverage accepted
    await http().post(`/events/${eid}/bid`).set(...bearer(s1))
      .send({ items: [
        { eventItemId: items[0].id, unitPriceMinor: 50_000 },
        { eventItemId: items[1].id, unitPriceMinor: 50_000 },
      ] }).expect(201);
  });

  it('the same delivery cannot be invoiced twice (3-way match draw-down)', async () => {
    // policy is DIRECT ≤500k from the DISPUTED test; s1 relationship is APPROVED
    const req = await http().post('/requests').set(...bearer(buyer))
      .send({ title: `Draw ${tag}`, items: [{ name: 'D', qty: 3, estUnitPriceMinor: 100_000 }] }).expect(201);
    await http().post(`/requests/${req.body.id}/submit`).set(...bearer(buyer)).expect(201);
    await http().post(`/requests/${req.body.id}/approve`).set(...bearer(approver)).expect(201);
    const po = await http().post(`/orders/direct/from-request/${req.body.id}`).set(...bearer(buyer)).send({ supplierOrgId: s1Org }).expect(201);
    const poId = po.body.id, poItemId = po.body.items[0].id;
    await http().post(`/orders/${poId}/status`).set(...bearer(buyer)).send({ status: 'ISSUED' }).expect(201);
    for (const st of ['CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED']) await http().post(`/orders/${poId}/status`).set(...bearer(s1)).send({ status: st }).expect(201);
    await http().post(`/orders/${poId}/receipts`).set(...bearer(buyer)).send({ items: [{ poItemId, qty: 3 }] }).expect(201);
    const inv1 = await http().post(`/invoices/from-po/${poId}`).set(...bearer(s1)).send({ items: [{ poItemId, qty: 3, unitPriceMinor: 100_000 }] }).expect(201);
    expect(inv1.body.status).toBe('MATCHED');
    // re-billing the same 3 units → nothing left billable → DISPUTED
    const inv2 = await http().post(`/invoices/from-po/${poId}`).set(...bearer(s1)).send({ items: [{ poItemId, qty: 3, unitPriceMinor: 100_000 }] }).expect(201);
    expect(inv2.body.status).toBe('DISPUTED');
  });

  it('invoice ƏDV is per-line: a 0% line carries no VAT', async () => {
    const req = await http().post('/requests').set(...bearer(buyer))
      .send({ title: `Vat ${tag}`, items: [
        { name: 'Taxed', qty: 1, estUnitPriceMinor: 100_000, vatRateBp: 1800 },
        { name: 'Exempt', qty: 1, estUnitPriceMinor: 100_000, vatRateBp: 0 },
      ] }).expect(201);
    await http().post(`/requests/${req.body.id}/submit`).set(...bearer(buyer)).expect(201);
    await http().post(`/requests/${req.body.id}/approve`).set(...bearer(approver)).expect(201);
    const po = await http().post(`/orders/direct/from-request/${req.body.id}`).set(...bearer(buyer)).send({ supplierOrgId: s1Org }).expect(201);
    const poId = po.body.id;
    await http().post(`/orders/${poId}/status`).set(...bearer(buyer)).send({ status: 'ISSUED' }).expect(201);
    for (const st of ['CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED']) await http().post(`/orders/${poId}/status`).set(...bearer(s1)).send({ status: st }).expect(201);
    await http().post(`/orders/${poId}/receipts`).set(...bearer(buyer))
      .send({ items: po.body.items.map((i: any) => ({ poItemId: i.id, qty: 1 })) }).expect(201);
    const inv = await http().post(`/invoices/from-po/${poId}`).set(...bearer(s1))
      .send({ items: po.body.items.map((i: any) => ({ poItemId: i.id, qty: 1, unitPriceMinor: 100_000 })) }).expect(201);
    expect(inv.body.status).toBe('MATCHED');
    expect(Number(inv.body.net_minor)).toBe(200_000);
    expect(Number(inv.body.vat_minor)).toBe(18_000); // only the taxed line
  });

  it('cannot receive more than was ordered', async () => {
    await http().put('/requests/method-policies').set(...bearer(buyer))
      .send({ policies: [{ category: '*', minAmountMinor: 0, maxAmountMinor: 500_000, method: 'DIRECT' }, { category: '*', minAmountMinor: 500_000, maxAmountMinor: null, method: 'RFQ' }] }).expect(200);
    const req = await http().post('/requests').set(...bearer(buyer))
      .send({ title: `Over ${tag}`, items: [{ name: 'O', qty: 2, estUnitPriceMinor: 100_000 }] }).expect(201);
    await http().post(`/requests/${req.body.id}/submit`).set(...bearer(buyer)).expect(201);
    await http().post(`/requests/${req.body.id}/approve`).set(...bearer(approver)).expect(201);
    const po = await http().post(`/orders/direct/from-request/${req.body.id}`).set(...bearer(buyer)).send({ supplierOrgId: s1Org }).expect(201);
    const poId = po.body.id, poItemId = po.body.items[0].id;
    await http().post(`/orders/${poId}/status`).set(...bearer(buyer)).send({ status: 'ISSUED' }).expect(201);
    for (const st of ['CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED']) await http().post(`/orders/${poId}/status`).set(...bearer(s1)).send({ status: st }).expect(201);
    await http().post(`/orders/${poId}/receipts`).set(...bearer(buyer)).send({ items: [{ poItemId, qty: 3 }] }).expect(400); // ordered only 2
    await http().post(`/orders/${poId}/receipts`).set(...bearer(buyer)).send({ items: [{ poItemId, qty: 2 }] }).expect(201);
  });

  it('a spend in a policy gap resolves to OPEN_TENDER, not a direct order', async () => {
    // policy covers only [0, 100k) → a 300k request falls in the gap
    await http().put('/requests/method-policies').set(...bearer(buyer))
      .send({ policies: [{ category: '*', minAmountMinor: 0, maxAmountMinor: 100_000, method: 'DIRECT' }] }).expect(200);
    const req = await http().post('/requests').set(...bearer(buyer))
      .send({ title: `Gap ${tag}`, items: [{ name: 'G', qty: 1, estUnitPriceMinor: 300_000 }] }).expect(201);
    await http().post(`/requests/${req.body.id}/submit`).set(...bearer(buyer)).expect(201);
    const approved = await http().post(`/requests/${req.body.id}/approve`).set(...bearer(approver)).expect(201);
    expect(approved.body.method_resolved).toBe('OPEN_TENDER'); // fail-safe: not DIRECT
    await http().post(`/orders/direct/from-request/${req.body.id}`).set(...bearer(buyer)).send({ supplierOrgId: s1Org }).expect(400);
  });

  it('a contract call-off over its ceiling is flagged (soft control, like budgets)', async () => {
    // reuse the first tender's active award (bid1, from the re-award test)
    const detail = await http().get(`/events/${eventId}`).set(...bearer(buyer)).expect(200);
    const award = detail.body.awards.find((a: any) => !a.cancelled_at);
    const contract = await http().post(`/contracts/from-award/${award.id}`).set(...bearer(buyer)).expect(201);
    await http().post(`/contracts/${contract.body.id}/activate`).set(...bearer(buyer)).expect(201);
    const first = await http().post(`/contracts/${contract.body.id}/orders`).set(...bearer(buyer)).expect(201); // draws the full award
    expect(first.body.ceilingWarning).toBeUndefined();
    const second = await http().post(`/contracts/${contract.body.id}/orders`).set(...bearer(buyer)).expect(201); // over ceiling
    expect(second.body.ceilingWarning).toBeDefined();
    expect(second.body.ceilingWarning.overByMinor).toBeGreaterThan(0);
  });

  it('concurrent document creation yields distinct numbers (no count(*) race)', async () => {
    const mk = () => http().post('/requests').set(...bearer(buyer))
      .send({ title: `Race ${tag}`, items: [{ name: 'r', qty: 1, estUnitPriceMinor: 1000 }] }).expect(201);
    const results = await Promise.all([mk(), mk(), mk(), mk(), mk()]);
    const nos = results.map((r) => r.body.request_no);
    expect(new Set(nos).size).toBe(5); // all five requests got a unique REQ-… number
  });
});
