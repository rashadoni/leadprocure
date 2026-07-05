import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';

/**
 * Full sealed-RFQ lifecycle over the real API:
 * request → approve (method policy) → event → invite → publish → sealed bid
 * → amounts hidden → deadline close → opening ceremony → scoring → award → OCDS.
 * Plus the negative marketplace checks a hostile supplier would try.
 */
describe('sealed RFQ end-to-end flow', () => {
  let app: INestApplication;
  let db: Client;
  const tag = randomUUID().slice(0, 8);

  let buyerToken: string;
  let buyerOrgId: string;
  let supplierToken: string;
  let supplierOrgId: string;
  let supplier2Token: string;

  let requestId: string;
  let eventId: string;
  let lotId: string;
  let eventItemId: string;
  let bidId: string;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();

    const reg = async (path: string, name: string, email: string) => {
      const res = await http()
        .post(path)
        .send({ legalName: name, email, password: 'password123', fullName: name })
        .expect(201);
      return { token: res.body.accessToken as string, orgId: res.body.org.id as string };
    };
    const b = await reg('/auth/register/buyer', `Flow Buyer ${tag}`, `buyer-${tag}@t.test`);
    buyerToken = b.token;
    buyerOrgId = b.orgId;
    const s = await reg('/auth/register/supplier', `Flow Supplier ${tag}`, `sup-${tag}@t.test`);
    supplierToken = s.token;
    supplierOrgId = s.orgId;
    const s2 = await reg('/auth/register/supplier', `Flow Supplier2 ${tag}`, `sup2-${tag}@t.test`);
    supplier2Token = s2.token;
  });

  afterAll(async () => {
    await db.query(`DELETE FROM organizations WHERE legal_name LIKE $1`, [`Flow %${tag}%`]);
    await db.end();
    await app.close();
  });

  it('buyer configures method policy (over 50k AZN → RFQ)', async () => {
    await http()
      .put('/requests/method-policies')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({
        policies: [
          { category: '*', minAmountMinor: 0, maxAmountMinor: 5_000_000, method: 'DIRECT' },
          { category: '*', minAmountMinor: 5_000_000, maxAmountMinor: null, method: 'RFQ' },
        ],
      })
      .expect(200);
  });

  it('request over the threshold resolves to RFQ on approval', async () => {
    const created = await http()
      .post('/requests')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({
        title: `Workwear batch ${tag}`,
        items: [{ name: 'Workwear set', qty: 100, estUnitPriceMinor: 60_000 }], // 60k AZN total
      })
      .expect(201);
    requestId = created.body.id;
    expect(Number(created.body.estimated_total_minor)).toBe(6_000_000);

    await http().post(`/requests/${requestId}/submit`).set('Authorization', `Bearer ${buyerToken}`).expect(201);
    const approved = await http()
      .post(`/requests/${requestId}/approve`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(201);
    expect(approved.body.method_resolved).toBe('RFQ');
  });

  it('buyer creates an INVITED sealed RFQ from the request and publishes it', async () => {
    const closeAt = new Date(Date.now() + 3600_000).toISOString();
    const ev = await http()
      .post(`/events/from-request/${requestId}`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ closeAt, visibility: 'INVITED' })
      .expect(201);
    eventId = ev.body.id;
    lotId = ev.body.lots[0].id;
    eventItemId = ev.body.items[0].id;
    expect(ev.body.status).toBe('DRAFT');

    await http()
      .post(`/events/${eventId}/invite`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ supplierOrgId })
      .expect(201);
    const published = await http()
      .post(`/events/${eventId}/publish`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(201);
    expect(published.body.status).toBe('OPEN');
  });

  it('invited supplier sees the event; uninvited supplier does not', async () => {
    await http().get(`/events/${eventId}`).set('Authorization', `Bearer ${supplierToken}`).expect(200);
    await http().get(`/events/${eventId}`).set('Authorization', `Bearer ${supplier2Token}`).expect(404);
  });

  it('supplier submits a sealed bid; uninvited supplier cannot', async () => {
    const res = await http()
      .post(`/events/${eventId}/bid`)
      .set('Authorization', `Bearer ${supplierToken}`)
      .send({ items: [{ eventItemId, unitPriceMinor: 55_000 }], deliveryDays: 14 })
      .expect(201);
    bidId = res.body.id;
    expect(res.body.payload_sha256).toHaveLength(64);

    await http()
      .post(`/events/${eventId}/bid`)
      .set('Authorization', `Bearer ${supplier2Token}`)
      .send({ items: [{ eventItemId, unitPriceMinor: 1 }] })
      .expect(404);
  });

  it('buyer sees participation but NOT amounts before opening', async () => {
    const res = await http().get(`/events/${eventId}`).set('Authorization', `Bearer ${buyerToken}`).expect(200);
    expect(res.body.amounts_visible).toBe(false);
    expect(res.body.bids).toHaveLength(1);
    expect(res.body.bids[0].total_minor).toBeNull();
    expect(res.body.bid_items).toHaveLength(0);
  });

  it('opening before the deadline is refused', async () => {
    await http().post(`/events/${eventId}/open`).set('Authorization', `Bearer ${buyerToken}`).expect(400);
  });

  it('deadline passes → scheduler closes the event', async () => {
    await db.query(`SELECT set_config('app.org_id', $1, false), set_config('app.role','BUYER_ADMIN', false)`, [buyerOrgId]);
    await db.query(`UPDATE sourcing_events SET close_at = now() - interval '1 second' WHERE id=$1`, [eventId]);
    const closed = await db.query(`SELECT * FROM close_due_events()`);
    expect(closed.rows.map((r) => r.event_id)).toContain(eventId);
  });

  it('opening ceremony decrypts amounts and moves to EVALUATION', async () => {
    const res = await http().post(`/events/${eventId}/open`).set('Authorization', `Bearer ${buyerToken}`).expect(201);
    expect(res.body.status).toBe('EVALUATION');
    expect(res.body.amounts_visible).toBe(true);
    expect(Number(res.body.bids[0].total_minor)).toBe(5_500_000);
    expect(res.body.bid_items.length).toBe(1);
  });

  it('weighted scoring returns a ranking', async () => {
    const res = await http()
      .post(`/events/${eventId}/evaluate`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({
        criteria: [{ key: 'price', weight: 70 }, { key: 'delivery', weight: 30 }],
        scores: [
          { bidId, key: 'price', score: 100 },
          { bidId, key: 'delivery', score: 80 },
        ],
      })
      .expect(201);
    expect(res.body.ranking[0].bid_id).toBe(bidId);
    expect(res.body.ranking[0].weighted_total).toBe(94);
  });

  it('award is transactional and idempotent; event becomes AWARDED', async () => {
    const first = await http()
      .post(`/events/${eventId}/award`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ lotId, bidId })
      .expect(201);
    expect(first.body.idempotent).toBe(false);

    const second = await http()
      .post(`/events/${eventId}/award`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ lotId, bidId })
      .expect(201);
    expect(second.body.idempotent).toBe(true);

    const ev = await http().get(`/events/${eventId}`).set('Authorization', `Bearer ${buyerToken}`).expect(200);
    expect(ev.body.status).toBe('AWARDED');
  });

  it('OCDS release exports tender + award', async () => {
    const res = await http().get(`/events/${eventId}/ocds`).set('Authorization', `Bearer ${buyerToken}`).expect(200);
    const release = res.body.releases[0];
    expect(release.ocid).toBe(`ocds-lp-${eventId}`);
    expect(release.tag).toEqual(expect.arrayContaining(['tender', 'award']));
    expect(release.tender.items).toHaveLength(1);
  });

  it('audit hash-chain for the buyer org is intact and linked', async () => {
    await db.query(`SELECT set_config('app.org_id', $1, false), set_config('app.role','BUYER_ADMIN', false)`, [buyerOrgId]);
    const rows = (
      await db.query(`SELECT action, prev_hash, hash FROM audit_events WHERE org_id=$1 ORDER BY seq`, [buyerOrgId])
    ).rows;
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['ORG_REGISTERED', 'REQUEST_APPROVED', 'EVENT_PUBLISHED', 'EVENT_OPENED', 'EVENT_AWARDED']),
    );
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].prev_hash).toBe(rows[i - 1].hash); // unbroken chain
    }
  });
});
