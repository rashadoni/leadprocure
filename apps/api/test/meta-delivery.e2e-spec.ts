import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
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
  it('persists a callback received before its message and applies it when the sender logs that message', async () => {
    const provider = `wamid.audit.${randomUUID()}`, recipient = `early-${randomUUID()}`;
    expect((await callback(one(provider,'read'))).status).toBe(200);
    expect((await owner.query('SELECT status FROM whatsapp_delivery_receipts WHERE provider_msg_id=$1',[provider])).rows[0].status).toBe('READ');
    await app.get(DataSource).query('SELECT followup_log_message_ex($1,0,$2,$3,$4,NULL,$5)',
      [first.enrollment,'WHATSAPP',recipient,'SENT',provider]);
    const rows = (await owner.query('SELECT status FROM followup_messages WHERE provider_msg_id=$1',[provider])).rows;
    expect(rows).toEqual([{ status:'READ' }]);
    await expect(app.get(DataSource).query('SELECT * FROM whatsapp_delivery_receipts')).rejects.toThrow(/permission denied/i);
  });
  for (const firstOperation of ['callback','message']) {
    it(`serializes callback and message registration when ${firstOperation} actually waits first`, async () => {
      const provider = `wamid.audit.${randomUUID()}`, recipient = `race-${randomUUID()}`;
      const pending: Array<Promise<any>> = [];
      let responses: PromiseSettledResult<any>[] = [];
      const log = () => app.get(DataSource).query('SELECT followup_log_message_ex($1,0,$2,$3,$4,NULL,$5)',
        [first.enrollment,'WHATSAPP',recipient,'SENT',provider]);
      const notify = () => callback(one(provider,'read'));
      await owner.query('BEGIN');
      try {
        const pid = (await owner.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await owner.query('SELECT pg_advisory_xact_lock(hashtextextended($1,86))',[provider]);
        for (const operation of firstOperation === 'callback' ? [notify,log] : [log,notify]) {
          pending.push(operation());
          const deadline = Date.now()+10000;
          let observed = false;
          while (Date.now()<deadline) {
            await owner.query('SELECT pg_stat_clear_snapshot()');
            const n = (await owner.query(`SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE wait_event='advisory' AND $1=ANY(pg_blocking_pids(pid))`,[pid])).rows[0].n;
            if (n>=pending.length) { observed=true; break; }
            await new Promise(resolve=>setTimeout(resolve,20));
          }
          expect(observed).toBe(true);
        }
      } finally { await owner.query('ROLLBACK'); responses=await Promise.allSettled(pending); }
      const values = responses.map(r=>{ if(r.status==='rejected')throw r.reason;return r.value; });
      expect(values[firstOperation==='callback'?0:1].status).toBe(200);
      expect((await owner.query('SELECT status FROM followup_messages WHERE provider_msg_id=$1',[provider])).rows).toEqual([{ status:'READ' }]);
    });
  }
  it('returns503 for real storage failure, preserves other batch members and safely accepts a retry', async () => {
    const a = await message(), b = await message();
    const fn = `meta_fail_${tag}`, trigger = `${fn}_trigger`;
    const body = { entry:[{ changes:[{ value:{ statuses:[
      { id:a.provider,status:'read' },{ id:b.provider,status:'read' },
    ] } }] }] };
    try {
      // Temporary fixture trigger fails only this synthetic message's UPDATE.
      // It exercises the actual runtime PostgreSQL failure path, not a mocked DS.
      await owner.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF OLD.provider_msg_id=TG_ARGV[0] THEN RAISE EXCEPTION 'Synthetic callback storage failure'; END IF;
        RETURN NEW; END $$`);
      const ddl = (await owner.query(`SELECT format('CREATE TRIGGER %I BEFORE UPDATE ON followup_messages
        FOR EACH ROW EXECUTE FUNCTION %I(%L)', $1::text,$2::text,$3::text) AS ddl`, [trigger,fn,a.provider])).rows[0].ddl;
      await owner.query(ddl);
      const failed = await callback(body);
      expect(failed.status).toBe(503);
      expect(failed.body.message).toBe('Unable to persist delivery status; retry callback');
      expect(await status(a.id)).toBe('SENT'); expect(await status(b.id)).toBe('READ');
    } finally {
      await owner.query(`DROP TRIGGER IF EXISTS ${trigger} ON followup_messages`);
      await owner.query(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
    expect((await callback(body)).status).toBe(200);
    expect(await status(a.id)).toBe('READ'); expect(await status(b.id)).toBe('READ');
    expect((await owner.query('SELECT count(*)::int AS n FROM followup_messages WHERE provider_msg_id=ANY($1::text[])',
      [[a.provider,b.provider]])).rows[0].n).toBe(2);
  });
  it('concurrent stronger and weaker confirmations preserve the strongest status', async () => {
    const a = await message();
    const responses = await Promise.all(['delivered','read','sent','failed'].map(s=>callback(one(a.provider,s))));
    expect(responses.map(r=>r.status)).toEqual([200,200,200,200]); expect(await status(a.id)).toBe('READ');
  });
});
