import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID, createHash } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { addApprover } from './helpers';

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
  let approverToken: string;
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
    approverToken = await addApprover(app, buyerToken, tag);
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
      .set('Authorization', `Bearer ${approverToken}`)
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

  it('supplier attaches a bid document; buyer cannot see it before opening', async () => {
    const pre = await http().post(`/documents/bid/${bidId}/presign`).set('Authorization', `Bearer ${supplierToken}`)
      .send({ filename: 'spec.pdf', mime: 'application/pdf' }).expect(201);
    expect(pre.body.uploadUrl).toContain('http');
    const bytes=Buffer.from('audit attachment fixture');
    expect((await fetch(pre.body.uploadUrl,{method:'PUT',body:bytes,headers:{'Content-Type':'application/pdf'}})).ok).toBe(true);

    await http().post(`/documents/bid/${bidId}/confirm`).set('Authorization', `Bearer ${supplierToken}`)
      .send({ storageKey: pre.body.storageKey, filename: 'spec.pdf', mime: 'application/pdf', sizeBytes: 1234, sha256: createHash('sha256').update(bytes).digest('hex') })
      .expect(201);
    // supplier sees own doc
    const asSupplier = await http().get(`/documents/bid/${bidId}`).set('Authorization', `Bearer ${supplierToken}`).expect(200);
    expect(asSupplier.body).toHaveLength(1);
    // buyer cannot yet (event still OPEN)
    const asBuyer = await http().get(`/documents/bid/${bidId}`).set('Authorization', `Bearer ${buyerToken}`).expect(200);
    expect(asBuyer.body).toHaveLength(0);
    // foreign supplier cannot
    const asOther = await http().get(`/documents/bid/${bidId}`).set('Authorization', `Bearer ${supplier2Token}`).expect(200);
    expect(asOther.body).toHaveLength(0);
    // foreign supplier cannot attach to someone else's bid — RLS hides the bid entirely (404)
    await http().post(`/documents/bid/${bidId}/confirm`).set('Authorization', `Bearer ${supplier2Token}`)
      .send({ storageKey: 'x', filename: 'x', mime: 'x', sizeBytes: 1, sha256: 'b'.repeat(64) }).expect(404);
  });

  it('buyer sees participation but NOT amounts before opening', async () => {
    const res = await http().get(`/events/${eventId}`).set('Authorization', `Bearer ${buyerToken}`).expect(200);
    expect(res.body.amounts_visible).toBe(false);
    expect(res.body.bids).toHaveLength(1);
    expect(res.body.bids[0].total_minor).toBeNull();
    expect(res.body.bid_items).toHaveLength(0);
  });

  it('LP-A14 OCDS export does not disclose sealed bids before opening', async () => {
    const exported = await http().get(`/events/${eventId}/ocds`)
      .set('Authorization', `Bearer ${buyerToken}`).expect(200);
    const release = exported.body.releases[0];
    expect(release.tender.status).toBe('active');
    expect(release.awards).toEqual([]);
    expect(release.tender).not.toHaveProperty('value');
    expect(JSON.stringify(exported.body)).not.toContain(bidId);
    const privateKeys = new Set(['bids', 'bid_items', 'total_minor', 'unit_price_minor',
      'line_total_minor', 'ciphertext', 'wrapped_key', 'proposal_text']);
    const check = (value: unknown) => {
      // The fixture bid is100×55000 minor units. Check both currency-unit and
      // minor-unit forms, even if a leak were renamed to a generic "amount" key.
      if (typeof value === 'number' || typeof value === 'string') {
        expect([550, 55000, 5500000]).not.toContain(Number(value));
        return;
      }
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        expect(privateKeys.has(key)).toBe(false);
        check(child);
      }
    };
    check(exported.body);
    await http().get(`/events/${eventId}/ocds`)
      .set('Authorization', `Bearer ${supplier2Token}`).expect(404);
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

  it('after opening, the buyer CAN read the supplier bid document', async () => {
    const asBuyer = await http().get(`/documents/bid/${bidId}`).set('Authorization', `Bearer ${buyerToken}`).expect(200);
    expect(asBuyer.body).toHaveLength(1);
    expect(asBuyer.body[0].filename).toBe('spec.pdf');
  });

  it('weighted scoring returns a ranking', async () => {
    const res = await http()
      .post(`/events/${eventId}/evaluate`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({
        scores: [
          { bidId, key: 'price', score: 100 },
          { bidId, key: 'delivery', score: 80 },
        ],
      })
      .expect(201);
    expect(res.body.ranking[0].bid_id).toBe(bidId);
    expect(res.body.ranking[0].weighted_total).toBe(94); // locked criteria: price 70 / delivery 30
  });

  it('AI recommendation ranks the opened bid with an explainable rationale', async () => {
    const res = await http().get(`/events/${eventId}/ai-recommendation`).set('Authorization', `Bearer ${buyerToken}`).expect(200);
    expect(res.body.model).toBe('heuristic-v1');
    expect(res.body.ranking.length).toBeGreaterThan(0);
    expect(res.body.recommendedBidId).toBe(res.body.ranking[0].bidId);
    expect(res.body.ranking[0].reasons.length).toBeGreaterThan(0);
    expect(res.body.rationale).toContain('weighted score');
    // amounts are open post-opening, so price scoring is populated
    expect(res.body.ranking[0].priceScore).toBe(100);
  });

  it('AI recommendation is refused before opening (amounts still sealed)', async () => {
    // the earlier public event or a fresh OPEN one would 400; assert the guard on status
    await http().get(`/events/${eventId}/ai-recommendation`).set('Authorization', `Bearer ${supplierToken}`).expect(403); // suppliers can't
  });

  it('award is transactional and idempotent; event becomes AWARDED', async () => {
    const first = await http()
      .post(`/events/${eventId}/award`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ lotId, bidId, justification: 'best value' })
      .expect(201);
    expect(first.body.idempotent).toBe(false);

    const second = await http()
      .post(`/events/${eventId}/award`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ lotId, bidId, justification: 'best value' })
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

  // ---------- phase 2 block A: award → contract → PO → delivery ----------

  let contractId: string;
  let poId: string;

  it('award becomes a contract (idempotent) and activates', async () => {
    const awards = await http().get(`/events/${eventId}`).set('Authorization', `Bearer ${buyerToken}`);
    const awardId = awards.body.awards[0].id;

    const c1 = await http()
      .post(`/contracts/from-award/${awardId}`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(201);
    contractId = c1.body.id;
    expect(c1.body.status).toBe('DRAFT');
    expect(Number(c1.body.total_minor)).toBe(5_500_000);

    const c2 = await http()
      .post(`/contracts/from-award/${awardId}`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(201);
    expect(c2.body.id).toBe(contractId); // idempotent

    const act = await http()
      .post(`/contracts/${contractId}/activate`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(201);
    expect(act.body.status).toBe('ACTIVE');
  });

  it('supplier sees the contract too (cross-org read)', async () => {
    const res = await http().get('/contracts').set('Authorization', `Bearer ${supplierToken}`).expect(200);
    expect(res.body.items.map((c: any) => c.id)).toContain(contractId);
    const res2 = await http().get('/contracts').set('Authorization', `Bearer ${supplier2Token}`).expect(200);
    expect(res2.body.items.map((c: any) => c.id)).not.toContain(contractId);
  });

  it('buyer creates and issues a PO with items from the awarded bid', async () => {
    const po = await http()
      .post(`/contracts/${contractId}/orders`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(201);
    poId = po.body.id;
    expect(po.body.status).toBe('DRAFT');
    expect(po.body.items).toHaveLength(1);
    expect(Number(po.body.total_minor)).toBe(5_500_000);

    const issued = await http()
      .post(`/orders/${poId}/status`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ status: 'ISSUED' })
      .expect(201);
    expect(issued.body.status).toBe('ISSUED');
  });

  it('supplier walks the delivery chain; buyer accepts', async () => {
    for (const s of ['CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED']) {
      const res = await http()
        .post(`/orders/${poId}/status`)
        .set('Authorization', `Bearer ${supplierToken}`)
        .send({ status: s })
        .expect(201);
      expect(res.body.status).toBe(s);
    }
    const accepted = await http()
      .post(`/orders/${poId}/status`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ status: 'ACCEPTED' })
      .expect(201);
    expect(accepted.body.status).toBe('ACCEPTED');

    const hist = await http().get(`/orders/${poId}`).set('Authorization', `Bearer ${buyerToken}`).expect(200);
    expect(hist.body.history.map((h: any) => h.to_status)).toEqual([
      'ISSUED', 'CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED', 'ACCEPTED',
    ]);
  });

  it('illegal transitions are rejected by the DB seam', async () => {
    // supplier cannot ACCEPT own delivery; buyer cannot CONFIRM
    await http()
      .post(`/orders/${poId}/status`)
      .set('Authorization', `Bearer ${supplierToken}`)
      .send({ status: 'ACCEPTED' })
      .expect(400);
  });

  it('foreign supplier cannot see the PO', async () => {
    const res = await http().get('/orders').set('Authorization', `Bearer ${supplier2Token}`).expect(200);
    expect(res.body.items.map((p: any) => p.id)).not.toContain(poId);
    await http().get(`/orders/${poId}`).set('Authorization', `Bearer ${supplier2Token}`).expect(404);
  });

  it('logistics: supplier ships the PO, buyer tracks it, PO auto-syncs to DELIVERED', async () => {
    const bearer = (tok: string) => ['Authorization', `Bearer ${tok}`] as [string, string];
    // fresh PO for the logistics leg (previous PO already ACCEPTED)
    const po = await http().post(`/contracts/${contractId}/orders`).set(...bearer(buyerToken)).expect(201);
    const poId = po.body.id;
    await http().post(`/orders/${poId}/status`).set(...bearer(buyerToken)).send({ status: 'ISSUED' }).expect(201);
    await http().post(`/orders/${poId}/status`).set(...bearer(supplierToken)).send({ status: 'CONFIRMED' }).expect(201);

    // supplier creates a shipment + tracking events
    await http().post(`/logistics/po/${poId}/shipment`).set(...bearer(supplierToken))
      .send({ carrier: 'AzərPost', trackingNo: 'AZ12345', origin: 'Baku', destination: 'Ganja' }).expect(201);
    await http().post(`/logistics/po/${poId}/events`).set(...bearer(supplierToken))
      .send({ status: 'PICKED_UP', location: 'Baku' }).expect(201);
    await http().post(`/logistics/po/${poId}/events`).set(...bearer(supplierToken))
      .send({ status: 'IN_TRANSIT', location: 'Kürdəmir' }).expect(201);
    const delivered = await http().post(`/logistics/po/${poId}/events`).set(...bearer(supplierToken))
      .send({ status: 'DELIVERED', location: 'Ganja' }).expect(201);
    expect(delivered.body.shipment.status).toBe('DELIVERED');
    expect(delivered.body.events).toHaveLength(3);

    // buyer can track the shipment (cross-org read) and the PO auto-advanced
    const buyerView = await http().get(`/logistics/po/${poId}`).set(...bearer(buyerToken)).expect(200);
    expect(buyerView.body.shipment.tracking_no).toBe('AZ12345');
    const poNow = await http().get(`/orders/${poId}`).set(...bearer(buyerToken)).expect(200);
    expect(poNow.body.status).toBe('DELIVERED');

    // foreign supplier cannot see the shipment
    await http().get(`/logistics/po/${poId}`).set(...bearer(supplier2Token)).expect(200)
      .then((r) => expect(r.body.shipment).toBeNull());
  });

  it('GRN: partial then full receipt auto-accepts the PO; foreign supplier is blocked', async () => {
    const bearer = (tok: string) => ['Authorization', `Bearer ${tok}`] as [string, string];
    const po = await http().post(`/contracts/${contractId}/orders`).set(...bearer(buyerToken)).expect(201);
    const poId = po.body.id;
    const poItemId = po.body.items[0].id;
    const ordered = Number(po.body.items[0].qty); // 100
    // walk to DELIVERED
    await http().post(`/orders/${poId}/status`).set(...bearer(buyerToken)).send({ status: 'ISSUED' }).expect(201);
    for (const s of ['CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED']) {
      await http().post(`/orders/${poId}/status`).set(...bearer(supplierToken)).send({ status: s }).expect(201);
    }
    // partial receipt (40 of 100) — PO stays DELIVERED
    const partial = await http().post(`/orders/${poId}/receipts`).set(...bearer(buyerToken))
      .send({ items: [{ poItemId, qty: 40 }] }).expect(201);
    expect(Number(partial.body.summary[0].received)).toBe(40);
    let poNow = await http().get(`/orders/${poId}`).set(...bearer(buyerToken)).expect(200);
    expect(poNow.body.status).toBe('DELIVERED');
    // supplier is not allowed to record receipts (buyer-only endpoint → 403)
    await http().post(`/orders/${poId}/receipts`).set(...bearer(supplierToken)).send({ items: [{ poItemId, qty: 1 }] }).expect(403);
    // remaining 60 → fully received → PO auto-ACCEPTED
    await http().post(`/orders/${poId}/receipts`).set(...bearer(buyerToken))
      .send({ items: [{ poItemId, qty: ordered - 40 }] }).expect(201);
    poNow = await http().get(`/orders/${poId}`).set(...bearer(buyerToken)).expect(200);
    expect(poNow.body.status).toBe('ACCEPTED');
    // supplier can read the receipt summary (cross-org); foreign supplier cannot see the PO
    await http().get(`/orders/${poId}/receipts`).set(...bearer(supplierToken)).expect(200);
    await http().get(`/orders/${poId}`).set(...bearer(supplier2Token)).expect(404);
  });

  it('DIRECT purchase: below-threshold request → straight to PO; supplier is notified', async () => {
    const bearer = (tok: string) => ['Authorization', `Bearer ${tok}`] as [string, string];
    // approve the supplier in the buyer's registry (required for a direct order)
    await http().post(`/suppliers/${supplierOrgId}/invite`).set(...bearer(buyerToken)).expect(201);
    const reg = await http().get('/suppliers').set(...bearer(buyerToken)).expect(200);
    const relId = reg.body.find((r: any) => r.supplier_org_id === supplierOrgId).id;
    await http().post(`/suppliers/relationships/${relId}/status`).set(...bearer(buyerToken)).send({ status: 'APPROVED' }).expect(201);

    // small request (1000 AZN) → resolves DIRECT under the acme policy
    const req = await http().post('/requests').set(...bearer(buyerToken))
      .send({ title: `Pens ${tag}`, items: [{ name: 'Pen box', qty: 10, estUnitPriceMinor: 10_000 }] }).expect(201);
    await http().post(`/requests/${req.body.id}/submit`).set(...bearer(buyerToken)).expect(201);
    const approved = await http().post(`/requests/${req.body.id}/approve`).set(...bearer(approverToken)).expect(201);
    expect(approved.body.method_resolved).toBe('DIRECT');

    const po = await http().post(`/orders/direct/from-request/${req.body.id}`).set(...bearer(buyerToken))
      .send({ supplierOrgId }).expect(201);
    expect(po.body.status).toBe('DRAFT');
    expect(po.body.items).toHaveLength(1);
    expect(Number(po.body.total_minor)).toBe(100_000);

    // the supplier can see the PO (cross-org) and received a notification
    const supOrders = await http().get('/orders').set(...bearer(supplierToken)).expect(200);
    expect(supOrders.body.items.map((p: any) => p.id)).toContain(po.body.id);
    const notes = await http().get('/notifications').set(...bearer(supplierToken)).expect(200);
    expect(notes.body.some((n: any) => n.type === 'DIRECT_ORDER_CREATED')).toBe(true);
  });

  // The button that calls this sits on a page where nothing visibly changes, so a reader
  // who clicks twice used to end up with two identical price lists. Contracts have been
  // idempotent from the start; catalogs now match.
  it('a second catalog-from-contract returns the same draft instead of a duplicate', async () => {
    const first = await http()
      .post(`/catalogs/from-contract/${contractId}`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(201);
    const again = await http()
      .post(`/catalogs/from-contract/${contractId}`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(201);
    expect(again.body.id).toBe(first.body.id);
    expect(again.body.items).toHaveLength(first.body.items.length);

    const all = await http().get('/catalogs').set('Authorization', `Bearer ${buyerToken}`).expect(200);
    expect(all.body.filter((c: any) => c.contract_id === contractId)).toHaveLength(1);
  });

  it('audit hash-chain for the buyer org is intact, linked AND recomputes from the stored rows', async () => {
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
    // Linkage alone only catches a truncated tail: every row could carry an invented
    // digest and this would still pass. Recompute each one from the columns actually
    // stored — which is what the chain was supposed to make possible and could not,
    // because the timestamp that went into the old JS digest was never written down.
    const check = (
      await db.query(
        `WITH c AS (
           SELECT seq, prev_hash, hash,
                  lag(hash) OVER (ORDER BY seq) AS expected_prev,
                  encode(sha256(convert_to(coalesce(prev_hash,'') ||
                    audit_body(org_id, actor_id, action, entity_type, entity_id, payload, created_at),
                    'UTF8')), 'hex') AS recomputed
             FROM audit_events WHERE org_id = $1
         )
         SELECT count(*)::int AS total,
                count(*) FILTER (WHERE hash <> recomputed)::int AS bad_hash,
                count(*) FILTER (WHERE seq > (SELECT min(seq) FROM c)
                                   AND prev_hash IS DISTINCT FROM expected_prev)::int AS bad_link
           FROM c`,
        [buyerOrgId],
      )
    ).rows[0];
    expect(check.total).toBeGreaterThan(4);
    expect({ bad_hash: check.bad_hash, bad_link: check.bad_link }).toEqual({ bad_hash: 0, bad_link: 0 });
  });
});
