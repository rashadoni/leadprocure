import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { Client } from 'pg';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { addApprover } from './helpers';

// Remaining explicit LP-A08/A18 criteria. Only deadline setup and lock observation
// use the owner role; every procurement write uses authenticated HTTP and real RLS.
describe('LP-A08/A18 safe money and sealed deadline boundaries', () => {
  let app: INestApplication, holder: Client, clock: Client, holderPid: number;
  let buyer: string, supplier: string, approver: string;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication(); app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
    holder = new Client({ connectionString: process.env.DATABASE_OWNER_URL }); await holder.connect();
    clock = new Client({ connectionString: process.env.DATABASE_OWNER_URL }); await clock.connect();
    holderPid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const register = async (kind: string) => (await http().post(`/auth/register/${kind}`).send({ legalName: `Deadline ${kind} ${tag}`,
      fullName: 'Boundary fixture', email: `deadline-${kind}-${tag}@audit.invalid`, password: 'Fixture-password123',
    }).expect(201)).body.accessToken;
    buyer = await register('buyer'); supplier = await register('supplier');
    approver = await addApprover(app, buyer, `deadline-${tag}`);
  });
  afterAll(async () => {
    if (holder) { await holder.query('ROLLBACK'); await holder.end(); }
    if (clock) await clock.end(); if (app) await app.close();
  });
  async function openEvent() {
    const req = (await http().post('/requests').set(auth(buyer)).send({ title: `Deadline event ${randomUUID()}`,
      items: [{ name: 'Item', qty: 2, estUnitPriceMinor: 100 }],
    }).expect(201)).body;
    await http().post(`/requests/${req.id}/submit`).set(auth(buyer)).expect(201);
    await http().post(`/requests/${req.id}/approve`).set(auth(approver)).expect(201);
    const ev = (await http().post(`/events/from-request/${req.id}`).set(auth(buyer)).send({
      visibility: 'PUBLIC', closeAt: new Date(Date.now() + 3600000).toISOString(),
    }).expect(201)).body;
    await http().post(`/events/${ev.id}/publish`).set(auth(buyer)).expect(201);
    const bid = (await http().post(`/events/${ev.id}/bid`).set(auth(supplier)).send({
      items: [{ eventItemId: ev.items[0].id, unitPriceMinor: 90 }],
    }).expect(201)).body;
    return { eventId: ev.id, itemId: ev.items[0].id, bidId: bid.id, hash: bid.payload_sha256 };
  }
  async function hold(eventId: string) {
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,42))', [eventId]);
  }
  async function waitBlocked(count: number) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await holder.query('SELECT pg_stat_clear_snapshot()');
      const blocked = (await holder.query(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event='advisory' AND $1=ANY(pg_blocking_pids(pid))`, [holderPid])).rows[0].n;
      if (blocked >= count) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Did not observe ${count} actual HTTP requests at the event lock`);
  }
  async function close(eventId: string) {
    await clock.query("UPDATE sourcing_events SET close_at=clock_timestamp()-interval '1 second' WHERE id=$1", [eventId]);
    await clock.query('SELECT * FROM close_due_events()');
  }
  const unsafe = [
    ['unsafe unit amount', [{ name: 'x', qty: 1, estUnitPriceMinor: Number.MAX_SAFE_INTEGER + 1 }]],
    ['unsafe line product', [{ name: 'x', qty: 2, estUnitPriceMinor: Number.MAX_SAFE_INTEGER }]],
    ['unsafe aggregate', [{ name: 'x', qty: 1, estUnitPriceMinor: 2 ** 52 }, { name: 'y', qty: 1, estUnitPriceMinor: 2 ** 52 }]],
  ] as const;
  it.each(unsafe)('rejects %s over HTTP without saving a request', async (name, items) => {
    const title = `Unsafe ${name} ${tag}`;
    await http().post('/requests').set(auth(buyer)).send({ title, items }).expect(400);
    const list = await http().get('/requests').query({ q: title }).set(auth(buyer)).expect(200);
    expect(list.body.items).toEqual([]);
  });
  it('an overflowing replacement quote leaves the original sealed quote unchanged', async () => {
    const ev = await openEvent();
    const original = (await http().get(`/events/${ev.eventId}`).set(auth(supplier)).expect(200)).body.my_bid;
    await http().post(`/events/${ev.eventId}/bid`).set(auth(supplier)).send({
      items: [{ eventItemId: ev.itemId, unitPriceMinor: Number.MAX_SAFE_INTEGER }],
    }).expect(400);
    const own = (await http().get(`/events/${ev.eventId}`).set(auth(supplier)).expect(200)).body;
    expect(own.my_bid.id).toBe(ev.bidId); expect(own.my_bid.payload).toEqual(original.payload);
    expect(own.my_bid.payload.total_minor).toBe(180);
    const buyerView = (await http().get(`/events/${ev.eventId}`).set(auth(buyer)).expect(200)).body;
    expect(buyerView.bids[0].total_minor).toBeNull();
    expect((await clock.query(`SELECT count(*)::int AS n FROM audit_events WHERE action='BID_SUBMITTED' AND entity_id=$1`, [ev.bidId])).rows[0].n).toBe(1);
  });
  it('late queued resubmission and withdrawal cannot exploit a closer skipping a contended event', async () => {
    const ev = await openEvent(); await hold(ev.eventId);
    const pending: Array<Promise<any>> = [];
    let results: PromiseSettledResult<any>[] = [];
    try {
      // Another committed connection makes the real deadline visible while the event
      // lock stays held. The production closer uses TRY lock and must skip this event.
      await clock.query("UPDATE sourcing_events SET close_at=clock_timestamp()-interval '1 second' WHERE id=$1", [ev.eventId]);
      pending.push(http().post(`/events/${ev.eventId}/bid`).set(auth(supplier)).send({
        items: [{ eventItemId: ev.itemId, unitPriceMinor: 1 }],
      }).then(r => r));
      await waitBlocked(1);
      pending.push(http().post(`/events/${ev.eventId}/withdraw`).set(auth(supplier)).then(r => r));
      await waitBlocked(2);
      const skipped = await clock.query('SELECT * FROM close_due_events()');
      expect(skipped.rows.map(r => r.event_id)).not.toContain(ev.eventId);
      expect((await clock.query('SELECT status FROM sourcing_events WHERE id=$1', [ev.eventId])).rows[0].status).toBe('OPEN');
    } finally { await holder.query('ROLLBACK'); results = await Promise.allSettled(pending); }
    const responses = results.map(r => { if (r.status === 'rejected') throw r.reason; return r.value; });
    expect(responses.map(r => r.status)).toEqual([400, 400]);
    expect((await clock.query('SELECT state,total_minor FROM bids WHERE id=$1', [ev.bidId])).rows[0]).toMatchObject({ state: 'SUBMITTED', total_minor: null });
    expect((await clock.query('SELECT count(*)::int AS n FROM bid_items WHERE bid_id=$1', [ev.bidId])).rows[0].n).toBe(0);
    await clock.query('SELECT * FROM close_due_events()');
    const opened = (await http().post(`/events/${ev.eventId}/open`).set(auth(buyer)).expect(201)).body;
    expect(opened.bids[0].state).toBe('OPENED'); expect(Number(opened.bids[0].total_minor)).toBe(180);
    // The deadline close is the one transition nobody performs by hand, and it used to be
    // written with org_id NULL — a row no per-organization query can reach, so the tender's
    // own closing was missing from its history — carrying md5(id || clock_timestamp()) as
    // a "hash". It is now attributed and chained, and the digest recomputes from the row.
    const closedRow = (await clock.query(
      `SELECT a.org_id, a.prev_hash, a.hash,
              a.hash = encode(sha256(convert_to(coalesce(a.prev_hash,'') ||
                audit_body(a.org_id, a.actor_id, a.action, a.entity_type, a.entity_id,
                           a.payload, a.created_at), 'UTF8')), 'hex') AS verifies,
              (SELECT e.buyer_org_id FROM sourcing_events e WHERE e.id = a.entity_id) AS owner
         FROM audit_events a WHERE a.action='EVENT_CLOSED' AND a.entity_id=$1`, [ev.eventId])).rows;
    expect(closedRow).toHaveLength(1);
    expect(closedRow[0].org_id).toBe(closedRow[0].owner);
    expect(closedRow[0].verifies).toBe(true);
    expect(closedRow[0].hash).toHaveLength(64); // sha256 hex, not the old 32-char md5

    const audit = (await clock.query(`SELECT action,payload FROM audit_events WHERE entity_id=ANY($1::uuid[])`, [[ev.eventId, ev.bidId]])).rows;
    expect(audit.filter(r => r.action === 'BID_SUBMITTED')).toHaveLength(1);
    expect(audit.filter(r => r.action === 'BID_WITHDRAWN')).toHaveLength(0);
    expect(audit.filter(r => r.action === 'EVENT_OPENED')).toHaveLength(1);
    expect(audit.find(r => r.action === 'EVENT_OPENED').payload.receipt.bids[0].payload_sha256).toBe(ev.hash);
  });
  it('two actually queued opening requests materialize and audit a sealed bid once', async () => {
    const ev = await openEvent(); await close(ev.eventId); await hold(ev.eventId);
    const pending: Array<Promise<any>> = [];
    let results: PromiseSettledResult<any>[] = [];
    try {
      pending.push(http().post(`/events/${ev.eventId}/open`).set(auth(buyer)).then(r => r));
      await waitBlocked(1);
      pending.push(http().post(`/events/${ev.eventId}/open`).set(auth(buyer)).then(r => r));
      await waitBlocked(2);
    } finally { await holder.query('ROLLBACK'); results = await Promise.allSettled(pending); }
    const responses = results.map(r => { if (r.status === 'rejected') throw r.reason; return r.value; });
    expect(responses.map(r => r.status).sort()).toEqual([201, 400]);
    expect((await clock.query('SELECT count(*)::int AS n FROM bid_items WHERE bid_id=$1', [ev.bidId])).rows[0].n).toBe(1);
    expect((await clock.query(`SELECT count(*)::int AS n FROM audit_events WHERE action='EVENT_OPENED' AND entity_id=$1`, [ev.eventId])).rows[0].n).toBe(1);
  });
  it('a legitimate before-deadline withdrawal and replacement still opens the new quote', async () => {
    const ev = await openEvent();
    await http().post(`/events/${ev.eventId}/withdraw`).set(auth(supplier)).expect(201);
    const withdrawn = (await http().get(`/events/${ev.eventId}`).set(auth(supplier)).expect(200)).body;
    expect(withdrawn.my_bid.state).toBe('WITHDRAWN');
    const replacement = (await http().post(`/events/${ev.eventId}/bid`).set(auth(supplier)).send({
      items: [{ eventItemId: ev.itemId, unitPriceMinor: 75 }],
    }).expect(201)).body;
    expect(replacement.id).toBe(ev.bidId); expect(replacement.payload_sha256).not.toBe(ev.hash);
    await close(ev.eventId);
    const opened = (await http().post(`/events/${ev.eventId}/open`).set(auth(buyer)).expect(201)).body;
    expect(Number(opened.bids[0].total_minor)).toBe(150);
  });
});
