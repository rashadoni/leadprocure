import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { addApprover } from './helpers';

// Shipment tracking had no suite of its own. The timeline is the supplier's own claim and
// the buyer's board reads it, so the two things that matter are that it cannot be walked
// backwards and that it never quietly disagrees with the order it belongs to.
describe('logistics (API e2e)', () => {
  let app: INestApplication;
  let db: Client;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ['Authorization', `Bearer ${t}`] as [string, string];
  let buyer: string, approver: string, supplier: string, supplierOrg: string;

  const mkConfirmedPo = async () => {
    const req = await http().post('/requests').set(...bearer(buyer))
      .send({ title: `Lg ${tag} ${randomUUID().slice(0, 4)}`, items: [{ name: 'Cable', qty: 2, estUnitPriceMinor: 100_000 }] })
      .expect(201);
    await http().post(`/requests/${req.body.id}/submit`).set(...bearer(buyer)).expect(201);
    await http().post(`/requests/${req.body.id}/approve`).set(...bearer(approver)).expect(201);
    const po = await http().post(`/orders/direct/from-request/${req.body.id}`).set(...bearer(buyer))
      .send({ supplierOrgId: supplierOrg }).expect(201);
    await http().post(`/orders/${po.body.id}/status`).set(...bearer(buyer)).send({ status: 'ISSUED' }).expect(201);
    await http().post(`/orders/${po.body.id}/status`).set(...bearer(supplier)).send({ status: 'CONFIRMED' }).expect(201);
    return { id: po.body.id as string, itemId: po.body.items[0].id as string };
  };
  const ship = (poId: string) => http().post(`/logistics/po/${poId}/shipment`).set(...bearer(supplier))
    .send({ carrier: 'AzerPost', trackingNo: `AZ-${tag}` });
  const event = (poId: string, status: string) =>
    http().post(`/logistics/po/${poId}/events`).set(...bearer(supplier)).send({ status, location: 'Baku' });

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
    ({ token: buyer } = await reg('/auth/register/buyer', `Lg Buyer ${tag}`, `lgb-${tag}@t.test`));
    approver = await addApprover(app, buyer, tag);
    ({ token: supplier, org: supplierOrg } = await reg('/auth/register/supplier', `Lg Sup ${tag}`, `lgs-${tag}@t.test`));

    await http().post(`/suppliers/${supplierOrg}/invite`).set(...bearer(buyer)).expect(201);
    const registry = await http().get('/suppliers').set(...bearer(buyer)).expect(200);
    const relId = registry.body.find((r: any) => r.supplier_org_id === supplierOrg).id;
    await http().post(`/suppliers/relationships/${relId}/status`).set(...bearer(buyer)).send({ status: 'APPROVED' }).expect(201);
    await http().put('/requests/method-policies').set(...bearer(buyer))
      .send({ policies: [{ category: '*', minAmountMinor: 0, maxAmountMinor: null, method: 'DIRECT' }] }).expect(200);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM organizations WHERE legal_name LIKE $1`, [`Lg %${tag}%`]);
    // organization_users is global and no org delete reaches it; the tag keeps this to
    // this suite's three accounts (lgb-, lgs-, apprv-).
    await db.query(`DELETE FROM organization_users WHERE email LIKE $1`, [`%${tag}@t.test`]);
    await db.end();
    await app.close();
  });

  it('only the supplier ships, and a milestone carries the order forward', async () => {
    const po = await mkConfirmedPo();
    await http().post(`/logistics/po/${po.id}/shipment`).set(...bearer(buyer))
      .send({ carrier: 'X' }).expect(403); // buyer is not SUPPLIER_USER
    await ship(po.id).expect(201);

    const moved = await event(po.id, 'PICKED_UP').expect(201);
    // PICKED_UP targets SHIPPED, and the chain walks CONFIRMED → PACKED → SHIPPED
    expect(moved.body.poStatus).toBe('SHIPPED');
    expect(moved.body.shipment.status).toBe('PICKED_UP');
  });

  it('the timeline cannot be walked backwards, and EXCEPTION is not a dead end', async () => {
    const po = await mkConfirmedPo();
    await ship(po.id).expect(201);
    await event(po.id, 'DELIVERED').expect(201);

    // two clicks apart in the supplier's dropdown, and it used to turn a delivered
    // shipment into one in transit while the order stayed at DELIVERED
    const back = await event(po.id, 'IN_TRANSIT').expect(400);
    expect(back.body.message).toMatch(/already at DELIVERED/);
    expect(back.body.message).toMatch(/EXCEPTION/);
    const still = await http().get(`/logistics/po/${po.id}`).set(...bearer(supplier)).expect(200);
    expect(still.body.shipment.status).toBe('DELIVERED');
    expect(still.body.events.map((e: any) => e.status)).toEqual(['DELIVERED']);

    // EXCEPTION is how a problem is reported, and it must not trap the shipment
    await event(po.id, 'EXCEPTION').expect(201);
    const recovered = await event(po.id, 'ARRIVED').expect(201);
    expect(recovered.body.shipment.status).toBe('ARRIVED');
  });

  it('once the buyer has accepted the goods, tracking is closed', async () => {
    const po = await mkConfirmedPo();
    await ship(po.id).expect(201);
    await event(po.id, 'DELIVERED').expect(201);
    await http().post(`/orders/${po.id}/receipts`).set(...bearer(buyer))
      .send({ items: [{ poItemId: po.itemId, qty: 2 }] }).expect(201); // full receipt → ACCEPTED

    const closed = await event(po.id, 'EXCEPTION').expect(400);
    expect(closed.body.message).toMatch(/accepted this delivery/);
  });

  it('the board shows the order status beside the delivery status', async () => {
    const board = await http().get('/logistics').set(...bearer(buyer)).expect(200);
    expect(board.body.length).toBeGreaterThan(0);
    // the delivery status is a claim; the order's own status is what the buyer acts on,
    // and walking the order forward is best-effort, so both have to be on screen
    for (const row of board.body) expect(row.po_status).toBeTruthy();
  });
});
