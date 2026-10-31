import { DataSource } from 'typeorm';
import { createHmac } from 'crypto';
import * as channelSenders from '../src/modules/channels/channels.module';
import { AppConfig } from '../src/common/config/config.service';
import { ConsoleMailProvider } from '../src/common/mail/mail.module';
import { ConsoleWhatsAppProvider } from '../src/modules/followups/followups.module';
import { MailProvider } from '../src/common/mail/mail.module';
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
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MailProvider).useValue({kind:'test',send:async()=>{}}).compile();
    app = mod.createNestApplication({ rawBody:true });
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    // Ticks are driven explicitly below; the cron jobs are not registered at all under
    // DISABLE_SCHEDULERS, which setup-env sets for every suite (this one used to stop
    // them by hand, and it was the only suite that did).
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
  it('an unconfigured console channel does not create SENT evidence',async()=>{
    const ev=await makeOpenEvent();await http().post(`/events/${ev.eventId}/followups`).set(...bearer(buyerToken)).send({supplierOrgIds:[supplierOrgId]}).expect(201);
    await rewind(ev.eventId,supplierOrgId);
    const consoleScheduler=new FollowupsScheduler(app.get(DataSource),new ConsoleMailProvider(),new ConsoleWhatsAppProvider(),app.get(AppConfig));
    await consoleScheduler.tick();
    const row=(await fups(ev.eventId)).find((r:any)=>r.supplier_org_id===supplierOrgId);
    expect(row.messages.map((m:any)=>m.status)).toEqual(['NOT_CONFIGURED']);
  });
  it('expired delivery leases become UNKNOWN and require an authorized explanation before requeue',async()=>{
    const ev=await makeOpenEvent();await http().post(`/events/${ev.eventId}/followups`).set(...bearer(buyerToken)).send({supplierOrgIds:[supplierOrgId]}).expect(201);
    await rewind(ev.eventId,supplierOrgId);
    const jobs=(await owner.query(`SELECT * FROM followup_claim_outbox()`)).rows;
    const job=jobs.find((j:any)=>j.work.event_id===ev.eventId);expect(job).toBeTruthy();
    await owner.query(`UPDATE followup_outbox SET lease_until=now()-interval '1 minute' WHERE id=$1`,[job.id]);
    await owner.query(`SELECT * FROM followup_claim_outbox()`);
    expect((await owner.query(`SELECT status FROM followup_outbox WHERE id=$1`,[job.id])).rows[0].status).toBe('UNKNOWN');
    await http().post(`/events/${ev.eventId}/followups/jobs/${job.id}/reconcile`).set(...bearer(supplierToken)).send({decision:'CONFIRMED_NOT_SENT',reason:'Verified provider did not send'}).expect(403);
    await http().post(`/events/${ev.eventId}/followups/jobs/${job.id}/reconcile`).set(...bearer(buyerToken)).send({decision:'CONFIRMED_NOT_SENT',reason:'short'}).expect(400);
    await http().post(`/events/${ev.eventId}/followups/jobs/${job.id}/reconcile`).set(...bearer(buyerToken)).send({decision:'CONFIRMED_NOT_SENT',reason:'Verified provider did not send'}).expect(201);
    expect((await owner.query(`SELECT status FROM followup_outbox WHERE id=$1`,[job.id])).rows[0].status).toBe('PENDING');
    await http().post(`/events/${ev.eventId}/followups/${supplierOrgId}/stop`).set(...bearer(buyerToken)).expect(201);
    await scheduler.tick();
    expect((await owner.query(`SELECT status FROM followup_outbox WHERE id=$1`,[job.id])).rows[0].status).toBe('CANCELLED');
  });

  it('leases only the job being dispatched while later recipients remain pending',async()=>{
    await scheduler.tick();
    const ev=await makeOpenEvent();await http().post(`/events/${ev.eventId}/followups`).set(...bearer(buyerToken)).send({}).expect(201);await rewind(ev.eventId);
    const first=(await owner.query(`SELECT * FROM followup_claim_outbox()`)).rows;expect(first).toHaveLength(1);
    const waiting=(await owner.query(`SELECT o.id,o.status FROM followup_outbox o JOIN followup_enrollments e ON e.id=o.enrollment_id WHERE e.event_id=$1 AND o.id<>$2`,[ev.eventId,first[0].id])).rows;
    expect(waiting).toHaveLength(1);expect(waiting[0].status).toBe('PENDING');
    await owner.query(`UPDATE followup_outbox SET lease_until=now()-interval '1 minute' WHERE id=$1`,[first[0].id]);
    const second=(await owner.query(`SELECT * FROM followup_claim_outbox()`)).rows;expect(second).toHaveLength(1);expect(second[0].id).toBe(waiting[0].id);
    expect((await owner.query(`SELECT status FROM followup_outbox WHERE id=$1`,[first[0].id])).rows[0].status).toBe('UNKNOWN');
    await owner.query(`SELECT followup_finish_outbox($1,'SENT',NULL,NULL,$2)`,[second[0].id,second[0].lease_token]);
  });

  async function dueDelivery(channel='EMAIL') {
    await scheduler.tick();
    await http().put('/settings/followup-plan').set(...bearer(buyerToken))
      .send({ steps:[{ channel,afterHours:1 }] }).expect(200);
    if (channel==='WHATSAPP') await owner.query("UPDATE organizations SET phone='synthetic-recipient' WHERE id=$1",[supplierOrgId]);
    const ev = await makeOpenEvent();
    await http().post(`/events/${ev.eventId}/followups`).set(...bearer(buyerToken)).send({ supplierOrgIds:[supplierOrgId] }).expect(201);
    await rewind(ev.eventId,supplierOrgId);
    return ev;
  }
  async function leasedDelivery(channel='EMAIL') {
    const ev = await dueDelivery(channel);
    const job = (await owner.query('SELECT * FROM followup_claim_outbox()')).rows.find((j:any)=>j.work.event_id===ev.eventId);
    expect(job).toBeTruthy(); expect(job.lease_token).toEqual(expect.any(String));
    return { ev,job };
  }
  const finish = (job:any,state:string,provider:string|null=null,token=job.lease_token) => owner.query(
    'SELECT followup_finish_outbox($1,$2,NULL,$3,$4) AS done',[job.id,state,provider,token]);
  const allowed = async (job:any,token=job.lease_token) => (await owner.query(
    'SELECT followup_dispatch_allowed($1,$2) AS allowed',[job.id,token])).rows[0].allowed;
  async function reclaim(ev:any,job:any) {
    await owner.query("UPDATE followup_outbox SET lease_until=now()-interval '1 minute' WHERE id=$1",[job.id]);
    await owner.query('SELECT * FROM followup_claim_outbox()');
    await http().post(`/events/${ev.eventId}/followups/jobs/${job.id}/reconcile`).set(...bearer(buyerToken))
      .send({ decision:'CONFIRMED_NOT_SENT',reason:'Fixture provider confirmed no dispatch occurred' }).expect(201);
    const next = (await owner.query('SELECT * FROM followup_claim_outbox()')).rows.find((j:any)=>j.id===job.id);
    expect(next).toBeTruthy(); expect(next.lease_token).not.toBe(job.lease_token);
    return next;
  }
  it('only the active opaque lease can dispatch/finish; unfenced legacy calls fail closed', async () => {
    const { job } = await leasedDelivery();
    expect(await allowed(job)).toBe(true); expect(await allowed(job,randomUUID())).toBe(false);
    expect((await owner.query('SELECT followup_dispatch_allowed($1) AS allowed',[job.id])).rows[0].allowed).toBe(false);
    await owner.query("SELECT followup_finish_outbox($1,'SENT',NULL,NULL)",[job.id]);
    expect((await finish(job,'SENT',null,randomUUID())).rows[0].done).toBe(false);
    expect((await owner.query('SELECT status,lease_token FROM followup_outbox WHERE id=$1',[job.id])).rows[0])
      .toMatchObject({ status:'SENDING',lease_token:job.lease_token });
    expect((await finish(job,'SENT')).rows[0].done).toBe(true);
    expect((await finish(job,'SENT')).rows[0].done).toBe(false);
    expect((await owner.query("SELECT count(*)::int AS n FROM followup_messages WHERE enrollment_id=$1 AND status='SENT'",[job.enrollment_id])).rows[0].n).toBe(1);
  });
  it('expired leases cannot dispatch before cleanup and cannot finish a newly reclaimed attempt with the same counter', async () => {
    const { ev,job } = await leasedDelivery();
    await owner.query("UPDATE followup_outbox SET lease_until=now()-interval '1 minute' WHERE id=$1",[job.id]);
    expect(await allowed(job)).toBe(false);
    const next = await reclaim(ev,job);
    expect(next.attempts).toBe(job.attempts); // manual reconciliation reset does not reuse the opaque lease
    expect((await finish(job,'SENT')).rows[0].done).toBe(false);
    expect((await owner.query('SELECT status,lease_token FROM followup_outbox WHERE id=$1',[job.id])).rows[0])
      .toMatchObject({ status:'SENDING',lease_token:next.lease_token });
    expect((await finish(next,'SENT')).rows[0].done).toBe(true);
  });
  it('late known provider acceptance is retained once without completing a new lease or authorizing resend', async () => {
    const { ev,job } = await leasedDelivery('WHATSAPP'), provider=`wamid.audit.${randomUUID()}`;
    const next = await reclaim(ev,job);
    expect((await finish(job,'SENT',provider)).rows[0].done).toBe(false);
    expect((await finish(job,'SENT',provider)).rows[0].done).toBe(false);
    expect((await owner.query('SELECT status,lease_token FROM followup_outbox WHERE id=$1',[job.id])).rows[0])
      .toMatchObject({ status:'SENDING',lease_token:next.lease_token });
    expect((await owner.query('SELECT status FROM followup_messages WHERE provider_msg_id=$1',[provider])).rows).toEqual([{ status:'SENT' }]);
    expect(await allowed(next)).toBe(false);
    await finish(next,'CANCELLED');
  });
  it('a confirmed callback blocks contradictory reconciliation and exposes a safe UI flag without lease tokens', async () => {
    const { ev,job } = await leasedDelivery('WHATSAPP'), provider=`wamid.audit.${randomUUID()}`;
    await finish(job,'UNKNOWN',provider);
    const previous=process.env.WHATSAPP_APP_SECRET, secret=`isolated-reconcile-${tag}`;
    try {
      process.env.WHATSAPP_APP_SECRET=secret;
      const raw=JSON.stringify({ entry:[{ changes:[{ value:{ statuses:[{ id:provider,status:'read' }] } }] }] });
      await http().post('/channels/whatsapp/webhook').set('Content-Type','application/json')
        .set('x-hub-signature-256','sha256='+createHmac('sha256',secret).update(raw).digest('hex')).send(raw).expect(200);
    } finally { if(previous===undefined)delete process.env.WHATSAPP_APP_SECRET;else process.env.WHATSAPP_APP_SECRET=previous; }
    const row=(await fups(ev.eventId)).find((r:any)=>r.supplier_org_id===supplierOrgId);
    const shown=row.jobs.find((j:any)=>j.id===job.id);
    expect(shown.delivery_confirmed).toBe(true); expect(shown).not.toHaveProperty('lease_token');
    const denied=await http().post(`/events/${ev.eventId}/followups/jobs/${job.id}/reconcile`).set(...bearer(buyerToken))
      .send({ decision:'CONFIRMED_NOT_SENT',reason:'Contradictory fixture decision must be rejected' }).expect(409);
    expect(denied.body.code).toBe('DELIVERY_ALREADY_CONFIRMED');
    expect((await owner.query('SELECT status FROM followup_outbox WHERE id=$1',[job.id])).rows[0].status).toBe('UNKNOWN');
    await http().post(`/events/${ev.eventId}/followups/jobs/${job.id}/reconcile`).set(...bearer(buyerToken))
      .send({ decision:'CONFIRMED_SENT',reason:'Provider delivery has been confirmed by signed callback' }).expect(201);
  });
  it('bounded pre-dispatch retries get fresh leases and stop after three failures', async () => {
    let { job } = await leasedDelivery(); const id=job.id;
    const tokens=new Set<string>();
    for(let attempt=1;attempt<=3;attempt++) {
      tokens.add(job.lease_token); expect(job.attempts).toBe(attempt);
      await finish(job,'FAILED');
      const saved=(await owner.query('SELECT status,lease_token FROM followup_outbox WHERE id=$1',[id])).rows[0];
      expect(saved.lease_token).toBeNull(); expect(saved.status).toBe(attempt<3?'PENDING':'FAILED');
      expect((await owner.query('SELECT * FROM followup_claim_outbox()')).rows).toHaveLength(0);
      if(attempt<3) {
        await owner.query("UPDATE followup_outbox SET lease_until=now()-interval '1 minute' WHERE id=$1",[id]);
        job=(await owner.query('SELECT * FROM followup_claim_outbox()')).rows[0]; expect(job.id).toBe(id);
      }
    }
    expect(tokens.size).toBe(3);
  });
  it('the actual worker preserves a known provider ID when final storage fails', async () => {
    const ev=await dueDelivery('WHATSAPP'), provider=`wamid.audit.${randomUUID()}`;
    const fn=`lease_send_fail_${tag}`, trigger=`${fn}_trigger`;
    const send=jest.spyOn(channelSenders,'sendWhatsappVia').mockResolvedValue(provider);
    try {
      await http().put('/channels/WHATSAPP').set(...bearer(buyerToken)).send({ phoneNumberId:'synthetic-sender',accessToken:'isolated-token',isActive:true }).expect(200);
      await owner.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.status='SENT' AND (NEW.work->>'event_id')=TG_ARGV[0] THEN RAISE EXCEPTION 'Synthetic finish persistence failure'; END IF;
        RETURN NEW; END $$`);
      const ddl=(await owner.query(`SELECT format('CREATE TRIGGER %I BEFORE UPDATE ON followup_outbox FOR EACH ROW EXECUTE FUNCTION %I(%L)',
        $1::text,$2::text,$3::text) AS ddl`,[trigger,fn,ev.eventId])).rows[0].ddl;
      await owner.query(ddl);
      await scheduler.tick(); expect(send).toHaveBeenCalledTimes(1);
      const job=(await owner.query("SELECT * FROM followup_outbox WHERE work->>'event_id'=$1",[ev.eventId])).rows[0];
      expect(job.status).toBe('UNKNOWN'); expect(job.lease_token).toBeNull();
      expect((await owner.query('SELECT status,provider_msg_id FROM followup_messages WHERE enrollment_id=$1',[job.enrollment_id])).rows)
        .toEqual([{ status:'UNKNOWN',provider_msg_id:provider }]);
    } finally {
      send.mockRestore();
      await owner.query(`DROP TRIGGER IF EXISTS ${trigger} ON followup_outbox`);
      await owner.query(`DROP FUNCTION IF EXISTS ${fn}()`);
      await owner.query("DELETE FROM channel_connections WHERE buyer_org_id=(SELECT buyer_org_id FROM sourcing_events WHERE id=$1) AND channel='WHATSAPP'",[ev.eventId]);
    }
  });
  for (const [label,body] of [
    ['missing ID',{}],
    ['non-string ID',{ messages:[{ id:42 }] }],
    ['blank ID',{ messages:[{ id:'   ' }] }],
    ['invalid JSON',null],
  ] as const) {
    it(`HTTP200 from Meta with ${label} stays UNKNOWN and is not blindly retried`, async () => {
      const ev=await dueDelivery('WHATSAPP');
      // Network boundary only: real sender parser, scheduler, SQL and HTTP UI.
      // Fail closed for any unexpected request; no real provider is contacted.
      const network=jest.spyOn(globalThis,'fetch').mockImplementation(async (input,init)=>{
        expect(String(input)).toBe('https://graph.facebook.com/v21.0/synthetic-sender/messages');
        expect(init?.method).toBe('POST');
        return new Response(body===null ? 'not-json' : JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
      });
      try {
        await owner.query(`INSERT INTO channel_connections(buyer_org_id,channel,config,is_active)
          SELECT buyer_org_id,'WHATSAPP',$2::jsonb,true FROM sourcing_events WHERE id=$1`,
          [ev.eventId,JSON.stringify({phoneNumberId:'synthetic-sender',accessToken:'isolated-token'})]);
        await scheduler.tick();
        expect(network).toHaveBeenCalledTimes(1);
        const job=(await owner.query("SELECT * FROM followup_outbox WHERE work->>'event_id'=$1",[ev.eventId])).rows[0];
        expect(job.status).toBe('UNKNOWN'); expect(job.lease_token).toBeNull();
        const messages=(await owner.query('SELECT status,provider_msg_id,detail FROM followup_messages WHERE enrollment_id=$1',[job.enrollment_id])).rows;
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({status:'UNKNOWN',provider_msg_id:null});
        expect(messages[0].detail).toContain('delivery is unconfirmed');
        await scheduler.tick(); expect(network).toHaveBeenCalledTimes(1);
        const shown=(await fups(ev.eventId)).find((r:any)=>r.supplier_org_id===supplierOrgId);
        expect(shown.messages.map((m:any)=>m.status)).toEqual(['UNKNOWN']);
        expect(shown.jobs[0].delivery_confirmed).toBe(false);
        const checked=await http().post('/channels/WHATSAPP/test').set(...bearer(buyerToken))
          .send({to:'synthetic-recipient'}).expect(400);
        expect(checked.body.message).toContain('delivery is unconfirmed');
        const connection=(await http().get('/channels').set(...bearer(buyerToken)).expect(200)).body
          .find((c:any)=>c.channel==='WHATSAPP');
        expect(connection.lastTestAt).toBeNull();
        expect((await owner.query(`SELECT count(*)::int AS n FROM audit_events WHERE action='CHANNEL_TEST_SENT'
          AND entity_id=(SELECT buyer_org_id FROM sourcing_events WHERE id=$1)`,[ev.eventId])).rows[0].n).toBe(0);
      } finally {
        network.mockRestore();
        await owner.query("DELETE FROM channel_connections WHERE buyer_org_id=(SELECT buyer_org_id FROM sourcing_events WHERE id=$1) AND channel='WHATSAPP'",[ev.eventId]);
      }
    });
  }
  it('a usable Meta message ID completes the real worker and binds a signed delivery callback', async () => {
    const ev=await dueDelivery('WHATSAPP'),provider=`wamid.audit.${randomUUID()}`;
    const previous=process.env.WHATSAPP_APP_SECRET,secret=`isolated-meta-send-${tag}`;
    const network=jest.spyOn(globalThis,'fetch').mockImplementation(async (input,init)=>{
      expect(String(input)).toBe('https://graph.facebook.com/v21.0/synthetic-sender/messages');
      expect(init?.method).toBe('POST');
      return new Response(JSON.stringify({messages:[{id:provider}]}),{status:200,headers:{'Content-Type':'application/json'}});
    });
    try {
      process.env.WHATSAPP_APP_SECRET=secret;
      await owner.query(`INSERT INTO channel_connections(buyer_org_id,channel,config,is_active)
        SELECT buyer_org_id,'WHATSAPP',$2::jsonb,true FROM sourcing_events WHERE id=$1`,
        [ev.eventId,JSON.stringify({phoneNumberId:'synthetic-sender',accessToken:'isolated-token'})]);
      await scheduler.tick(); expect(network).toHaveBeenCalledTimes(1);
      const job=(await owner.query("SELECT * FROM followup_outbox WHERE work->>'event_id'=$1",[ev.eventId])).rows[0];
      expect(job.status).toBe('SENT');
      expect((await owner.query('SELECT status,provider_msg_id FROM followup_messages WHERE enrollment_id=$1',[job.enrollment_id])).rows)
        .toEqual([{status:'SENT',provider_msg_id:provider}]);
      const raw=JSON.stringify({entry:[{changes:[{value:{statuses:[{id:provider,status:'delivered'}]}}]}]});
      await http().post('/channels/whatsapp/webhook').set('Content-Type','application/json')
        .set('x-hub-signature-256','sha256='+createHmac('sha256',secret).update(raw).digest('hex')).send(raw).expect(200);
      const shown=(await fups(ev.eventId)).find((r:any)=>r.supplier_org_id===supplierOrgId);
      expect(shown.messages.map((m:any)=>m.status)).toEqual(['DELIVERED']);
      expect(shown.jobs[0].delivery_confirmed).toBe(true);
      await scheduler.tick(); expect(network).toHaveBeenCalledTimes(1);
    } finally {
      network.mockRestore();
      if(previous===undefined)delete process.env.WHATSAPP_APP_SECRET;else process.env.WHATSAPP_APP_SECRET=previous;
      await owner.query("DELETE FROM channel_connections WHERE buyer_org_id=(SELECT buyer_org_id FROM sourcing_events WHERE id=$1) AND channel='WHATSAPP'",[ev.eventId]);
    }
  });
  it("a worker paused during transport cannot finish another worker's reclaimed lease", async () => {
    const ev=await dueDelivery();
    let release!:()=>void, entered!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const started=new Promise<void>(resolve=>{entered=resolve;});
    const paused=new FollowupsScheduler(app.get(DataSource),{ kind:'test',send:async()=>{entered();await gate;} },new ConsoleWhatsAppProvider(),app.get(AppConfig));
    const running=paused.tick(); let next:any;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      await Promise.race([started,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Worker did not reach fixture transport')),5000);})]);
      if(timer)clearTimeout(timer);
      const job=(await owner.query("SELECT * FROM followup_outbox WHERE work->>'event_id'=$1",[ev.eventId])).rows[0];
      next=await reclaim(ev,job);
    } finally { if(timer)clearTimeout(timer);release();await running; }
    expect((await owner.query('SELECT status,lease_token FROM followup_outbox WHERE id=$1',[next.id])).rows[0])
      .toMatchObject({ status:'SENDING',lease_token:next.lease_token });
    await finish(next,'CANCELLED');
  });

});
