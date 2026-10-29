import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { addApprover } from './helpers';

// RFI/RFP event types on the sealed core. RFP = prices + technical proposal sealed
// together, revealed only at opening, then normal evaluate/award. RFI = response text
// only (no prices), sealed until opening for equal treatment; no evaluation, no award.
describe('RFI / RFP events (API e2e)', () => {
  let app: INestApplication;
  let db: Client;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ['Authorization', `Bearer ${t}`] as [string, string];
  let buyer: string, supplier: string, supplierOrg: string, approver: string;

  const mkEvent = async (type: 'RFQ' | 'RFP' | 'RFI', criteria?: any[]) => {
    const req = await http().post('/requests').set(...bearer(buyer))
      .send({ title: `${type} ${tag} ${randomUUID().slice(0, 4)}`, items: [{ name: 'Consulting', qty: 1, estUnitPriceMinor: 500_000 }] })
      .expect(201);
    await http().post(`/requests/${req.body.id}/submit`).set(...bearer(buyer)).expect(201);
    await http().post(`/requests/${req.body.id}/approve`).set(...bearer(approver)).expect(201);
    const closeAt = new Date(Date.now() + 3600_000).toISOString();
    const ev = await http().post(`/events/from-request/${req.body.id}`).set(...bearer(buyer))
      .send({ closeAt, visibility: 'INVITED', type, ...(criteria ? { criteria } : {}) }).expect(201);
    await http().post(`/events/${ev.body.id}/invite`).set(...bearer(buyer)).send({ supplierOrgId: supplierOrg }).expect(201);
    await http().post(`/events/${ev.body.id}/publish`).set(...bearer(buyer)).expect(201);
    const detail = await http().get(`/events/${ev.body.id}`).set(...bearer(buyer)).expect(200);
    return { id: ev.body.id as string, itemId: detail.body.items[0].id as string };
  };

  const forceCloseAndOpen = async (eventId: string) => {
    await db.query(`UPDATE sourcing_events SET close_at = now() - interval '1 second' WHERE id = $1`, [eventId]);
    await db.query(`SELECT * FROM close_due_events()`);
    return http().post(`/events/${eventId}/open`).set(...bearer(buyer)).expect(201);
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    db = new Client({ connectionString: process.env.DATABASE_OWNER_URL ?? process.env.DATABASE_URL });
    await db.connect();
    const reg = async (path: string, name: string, email: string) => {
      const r = await http().post(path).send({ legalName: name, email, password: 'password123', fullName: name }).expect(201);
      return { token: r.body.accessToken as string, org: r.body.org.id as string };
    };
    ({ token: buyer } = await reg('/auth/register/buyer', `Rfx Buyer ${tag}`, `rb-${tag}@t.test`));
    approver = await addApprover(app, buyer, tag);
    ({ token: supplier, org: supplierOrg } = await reg('/auth/register/supplier', `Rfx Sup ${tag}`, `rs-${tag}@t.test`));
    await http().put('/requests/method-policies').set(...bearer(buyer))
      .send({ policies: [{ category: '*', minAmountMinor: 0, maxAmountMinor: null, method: 'RFQ' }] }).expect(200);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM organizations WHERE legal_name LIKE $1`, [`Rfx %${tag}%`]);
    await db.end();
    await app.close();
  });

  it('RFQ stays the default type', async () => {
    const req = await http().post('/requests').set(...bearer(buyer))
      .send({ title: `Def ${tag}`, items: [{ name: 'x', qty: 1, estUnitPriceMinor: 100 }] }).expect(201);
    await http().post(`/requests/${req.body.id}/submit`).set(...bearer(buyer)).expect(201);
    await http().post(`/requests/${req.body.id}/approve`).set(...bearer(approver)).expect(201);
    const ev = await http().post(`/events/from-request/${req.body.id}`).set(...bearer(buyer))
      .send({ closeAt: new Date(Date.now() + 3600_000).toISOString() }).expect(201);
    const detail = await http().get(`/events/${ev.body.id}`).set(...bearer(buyer)).expect(200);
    expect(detail.body.type).toBe('RFQ');
  });

  describe('RFP', () => {
    let evId: string, itemId: string;

    it('a bid without a technical proposal is rejected; with one it is sealed', async () => {
      ({ id: evId, itemId } = await mkEvent('RFP', [{ key: 'price', weight: 60 }, { key: 'quality', weight: 40 }]));
      await http().post(`/events/${evId}/bid`).set(...bearer(supplier))
        .send({ items: [{ eventItemId: itemId, unitPriceMinor: 450_000 }] }).expect(400);
      await http().post(`/events/${evId}/bid`).set(...bearer(supplier))
        .send({ items: [{ eventItemId: itemId, unitPriceMinor: 450_000 }], proposalText: 'Our methodology: agile, 2 senior engineers' })
        .expect(201);
    });

    it('the proposal text is NOT visible to the buyer before opening', async () => {
      const detail = await http().get(`/events/${evId}`).set(...bearer(buyer)).expect(200);
      expect(JSON.stringify(detail.body)).not.toContain('methodology');
      expect(detail.body.bids[0].total_minor).toBeNull();
    });

    it('opening reveals prices AND the proposal; evaluation/award still work', async () => {
      await forceCloseAndOpen(evId);
      const detail = await http().get(`/events/${evId}`).set(...bearer(buyer)).expect(200);
      expect(detail.body.bids[0].proposal_text).toContain('methodology');
      expect(Number(detail.body.bids[0].total_minor)).toBe(450_000);
      const bidId = detail.body.bids[0].id;
      const lotId = detail.body.lots[0].id;
      await http().post(`/events/${evId}/evaluate`).set(...bearer(buyer))
        .send({ scores: [{ bidId, key: 'price', score: 90 }, { bidId, key: 'quality', score: 80 }] })
        .expect(201);
      await http().post(`/events/${evId}/award`).set(...bearer(buyer)).send({ lotId, bidId, justification: 'sole compliant proposal' }).expect(201);
    });
    it('the awarded RFP preserves its price through contract, PO, receipt, invoice and payment status', async () => {
      const event = (await http().get(`/events/${evId}`).set(...bearer(buyer)).expect(200)).body;
      const contract = (await http().post(`/contracts/from-award/${event.awards[0].id}`)
        .set(...bearer(buyer)).expect(201)).body;
      expect(Number(contract.total_minor)).toBe(450_000);
      await http().post(`/contracts/${contract.id}/activate`).set(...bearer(buyer)).expect(201);
      const order = (await http().post(`/contracts/${contract.id}/orders`).set(...bearer(buyer)).expect(201)).body;
      expect(order.items).toHaveLength(1); expect(Number(order.total_minor)).toBe(450_000);
      expect(Number(order.items[0].unit_price_minor)).toBe(450_000);
      await http().post(`/orders/${order.id}/status`).set(...bearer(buyer)).send({ status:'ISSUED' }).expect(201);
      for (const status of ['CONFIRMED','PACKED','SHIPPED','DELIVERED']) {
        await http().post(`/orders/${order.id}/status`).set(...bearer(supplier)).send({ status }).expect(201);
      }
      await http().post(`/orders/${order.id}/receipts`).set(...bearer(buyer))
        .send({ items:[{ poItemId:order.items[0].id,qty:1 }] }).expect(201);
      const invoice = (await http().post(`/invoices/from-po/${order.id}`).set(...bearer(supplier))
        .send({ items:[{ poItemId:order.items[0].id,qty:1,unitPriceMinor:450_000 }] }).expect(201)).body;
      expect(invoice.status).toBe('MATCHED');
      expect([Number(invoice.net_minor),Number(invoice.vat_minor),Number(invoice.gross_minor)])
        .toEqual([450_000,81_000,531_000]); // default EXCLUSIVE 18% from original request
      await http().post(`/invoices/${invoice.id}/approve`).set(...bearer(buyer)).expect(201);
      const paid = (await http().post(`/invoices/${invoice.id}/pay`).set(...bearer(buyer)).expect(201)).body;
      expect(paid.status).toBe('PAID'); // accounting status, not a bank transfer
    });
  });

  describe('RFI', () => {
    let evId: string, itemId: string;

    it('priced items are rejected; a text-only response is sealed', async () => {
      ({ id: evId, itemId } = await mkEvent('RFI'));
      await http().post(`/events/${evId}/bid`).set(...bearer(supplier))
        .send({ items: [{ eventItemId: itemId, unitPriceMinor: 100 }], proposalText: 'x' }).expect(400);
      await http().post(`/events/${evId}/bid`).set(...bearer(supplier)).send({}).expect(400); // no text either
      await http().post(`/events/${evId}/bid`).set(...bearer(supplier))
        .send({ proposalText: 'We have ISO 9001 and local warehouse capacity' }).expect(201);
    });

    it('buyer sees participation but no text before opening', async () => {
      const detail = await http().get(`/events/${evId}`).set(...bearer(buyer)).expect(200);
      expect(detail.body.bids).toHaveLength(1);
      expect(JSON.stringify(detail.body)).not.toContain('ISO 9001');
    });

    it('opening reveals the response; total stays null; bid is OPENED', async () => {
      await forceCloseAndOpen(evId);
      const detail = await http().get(`/events/${evId}`).set(...bearer(buyer)).expect(200);
      expect(detail.body.status).toBe('EVALUATION'); // "responses opened" for an RFI
      expect(detail.body.bids[0].state).toBe('OPENED');
      expect(detail.body.bids[0].proposal_text).toContain('ISO 9001');
      expect(detail.body.bids[0].total_minor).toBeNull();
    });

    it('evaluate and award are rejected for an RFI', async () => {
      const detail = await http().get(`/events/${evId}`).set(...bearer(buyer)).expect(200);
      const bidId = detail.body.bids[0].id;
      const lotId = detail.body.lots[0].id;
      await http().post(`/events/${evId}/evaluate`).set(...bearer(buyer))
        .send({ criteria: [{ key: 'price', weight: 100 }], scores: [{ bidId, key: 'price', score: 50 }] })
        .expect(400);
      await http().post(`/events/${evId}/award`).set(...bearer(buyer)).send({ lotId, bidId }).expect(400);
      const after = await http().get(`/events/${evId}`).set(...bearer(buyer)).expect(200);
      expect(after.body.awards).toHaveLength(0);
    });

    it('the opening receipt in the audit log has hashes, not the cleartext response', async () => {
      const rows = await db.query(
        `SELECT payload FROM audit_events WHERE action = 'EVENT_OPENED' AND entity_id = $1`,
        [evId],
      );
      expect(rows.rows).toHaveLength(1);
      const payload = JSON.stringify(rows.rows[0].payload);
      expect(payload).toContain('payload_sha256');
      expect(payload).not.toContain('ISO 9001');
    });
  });
});
