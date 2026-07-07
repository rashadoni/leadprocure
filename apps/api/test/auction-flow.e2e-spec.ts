import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { addApprover } from './helpers';

/**
 * Reverse auction: descending price with min-decrement, anti-sniping extension,
 * anonymous best-price state, finalize → award. Plus Q&A equal-disclosure rules.
 */
describe('reverse auction + Q&A flow', () => {
  let app: INestApplication;
  let db: Client;
  const tag = randomUUID().slice(0, 8);

  let buyerToken: string, buyerOrgId: string;
  let approverToken: string;
  let s1Token: string, s1OrgId: string;
  let s2Token: string, s2OrgId: string;
  let requestId: string, eventId: string, lotId: string, itemId: string;
  let qnaId: string;

  const http = () => request(app.getHttpServer());
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();

    const reg = async (path: string, name: string, email: string) => {
      const res = await http().post(path).send({ legalName: name, email, password: 'password123', fullName: name }).expect(201);
      return { token: res.body.accessToken, orgId: res.body.org.id };
    };
    ({ token: buyerToken, orgId: buyerOrgId } = await reg('/auth/register/buyer', `Auc Buyer ${tag}`, `ab-${tag}@t.test`));
    approverToken = await addApprover(app, buyerToken, tag);
    ({ token: s1Token, orgId: s1OrgId } = await reg('/auth/register/supplier', `Auc Sup1 ${tag}`, `as1-${tag}@t.test`));
    ({ token: s2Token, orgId: s2OrgId } = await reg('/auth/register/supplier', `Auc Sup2 ${tag}`, `as2-${tag}@t.test`));

    await http().put('/requests/method-policies').set(auth(buyerToken))
      .send({ policies: [{ category: '*', minAmountMinor: 0, maxAmountMinor: null, method: 'RFQ' }] })
      .expect(200);

    // request 100 × 1000 AZN = 100k AZN
    const req = await http().post('/requests').set(auth(buyerToken))
      .send({ title: `Auction ${tag}`, items: [{ name: 'Cable km', qty: 100, estUnitPriceMinor: 100_000 }] })
      .expect(201);
    requestId = req.body.id;
    await http().post(`/requests/${requestId}/submit`).set(auth(buyerToken)).expect(201);
    await http().post(`/requests/${requestId}/approve`).set(auth(approverToken)).expect(201);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM organizations WHERE legal_name LIKE $1`, [`Auc %${tag}%`]);
    await db.end();
    await app.close();
  });

  it('buyer creates and publishes a reverse auction', async () => {
    const closeAt = new Date(Date.now() + 3600_000).toISOString();
    const ev = await http().post(`/events/reverse/from-request/${requestId}`).set(auth(buyerToken))
      .send({ closeAt, visibility: 'INVITED', startPriceMinor: 10_000_000, minDecrementMinor: 100_000 })
      .expect(201);
    eventId = ev.body.id;
    for (const org of [s1OrgId, s2OrgId]) {
      await http().post(`/events/${eventId}/invite`).set(auth(buyerToken)).send({ supplierOrgId: org }).expect(201);
    }
    const pub = await http().post(`/events/${eventId}/publish`).set(auth(buyerToken)).expect(201);
    expect(pub.body.status).toBe('OPEN');
    lotId = pub.body.lots[0].id;
    itemId = pub.body.items[0].id;
  });

  it('first bid must not exceed the start price', async () => {
    await http().post(`/events/${eventId}/auction/bids`).set(auth(s1Token))
      .send({ items: [{ eventItemId: itemId, unitPriceMinor: 101_000 }] }) // 10.1M > 10M start
      .expect(400);
    const ok = await http().post(`/events/${eventId}/auction/bids`).set(auth(s1Token))
      .send({ items: [{ eventItemId: itemId, unitPriceMinor: 99_000 }] }) // 9.9M
      .expect(201);
    expect(ok.body.total_minor).toBe(9_900_000);
  });

  it('next bid must beat best by the min decrement', async () => {
    // 9.85M > 9.9M − 0.1M = 9.8M → rejected
    await http().post(`/events/${eventId}/auction/bids`).set(auth(s2Token))
      .send({ items: [{ eventItemId: itemId, unitPriceMinor: 98_500 }] })
      .expect(400);
    const ok = await http().post(`/events/${eventId}/auction/bids`).set(auth(s2Token))
      .send({ items: [{ eventItemId: itemId, unitPriceMinor: 98_000 }] }) // 9.8M
      .expect(201);
    expect(ok.body.total_minor).toBe(9_800_000);
  });

  it('anonymous state shows best price and next max, plus my own best', async () => {
    const s1 = await http().get(`/events/${eventId}/auction/state`).set(auth(s1Token)).expect(200);
    expect(s1.body.best_total_minor).toBe(9_800_000);
    expect(s1.body.next_max_total_minor).toBe(9_700_000);
    expect(s1.body.distinct_bidders).toBe(2);
    expect(s1.body.my_best_total_minor).toBe(9_900_000); // s1's own, not the winner's
  });

  it('supplier cannot read competitors from the ledger directly', async () => {
    await db.query(`SELECT set_config('app.org_id',$1,false), set_config('app.role','SUPPLIER_USER',false)`, [s1OrgId]);
    const rows = await db.query(`SELECT DISTINCT supplier_org_id FROM auction_bids WHERE event_id=$1`, [eventId]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].supplier_org_id).toBe(s1OrgId);
  });

  it('a bid near the deadline extends the auction (anti-sniping)', async () => {
    await db.query(`SELECT set_config('app.org_id',$1,false), set_config('app.role','BUYER_ADMIN',false)`, [buyerOrgId]);
    await db.query(`UPDATE sourcing_events SET close_at = now() + interval '30 seconds' WHERE id=$1`, [eventId]);
    const res = await http().post(`/events/${eventId}/auction/bids`).set(auth(s1Token))
      .send({ items: [{ eventItemId: itemId, unitPriceMinor: 97_000 }] }) // 9.7M
      .expect(201);
    expect(res.body.extended).toBe(true);
    const state = await http().get(`/events/${eventId}/auction/state`).set(auth(buyerToken)).expect(200);
    expect(state.body.extension_count).toBe(1);
    expect(new Date(state.body.close_at).getTime()).toBeGreaterThan(Date.now() + 60_000);
  });

  it('idempotency key returns the same tick on retry', async () => {
    const key = `idem-${tag}`;
    const a = await http().post(`/events/${eventId}/auction/bids`).set(auth(s2Token))
      .send({ items: [{ eventItemId: itemId, unitPriceMinor: 95_000 }], idempotencyKey: key })
      .expect(201);
    const b = await http().post(`/events/${eventId}/auction/bids`).set(auth(s2Token))
      .send({ items: [{ eventItemId: itemId, unitPriceMinor: 90_000 }], idempotencyKey: key })
      .expect(201);
    expect(b.body.idempotent).toBe(true);
    expect(Number(b.body.total_minor)).toBe(Number(a.body.total_minor));
  });

  it('close → finalize → award the best bid', async () => {
    await db.query(`SELECT set_config('app.org_id',$1,false), set_config('app.role','BUYER_ADMIN',false)`, [buyerOrgId]);
    await db.query(`UPDATE sourcing_events SET close_at = now() - interval '1 second' WHERE id=$1`, [eventId]);
    await db.query(`SELECT * FROM close_due_events()`);
    await http().post(`/events/${eventId}/auction/finalize`).set(auth(buyerToken)).expect(201);

    const ev = await http().get(`/events/${eventId}`).set(auth(buyerToken)).expect(200);
    expect(ev.body.status).toBe('EVALUATION');
    const best = ev.body.bids.reduce((a: any, b: any) => (Number(a.total_minor) < Number(b.total_minor) ? a : b));
    expect(Number(best.total_minor)).toBe(9_500_000);

    await http().post(`/events/${eventId}/award`).set(auth(buyerToken))
      .send({ lotId, bidId: best.id }).expect(201);
    const done = await http().get(`/events/${eventId}`).set(auth(buyerToken)).expect(200);
    expect(done.body.status).toBe('AWARDED');
  });

  describe('Q&A equal disclosure', () => {
    let qEventId: string;

    beforeAll(async () => {
      // fresh OPEN RFQ so Q&A window is active
      const req = await http().post('/requests').set(auth(buyerToken))
        .send({ title: `Auc QnA ${tag}`, items: [{ name: 'Pipe', qty: 10, estUnitPriceMinor: 700_000 }] })
        .expect(201);
      await http().post(`/requests/${req.body.id}/submit`).set(auth(buyerToken)).expect(201);
      await http().post(`/requests/${req.body.id}/approve`).set(auth(approverToken)).expect(201);
      const ev = await http().post(`/events/from-request/${req.body.id}`).set(auth(buyerToken))
        .send({ closeAt: new Date(Date.now() + 3600_000).toISOString(), visibility: 'INVITED' }).expect(201);
      qEventId = ev.body.id;
      for (const org of [s1OrgId, s2OrgId]) {
        await http().post(`/events/${qEventId}/invite`).set(auth(buyerToken)).send({ supplierOrgId: org }).expect(201);
      }
      await http().post(`/events/${qEventId}/publish`).set(auth(buyerToken)).expect(201);
    });

    it('supplier asks; the other supplier does NOT see the unpublished question', async () => {
      const q = await http().post(`/events/${qEventId}/qna`).set(auth(s1Token))
        .send({ question: 'Какая марка стали?' }).expect(201);
      qnaId = q.body.id;
      const forS2 = await http().get(`/events/${qEventId}/qna`).set(auth(s2Token)).expect(200);
      expect(forS2.body).toHaveLength(0);
      const forBuyer = await http().get(`/events/${qEventId}/qna`).set(auth(buyerToken)).expect(200);
      expect(forBuyer.body).toHaveLength(1);
    });

    it('published answer becomes visible to ALL suppliers equally', async () => {
      await http().post(`/events/${qEventId}/qna/${qnaId}/answer`).set(auth(buyerToken))
        .send({ answer: 'Сталь 09Г2С' }).expect(201);
      const forS2 = await http().get(`/events/${qEventId}/qna`).set(auth(s2Token)).expect(200);
      expect(forS2.body).toHaveLength(1);
      expect(forS2.body[0].answer).toBe('Сталь 09Г2С');
      expect(forS2.body[0].mine).toBe(false);
    });

    it('buyer publishes an addendum visible to everyone', async () => {
      await http().post(`/events/${qEventId}/addenda`).set(auth(buyerToken))
        .send({ text: 'Срок поставки продлён до 30 дней' }).expect(201);
      const forS1 = await http().get(`/events/${qEventId}/qna`).set(auth(s1Token)).expect(200);
      expect(forS1.body.some((r: any) => r.kind === 'ADDENDUM')).toBe(true);
    });
  });
});
