import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { FollowupsScheduler } from '../src/modules/followups/followups.module';
import { addApprover } from './helpers';

// Outreach follow-up chains: enroll invited suppliers → the ticker advances steps and
// logs sends → the chain stops the moment the supplier bids / the event closes.
// The ticker is exercised by calling scheduler.tick() directly; "time passes" is
// simulated by rewinding next_run_at with the OWNER connection (RLS-free).
describe('outreach follow-ups (API e2e)', () => {
  let app: INestApplication;
  let owner: Client;
  let scheduler: FollowupsScheduler;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ['Authorization', `Bearer ${t}`] as [string, string];

  let buyerToken: string, approverToken: string, buyerBToken: string;
  let supplierToken: string, supplierOrgId: string;
  let supplier2Token: string, supplier2OrgId: string;

  const reg = async (path: string, name: string, email: string) => {
    const r = await http().post(path).send({ legalName: name, email, password: 'password123', fullName: name }).expect(201);
    return { token: r.body.accessToken as string, orgId: r.body.org.id as string };
  };

  // request → approve → INVITED event (both suppliers) → publish; returns { eventId, itemId }.
  const makeOpenEvent = async () => {
    const req = await http().post('/requests').set(...bearer(buyerToken))
      .send({ title: `FU req ${tag} ${randomUUID().slice(0, 4)}`, items: [{ name: 'Widget', qty: 5, estUnitPriceMinor: 100_000 }] })
      .expect(201);
    await http().post(`/requests/${req.body.id}/submit`).set(...bearer(buyerToken)).expect(201);
    await http().post(`/requests/${req.body.id}/approve`).set(...bearer(approverToken)).expect(201);
    const ev = await http().post(`/events/from-request/${req.body.id}`).set(...bearer(buyerToken))
      .send({ closeAt: new Date(Date.now() + 24 * 3600_000).toISOString(), visibility: 'INVITED' }).expect(201);
    for (const org of [supplierOrgId, supplier2OrgId]) {
      await http().post(`/events/${ev.body.id}/invite`).set(...bearer(buyerToken)).send({ supplierOrgId: org }).expect(201);
    }
    await http().post(`/events/${ev.body.id}/publish`).set(...bearer(buyerToken)).expect(201);
    const detail = await http().get(`/events/${ev.body.id}`).set(...bearer(buyerToken)).expect(200);
    return { eventId: ev.body.id as string, itemId: detail.body.items[0].id as string };
  };

  const rewind = (eventId: string, supplierOrg?: string) =>
    owner.query(
      `UPDATE followup_enrollments SET next_run_at = now() - interval '1 minute'
       WHERE event_id = $1 AND status = 'ACTIVE' ${supplierOrg ? 'AND supplier_org_id = $2' : ''}`,
      supplierOrg ? [eventId, supplierOrg] : [eventId],
    );

  const fups = async (eventId: string, token = buyerToken) =>
    (await http().get(`/events/${eventId}/followups`).set(...bearer(token)).expect(200)).body as any[];

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    scheduler = app.get(FollowupsScheduler);
    owner = new Client({ connectionString: process.env.DATABASE_OWNER_URL });
    await owner.connect();

    const b = await reg('/auth/register/buyer', `FU Buyer ${tag}`, `fu-buyer-${tag}@t.test`);
    buyerToken = b.token;
    approverToken = await addApprover(app, buyerToken, `fu${tag}`);
    const b2 = await reg('/auth/register/buyer', `FU Buyer B ${tag}`, `fu-buyerb-${tag}@t.test`);
    buyerBToken = b2.token;
    const s = await reg('/auth/register/supplier', `FU Supplier ${tag}`, `fu-sup-${tag}@t.test`);
    supplierToken = s.token; supplierOrgId = s.orgId;
    const s2 = await reg('/auth/register/supplier', `FU Supplier2 ${tag}`, `fu-sup2-${tag}@t.test`);
    supplier2Token = s2.token; supplier2OrgId = s2.orgId;
  });

  afterAll(async () => {
    await owner.query(`DELETE FROM organizations WHERE legal_name LIKE $1`, [`FU %${tag}%`]);
    await owner.end();
    await app.close();
  });

  it('org plan: default is returned until the buyer saves one; steps are validated', async () => {
    const def = await http().get('/settings/followup-plan').set(...bearer(buyerToken)).expect(200);
    expect(def.body.isDefault).toBe(true);
    expect(def.body.steps.length).toBeGreaterThan(0);

    await http().put('/settings/followup-plan').set(...bearer(buyerToken))
      .send({ steps: [{ channel: 'SMOKE_SIGNAL', afterHours: 1 }] }).expect(400);

    const saved = await http().put('/settings/followup-plan').set(...bearer(buyerToken))
      .send({ steps: [{ channel: 'EMAIL', afterHours: 1 }, { channel: 'EMAIL', afterHours: 2 }, { channel: 'WHATSAPP', afterHours: 2 }] })
      .expect(200);
    expect(saved.body.isDefault).toBe(false);
    expect(saved.body.steps).toHaveLength(3);
  });

  let eventId: string;
  let itemId: string;

  it('enroll: creates ACTIVE chains for invited suppliers with the first step scheduled', async () => {
    ({ eventId, itemId } = await makeOpenEvent());
    const rows = (await http().post(`/events/${eventId}/followups`).set(...bearer(buyerToken)).send({}).expect(201)).body;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.status).toBe('ACTIVE');
      expect(r.current_step).toBe(0);
      expect(r.total_steps).toBe(3);
      expect(r.next_run_at).toBeTruthy();
    }
    // re-enroll is a no-op, not a duplicate
    const again = (await http().post(`/events/${eventId}/followups`).set(...bearer(buyerToken)).send({}).expect(201)).body;
    expect(again).toHaveLength(2);
  });

  it('RLS: a foreign buyer sees no enrollments for the event', async () => {
    expect(await fups(eventId, buyerBToken)).toHaveLength(0);
  });

  it('tick: a due chain sends the step (logged) and schedules the next one', async () => {
    await rewind(eventId);
    await scheduler.tick();
    const rows = await fups(eventId);
    for (const r of rows) {
      expect(r.status).toBe('ACTIVE');
      expect(r.current_step).toBe(1);
      expect(r.sent_count).toBeGreaterThanOrEqual(1); // email logged per active user
      expect(r.next_run_at).toBeTruthy();
    }
    // not due again → tick is a no-op for these chains
    await scheduler.tick();
    const after = await fups(eventId);
    expect(after.every((r: any) => r.current_step === 1)).toBe(true);
  });

  it('bid submit stops the chain instantly (RESPONDED), and the ticker never revives it', async () => {
    await http().post(`/events/${eventId}/bid`).set(...bearer(supplierToken))
      .send({ items: [{ eventItemId: itemId, unitPriceMinor: 90_000 }], deliveryDays: 10 }).expect(201);
    let rows = await fups(eventId);
    const mine = rows.find((r: any) => r.supplier_org_id === supplierOrgId);
    expect(mine.status).toBe('RESPONDED');

    await rewind(eventId); // only supplier2 is still ACTIVE
    await scheduler.tick();
    rows = await fups(eventId);
    expect(rows.find((r: any) => r.supplier_org_id === supplierOrgId).status).toBe('RESPONDED');
    expect(rows.find((r: any) => r.supplier_org_id === supplier2OrgId).current_step).toBe(2);
  });

  it('chain exhausts after the last step (WhatsApp SKIPPED without a phone, still logged)', async () => {
    await rewind(eventId, supplier2OrgId); // step 2 = WHATSAPP, no phone on org
    await scheduler.tick();
    const r = (await fups(eventId)).find((x: any) => x.supplier_org_id === supplier2OrgId);
    expect(r.status).toBe('EXHAUSTED');
    expect(r.current_step).toBe(3);
    expect(r.next_run_at).toBeNull();
    expect(r.sent_count).toBe(3); // 2 emails + 1 skipped whatsapp, every attempt logged
  });

  it('stop endpoint halts an ACTIVE chain; event leaving the bidding stage closes the rest', async () => {
    const ev2 = await makeOpenEvent();
    await http().post(`/events/${ev2.eventId}/followups`).set(...bearer(buyerToken)).send({}).expect(201);

    await http().post(`/events/${ev2.eventId}/followups/${supplierOrgId}/stop`).set(...bearer(buyerToken)).expect(201);
    let rows = await fups(ev2.eventId);
    expect(rows.find((r: any) => r.supplier_org_id === supplierOrgId).status).toBe('STOPPED');

    // deadline passes → event closes → due chain flips to EVENT_CLOSED, nothing is sent
    await owner.query(`UPDATE sourcing_events SET status = 'CLOSED' WHERE id = $1`, [ev2.eventId]);
    await rewind(ev2.eventId, supplier2OrgId);
    await scheduler.tick();
    rows = await fups(ev2.eventId);
    const s2 = rows.find((r: any) => r.supplier_org_id === supplier2OrgId);
    expect(s2.status).toBe('EVENT_CLOSED');
    expect(s2.sent_count).toBe(0);
  });

  it('supplier tokens cannot manage follow-ups', async () => {
    await http().get(`/events/${eventId}/followups`).set(...bearer(supplierToken)).expect(403);
    await http().post(`/events/${eventId}/followups`).set(...bearer(supplierToken)).send({}).expect(403);
  });
});
