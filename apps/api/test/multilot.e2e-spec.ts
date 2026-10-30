import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { addApprover } from './helpers';

// Multi-lot sealed RFQ: two lots awarded to two different suppliers; the event only
// becomes AWARDED once every lot is awarded.
describe('multi-lot RFQ', () => {
  let app: INestApplication;
  let db: Client;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ['Authorization', `Bearer ${t}`] as [string, string];

  let buyer: string, s1: string, s2: string, s1Org: string, s2Org: string, buyerOrg: string, approver: string;
  let eventId: string, lot1: string, lot2: string, itemA: string, itemB: string;
  let bid1: string, bid2: string;

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
    ({ token: buyer, org: buyerOrg } = await reg('/auth/register/buyer', `ML Buyer ${tag}`, `mlb-${tag}@t.test`));
    approver = await addApprover(app, buyer, tag);
    ({ token: s1, org: s1Org } = await reg('/auth/register/supplier', `ML S1 ${tag}`, `mls1-${tag}@t.test`));
    ({ token: s2, org: s2Org } = await reg('/auth/register/supplier', `ML S2 ${tag}`, `mls2-${tag}@t.test`));

    await http().put('/requests/method-policies').set(...bearer(buyer))
      .send({ policies: [{ category: '*', minAmountMinor: 0, maxAmountMinor: null, method: 'RFQ' }] }).expect(200);
  });

  afterAll(async () => {
    try {
      // Delete the buyer/event/awards before suppliers/bids. A single multi-org DELETE
      // can cascade supplier bids first and hit awards.winning_bid_id's RESTRICT FK.
      if (buyerOrg) await db.query('DELETE FROM organizations WHERE id = $1', [buyerOrg]);
      await db.query(`DELETE FROM organizations WHERE legal_name LIKE $1`, [`ML %${tag}%`]);
    } finally {
      try { await db.end(); } finally { await app.close(); }
    }
  });

  it('buyer builds a 2-lot RFQ and both suppliers bid', async () => {
    const req = await http().post('/requests').set(...bearer(buyer)).send({
      title: `ML ${tag}`,
      items: [
        { name: 'Item A', qty: 10, estUnitPriceMinor: 100_000 },
        { name: 'Item B', qty: 5, estUnitPriceMinor: 200_000 },
      ],
    }).expect(201);
    await http().post(`/requests/${req.body.id}/submit`).set(...bearer(buyer)).expect(201);
    await http().post(`/requests/${req.body.id}/approve`).set(...bearer(approver)).expect(201);

    const ev = await http().post(`/events/from-request/${req.body.id}`).set(...bearer(buyer))
      .send({ closeAt: new Date(Date.now() + 3600_000).toISOString(), visibility: 'INVITED' }).expect(201);
    eventId = ev.body.id;
    lot1 = ev.body.lots[0].id;
    itemA = ev.body.items.find((i: any) => i.name === 'Item A').id;
    itemB = ev.body.items.find((i: any) => i.name === 'Item B').id;

    // add a second lot and move Item B into it
    const l2 = await http().post(`/events/${eventId}/lots`).set(...bearer(buyer)).send({ title: 'Lot 2' }).expect(201);
    lot2 = l2.body.id;
    await http().put(`/events/${eventId}/items/${itemB}/lot`).set(...bearer(buyer)).send({ lotId: lot2 }).expect(200);

    for (const org of [s1Org, s2Org]) {
      await http().post(`/events/${eventId}/invite`).set(...bearer(buyer)).send({ supplierOrgId: org }).expect(201);
    }
    await http().post(`/events/${eventId}/publish`).set(...bearer(buyer)).expect(201);

    // S1 cheap on A, dear on B; S2 the opposite
    const r1 = await http().post(`/events/${eventId}/bid`).set(...bearer(s1))
      .send({ items: [{ eventItemId: itemA, unitPriceMinor: 90_000 }, { eventItemId: itemB, unitPriceMinor: 210_000 }] }).expect(201);
    bid1 = r1.body.id;
    const r2 = await http().post(`/events/${eventId}/bid`).set(...bearer(s2))
      .send({ items: [{ eventItemId: itemA, unitPriceMinor: 110_000 }, { eventItemId: itemB, unitPriceMinor: 180_000 }] }).expect(201);
    bid2 = r2.body.id;
  });

  it('opening reveals per-lot bid totals', async () => {
    await db.query(`SELECT set_config('app.org_id',$1,false), set_config('app.role','BUYER_ADMIN',false)`, [buyerOrg]);
    await db.query(`UPDATE sourcing_events SET close_at = now() - interval '1 second' WHERE id=$1`, [eventId]);
    await db.query(`SELECT * FROM close_due_events()`);
    const ev = await http().post(`/events/${eventId}/open`).set(...bearer(buyer)).expect(201);
    const total = (lotId: string, bidId: string) =>
      Number(ev.body.lot_bid_totals.find((t: any) => t.lot_id === lotId && t.bid_id === bidId).total_minor);
    expect(total(lot1, bid1)).toBe(900_000); // 10 × 90k
    expect(total(lot1, bid2)).toBe(1_100_000);
    expect(total(lot2, bid1)).toBe(1_050_000);
    expect(total(lot2, bid2)).toBe(900_000); // 5 × 180k
  });

  it('each lot is awarded to its best supplier; event AWARDED only when both are done', async () => {
    // an evaluation must exist before any award; score both opened bids on the locked criteria
    await http().post(`/events/${eventId}/evaluate`).set(...bearer(buyer)).send({
      scores: [
        { bidId: bid1, key: 'price', score: 80 }, { bidId: bid1, key: 'delivery', score: 80 },
        { bidId: bid2, key: 'price', score: 70 }, { bidId: bid2, key: 'delivery', score: 70 },
      ],
    }).expect(201);
    await http().post(`/events/${eventId}/award`).set(...bearer(buyer)).send({ lotId: lot1, bidId: bid1, justification: 'best price for lot 1' }).expect(201);
    let ev = await http().get(`/events/${eventId}`).set(...bearer(buyer)).expect(200);
    expect(ev.body.status).toBe('EVALUATION'); // still one lot open

    await http().post(`/events/${eventId}/award`).set(...bearer(buyer)).send({ lotId: lot2, bidId: bid2, justification: 'best price for lot 2' }).expect(201);
    ev = await http().get(`/events/${eventId}`).set(...bearer(buyer)).expect(200);
    expect(ev.body.status).toBe('AWARDED');
    expect(ev.body.awards).toHaveLength(2);
    const byLot = Object.fromEntries(ev.body.awards.map((a: any) => [a.lot_id, a.winning_bid_id]));
    expect(byLot[lot1]).toBe(bid1);
    expect(byLot[lot2]).toBe(bid2);
  });
  it('lot awards produce separate contract, PO and catalog line snapshots', async () => {
    const ev=(await http().get(`/events/${eventId}`).set(...bearer(buyer)).expect(200)).body;
    expect(ev.awards).toHaveLength(2);
    for(const a of ev.awards){
      const c=(await http().post(`/contracts/from-award/${a.id}`).set(...bearer(buyer)).expect(201)).body;
      expect(Number(c.total_minor)).toBe(900000);
      await http().post(`/contracts/${c.id}/activate`).set(...bearer(buyer)).expect(201);
      const po=(await http().post(`/contracts/${c.id}/orders`).set(...bearer(buyer)).expect(201)).body;
      expect(po.items).toHaveLength(1);expect(Number(po.total_minor)).toBe(900000);
      const cat=(await http().post(`/catalogs/from-contract/${c.id}`).set(...bearer(buyer)).expect(201)).body;
      expect(cat.items).toHaveLength(1);
    }
  });

});
