import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { Client } from 'pg';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { addApprover } from './helpers';

// LP-A03/A06 explicitly require serialized cancellation, contract and award decisions.
// Only fixture deadlines/observation use the owner connection; contended actions
// use HTTP and normal guards, RLS and transaction handling.
describe('LP-A03/A06 concurrent procurement decisions', () => {
  let app: INestApplication, owner: Client;
  let buyer: string, supplier: string, approver: string, buyerOrg: string, holderPid: number;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ['Authorization', `Bearer ${token}`] as [string, string];
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication(); app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    owner = new Client({ connectionString: process.env.DATABASE_OWNER_URL }); await owner.connect();
    holderPid = (await owner.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const register = async (kind: string) => (await http().post(`/auth/register/${kind}`).send({
      legalName: `Award race ${kind} ${tag}`, email: `award-${kind}-${tag}@test.invalid`,
      password: 'password123', fullName: 'Award concurrency acceptance',
    }).expect(201)).body;
    const b = await register('buyer'); buyer = b.accessToken; buyerOrg = b.org.id;
    supplier = (await register('supplier')).accessToken;
    approver = await addApprover(app, buyer, `award-race-${tag}`);
  });
  afterAll(async () => {
    if (owner) { await owner.query('ROLLBACK'); await owner.end(); }
    if (app) await app.close();
  });

  async function evaluated() {
    const req = (await http().post('/requests').set(...auth(buyer)).send({
      title: `Award race ${randomUUID()}`, items: [{ name: 'Item', qty: 2, estUnitPriceMinor: 100 }],
    }).expect(201)).body;
    await http().post(`/requests/${req.id}/submit`).set(...auth(buyer)).expect(201);
    await http().post(`/requests/${req.id}/approve`).set(...auth(approver)).expect(201);
    const ev = (await http().post(`/events/from-request/${req.id}`).set(...auth(buyer)).send({
      visibility: 'PUBLIC', closeAt: new Date(Date.now() + 3600000).toISOString(),
    }).expect(201)).body;
    await http().post(`/events/${ev.id}/publish`).set(...auth(buyer)).expect(201);
    const bid = (await http().post(`/events/${ev.id}/bid`).set(...auth(supplier)).send({
      items: [{ eventItemId: ev.items[0].id, unitPriceMinor: 90 }],
    }).expect(201)).body;
    await owner.query("UPDATE sourcing_events SET close_at=now()-interval '1 second' WHERE id=$1", [ev.id]);
    await owner.query('SELECT * FROM close_due_events()');
    await http().post(`/events/${ev.id}/open`).set(...auth(buyer)).expect(201);
    const evaluation = (await http().post(`/events/${ev.id}/evaluate`).set(...auth(buyer)).send({ scores: [
      { bidId: bid.id, key: 'price', score: 100 }, { bidId: bid.id, key: 'delivery', score: 100 },
    ] }).expect(201)).body;
    return { eventId: ev.id, lotId: ev.lots[0].id, bidId: bid.id, evaluationId: evaluation.evaluation_id };
  }
  const award = (ev: { eventId: string; lotId: string; bidId: string }) =>
    http().post(`/events/${ev.eventId}/award`).set(...auth(buyer)).send({
      lotId: ev.lotId, bidId: ev.bidId, justification: 'Sole compliant fixture bid',
    }).then(r => r);
  async function awarded() {
    const ev = await evaluated(); const result = await award(ev);
    expect(result.status).toBe(201);
    return { ...ev, awardId: result.body.award.id };
  }
  async function hold(eventId: string) {
    await owner.query('BEGIN');
    await owner.query('SELECT pg_advisory_xact_lock(hashtextextended($1,42))', [eventId]);
  }
  async function waitBlocked(count: number) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await owner.query('SELECT pg_stat_clear_snapshot()');
      const blocked = (await owner.query(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event='advisory' AND $1=ANY(pg_blocking_pids(pid))`, [holderPid])).rows[0].n;
      if (blocked >= count) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Did not observe ${count} real requests blocked on the fixture event lock`);
  }
  const create = (awardId: string) => http().post(`/contracts/from-award/${awardId}`).set(...auth(buyer)).then(r => r);
  const cancel = (ev: { eventId: string; lotId: string }) => http().post(`/events/${ev.eventId}/cancel-award`)
    .set(...auth(buyer)).send({ lotId: ev.lotId, reason: 'Observed concurrent cancellation' }).then(r => r);
  async function state(awardId: string) {
    return (await owner.query(`SELECT a.cancelled_at,
      (SELECT count(*)::int FROM contracts c WHERE c.award_id=a.id) AS contracts,
      (SELECT count(*)::int FROM audit_events e WHERE e.org_id=$2 AND e.action='CONTRACT_CREATED'
        AND e.payload->>'award_id'=a.id::text) AS contract_audits,
      (SELECT count(*)::int FROM audit_events e WHERE e.org_id=$2 AND e.action='EVENT_AWARD_CANCELLED'
        AND e.payload->>'award_id'=a.id::text) AS cancel_audits
      FROM awards a WHERE a.id=$1`, [awardId, buyerOrg])).rows[0];
  }

  it('eight observed concurrent retries create exactly one contract and one audit', async () => {
    const ev = await awarded(); await hold(ev.eventId);
    const pending = Array.from({ length: 8 }, () => create(ev.awardId));
    let responses: PromiseSettledResult<any>[] = [];
    try { await waitBlocked(8); }
    finally { await owner.query('ROLLBACK'); responses = await Promise.allSettled(pending); }
    const contracts = responses.map(r => { if (r.status === 'rejected') throw r.reason; expect(r.value.status).toBe(201); return r.value.body; });
    expect(new Set(contracts.map(c => c.id)).size).toBe(1);
    expect(contracts.every(c => Number(c.total_minor) === 180)).toBe(true);
    expect(await state(ev.awardId)).toMatchObject({ cancelled_at: null, contracts: 1, contract_audits: 1, cancel_audits: 0 });
  });

  for (const first of ['cancel', 'contract'] as const) {
    it(`${first} queued first cannot leave a contract linked to a cancelled award`, async () => {
      const ev = await awarded(); await hold(ev.eventId);
      const pending: Promise<any>[] = [];
      let results: PromiseSettledResult<any>[] = [];
      try {
        pending.push(first === 'cancel' ? cancel(ev) : create(ev.awardId));
        await waitBlocked(1);
        pending.push(first === 'cancel' ? create(ev.awardId) : cancel(ev));
        await waitBlocked(2);
      } finally { await owner.query('ROLLBACK'); results = await Promise.allSettled(pending); }
      const responses = results.map(r => { if (r.status === 'rejected') throw r.reason; return r.value; });
      if (first === 'cancel') {
        expect(responses.map(r => r.status)).toEqual([201, 404]);
        const after = await state(ev.awardId);
        expect(after.cancelled_at).not.toBeNull();
        expect(after).toMatchObject({ contracts: 0, contract_audits: 0, cancel_audits: 1 });
        await http().post(`/contracts/from-award/${ev.awardId}`).set(...auth(buyer)).expect(404);
      } else {
        expect(responses.map(r => r.status)).toEqual([201, 400]);
        expect(await state(ev.awardId)).toMatchObject({ cancelled_at: null, contracts: 1, contract_audits: 1, cancel_audits: 0 });
      }
    });
  }

  for (const first of ['evaluate', 'award'] as const) {
    it(`LP-A06 ${first} queued first keeps the award tied to its actual evaluation`, async () => {
      const ev = await evaluated(); await hold(ev.eventId);
      const reEvaluate = () => http().post(`/events/${ev.eventId}/evaluate`).set(...auth(buyer)).send({ scores: [
        { bidId: ev.bidId, key: 'price', score: 25 }, { bidId: ev.bidId, key: 'delivery', score: 25 },
      ] }).then(r => r);
      const pending: Promise<any>[] = [];
      let results: PromiseSettledResult<any>[] = [];
      try {
        pending.push(first === 'evaluate' ? reEvaluate() : award(ev));
        await waitBlocked(1);
        pending.push(first === 'evaluate' ? award(ev) : reEvaluate());
        await waitBlocked(2);
      } finally { await owner.query('ROLLBACK'); results = await Promise.allSettled(pending); }
      const responses = results.map(r => { if (r.status === 'rejected') throw r.reason; return r.value; });
      expect(responses.map(r => r.status)).toEqual(first === 'evaluate' ? [201, 201] : [201, 400]);
      const expectedEvaluation = first === 'evaluate' ? responses[0].body.evaluation_id : ev.evaluationId;
      const awards = (await owner.query('SELECT evaluation_id FROM awards WHERE event_id=$1 AND cancelled_at IS NULL', [ev.eventId])).rows;
      expect(awards).toEqual([{ evaluation_id: expectedEvaluation }]);
      const evaluations = (await owner.query('SELECT count(*)::int AS n FROM evaluations WHERE event_id=$1', [ev.eventId])).rows[0].n;
      expect(evaluations).toBe(first === 'evaluate' ? 2 : 1);
      const audits = (await owner.query("SELECT payload->>'evaluation_id' AS evaluation_id FROM audit_events WHERE entity_id=$1 AND action='EVENT_AWARDED'", [ev.eventId])).rows;
      expect(audits).toEqual([{ evaluation_id: expectedEvaluation }]);
    });
  }

  for (const first of ['disqualify', 'award'] as const) {
    it(`LP-A06 ${first} queued first cannot award a disqualified bid`, async () => {
      const ev = await evaluated(); await hold(ev.eventId);
      const disqualify = () => http().post(`/events/${ev.eventId}/bids/${ev.bidId}/disqualify`).set(...auth(buyer))
        .send({ reason: 'Concurrent fixture disqualification' }).then(r => r);
      const pending: Promise<any>[] = [];
      let results: PromiseSettledResult<any>[] = [];
      try {
        pending.push(first === 'disqualify' ? disqualify() : award(ev));
        await waitBlocked(1);
        pending.push(first === 'disqualify' ? award(ev) : disqualify());
        await waitBlocked(2);
      } finally { await owner.query('ROLLBACK'); results = await Promise.allSettled(pending); }
      const responses = results.map(r => { if (r.status === 'rejected') throw r.reason; return r.value; });
      expect(responses.map(r => r.status)).toEqual([201, 400]);
      const bid = (await owner.query('SELECT state FROM bids WHERE id=$1', [ev.bidId])).rows[0];
      expect(bid.state).toBe(first === 'disqualify' ? 'DISQUALIFIED' : 'OPENED');
      const awards = (await owner.query('SELECT count(*)::int AS n FROM awards WHERE event_id=$1 AND cancelled_at IS NULL', [ev.eventId])).rows[0].n;
      expect(awards).toBe(first === 'disqualify' ? 0 : 1);
      const audits = (await owner.query("SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND action='BID_DISQUALIFIED'", [ev.bidId])).rows[0].n;
      expect(audits).toBe(first === 'disqualify' ? 1 : 0);
    });
  }
});
