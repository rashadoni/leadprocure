import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { Client } from 'pg';
import { randomUUID, createHmac } from 'crypto';
import { AppModule } from '../src/app.module';
import { addApprover } from './helpers';

// Actual webhook HTTP/raw HMAC + runtime DataSource + PostgreSQL/RLS. Provider
// message rows are synthetic fixtures; this is NOT a live Meta delivery test.
describe('LP-A17 Meta delivery progress and batched callbacks', () => {
  let app: INestApplication, owner: Client;
  let buyer: string, otherBuyer: string;
  let first: { event: string; enrollment: string }, second: { event: string; enrollment: string };
  const tag = randomUUID().slice(0,8), secret = `isolated-meta-${tag}`;
  const previous = process.env.WHATSAPP_APP_SECRET;
  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  beforeAll(async () => {
    process.env.WHATSAPP_APP_SECRET = secret;
    const mod = await Test.createTestingModule({ imports:[AppModule] }).compile();
    app = mod.createNestApplication({ rawBody:true }); app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist:true,transform:true })); await app.init();
    owner = new Client({ connectionString:process.env.DATABASE_OWNER_URL }); await owner.connect();
    const register = async (kind: string, name: string) => (await http().post(`/auth/register/${kind}`).send({
      legalName:`Meta ${tag} ${name}`,email:`meta-${tag}-${name}@audit.invalid`,password:'Fixture-password123',fullName:name,
    }).expect(201)).body;
    const a = await register('buyer','first'), b = await register('buyer','second'), s = await register('supplier','supplier');
    buyer = a.accessToken; otherBuyer = b.accessToken;
    const setup = async (token: string, label: string) => {
      const approver = await addApprover(app, token, `meta-${tag}-${label}`);
      const req = (await http().post('/requests').set(auth(token)).send({ title:`Meta ${tag} ${label}`,
        items:[{ name:'Item',qty:1,estUnitPriceMinor:100 }],
      }).expect(201)).body;
      await http().post(`/requests/${req.id}/submit`).set(auth(token)).expect(201);
      await http().post(`/requests/${req.id}/approve`).set(auth(approver)).expect(201);
      const ev = (await http().post(`/events/from-request/${req.id}`).set(auth(token)).send({
        closeAt:new Date(Date.now()+86400000).toISOString(),visibility:'INVITED',
      }).expect(201)).body;
      await http().post(`/events/${ev.id}/invite`).set(auth(token)).send({ supplierOrgId:s.org.id }).expect(201);
      await http().post(`/events/${ev.id}/publish`).set(auth(token)).expect(201);
      await http().post(`/events/${ev.id}/followups`).set(auth(token)).send({}).expect(201);
      const enrollment = (await owner.query('SELECT id FROM followup_enrollments WHERE event_id=$1', [ev.id])).rows[0].id;
      return { event:ev.id,enrollment };
    };
    first = await setup(buyer,'a'); second = await setup(otherBuyer,'b');
  });
  afterAll(async () => {
    if (app) await app.close(); if (owner) await owner.end();
    if (previous === undefined) delete process.env.WHATSAPP_APP_SECRET; else process.env.WHATSAPP_APP_SECRET = previous;
  });
  async function message(enrollment = first.enrollment, status = 'SENT', channel = 'WHATSAPP') {
    const provider = `wamid.audit.${randomUUID()}`, recipient = `synthetic-${randomUUID()}`;
    const row = (await owner.query(`INSERT INTO followup_messages
      (enrollment_id,buyer_org_id,supplier_org_id,step_no,channel,recipient,status,provider_msg_id)
      SELECT id,buyer_org_id,supplier_org_id,0,$2,$5,$3,$4 FROM followup_enrollments WHERE id=$1 RETURNING id`,
      [enrollment,channel,status,provider,recipient])).rows[0];
    return { id:row.id,provider,recipient };
  }
  async function status(id: string) { return (await owner.query('SELECT status FROM followup_messages WHERE id=$1', [id])).rows[0].status; }
  async function callback(body: any, signed = true) {
    const raw = JSON.stringify(body);
    const req = http().post('/channels/whatsapp/webhook').set('Content-Type','application/json');
    if (signed) req.set('x-hub-signature-256','sha256='+createHmac('sha256',secret).update(raw).digest('hex'));
    return req.send(raw);
  }
  const one = (provider: string, state: string) => ({ entry:[{ changes:[{ value:{ statuses:[{ id:provider,status:state }] } }] }] });

  it('READ cannot be downgraded by late SENT/DELIVERED/FAILED or duplicate callbacks', async () => {
    const m = await message();
    for (const state of ['read','sent','delivered','failed','read']) {
      expect((await callback(one(m.provider,state))).status).toBe(200);
      expect(await status(m.id)).toBe('READ');
    }
    const visible = (await http().get(`/events/${first.event}/followups`).set(auth(buyer)).expect(200)).body;
    expect(visible[0].messages.find((v:any)=>v.recipient===m.recipient)?.status).toBe('READ');
    const foreign = (await http().get(`/events/${first.event}/followups`).set(auth(otherBuyer)).expect(200)).body;
    expect(foreign).toEqual([]);
  });
  it('confirmed delivery survives delayed failure; a positive confirmation can resolve FAILED', async () => {
    const m = await message();
    for (const state of ['failed','sent']) await callback(one(m.provider,state)).then(r=>expect(r.status).toBe(200));
    expect(await status(m.id)).toBe('FAILED');
    for (const state of ['delivered','failed','sent']) await callback(one(m.provider,state)).then(r=>expect(r.status).toBe(200));
    expect(await status(m.id)).toBe('DELIVERED');
  });
  it('processes every entry/change/status and updates only the matching provider message', async () => {
    const a = await message(), b = await message(second.enrollment), c = await message(), untouched = await message();
    const body = { entry:[{ changes:[{ value:{ statuses:[{ id:a.provider,status:'delivered' }] } },
      { value:{ statuses:[{ id:b.provider,status:'read' }] } }] },
      { changes:[{ value:{ statuses:[{ id:c.provider,status:'failed' },{ id:'unknown-provider',status:'read' }] } }] }] };
    expect((await callback(body)).status).toBe(200);
    expect(await Promise.all([status(a.id),status(b.id),status(c.id),status(untouched.id)])).toEqual(['DELIVERED','READ','FAILED','SENT']);
  });
  it('malformed entries and unsupported states do not block later valid batch entries', async () => {
    const a = await message(), untouched = await message();
    const body = { entry:[null,{ changes:{} },{ changes:[null,{ value:{ statuses:{} } },{ value:{ statuses:[null,
      { id:untouched.provider,status:'APPROVED' },{ id:42,status:'read' },{ id:a.provider,status:'read' }] } }] }] };
    expect((await callback(body)).status).toBe(200);
    expect(await status(a.id)).toBe('READ'); expect(await status(untouched.id)).toBe('SENT');
  });
  it('unsigned requests cannot change persisted rows and a Meta callback never changes EMAIL rows', async () => {
    const a = await message(), email = await message(first.enrollment,'SENT','EMAIL');
    expect((await callback(one(a.provider,'read'),false)).status).toBe(401);
    expect((await callback(one(email.provider,'read'))).status).toBe(200);
    expect(await status(a.id)).toBe('SENT'); expect(await status(email.id)).toBe('SENT');
    expect((await owner.query('SELECT followup_msg_set_status($1,$2) AS n',[a.provider,'APPROVED'])).rows[0].n).toBe(0);
  });
  it('concurrent stronger and weaker confirmations preserve the strongest status', async () => {
    const a = await message();
    const responses = await Promise.all(['delivered','read','sent','failed'].map(s=>callback(one(a.provider,s))));
    expect(responses.map(r=>r.status)).toEqual([200,200,200,200]); expect(await status(a.id)).toBe('READ');
  });
});
