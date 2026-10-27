import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { Client } from 'pg';
import { randomUUID } from 'crypto';
import { writeFileSync } from 'fs';
import { AppModule } from '../src/app.module';
import { addApprover } from './helpers';

// Bounded contention gate on the guarded disposable DB, not a capacity/SLA claim.
// Run separately from the ordinary suite so each app's normal rate limits stay on.
const ROUNDS = 12, CONCURRENCY = 8;
describe('bounded concurrent procurement acceptance', () => {
  let app: INestApplication, db: Client, buyer: any, supplier: any;
  let tag: string;
  const results: Array<Record<string, unknown>> = [];
  const http = () => request(app.getHttpServer());
  const auth = (u: any) => ({ Authorization: `Bearer ${u.accessToken}` });
  beforeEach(async () => {
    if (process.env.LEADPROCURE_STRESS_ISOLATED !== '1') throw new Error('Explicit isolated stress gate required');
    require('../../../scripts/acceptance/assert-isolated.cjs')();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication(); app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    db = new Client({ connectionString: process.env.DATABASE_OWNER_URL }); await db.connect();
    tag = randomUUID().slice(0, 8);
    const register = async (kind: string) => (await http().post(`/auth/register/${kind}`).send({
      legalName: `Stress ${tag} ${kind}`, email: `${kind}-${tag}@acceptance.invalid`,
      password: 'isolated-password123', fullName: 'Contention acceptance',
    }).expect(201)).body;
    buyer = await register('buyer'); supplier = await register('supplier');
  });
  afterEach(async () => { if (app) await app.close(); if (db) await db.end(); });
  afterAll(() => {
    if (results.length === 3 && process.env.STRESS_EVIDENCE_FILE) {
      writeFileSync(process.env.STRESS_EVIDENCE_FILE, JSON.stringify({
        status: 'PASS', rounds: ROUNDS, concurrency: CONCURRENCY, scenarios: results,
        productionCapacityOrSla: false,
      }, null, 2));
    }
  });
  // Only synthetic prerequisite rows use the owner fixture connection. Every
  // contended operation goes through actual HTTP guards/RLS/transactions.
  const po = async () => {
    const user = (await db.query('SELECT user_id FROM memberships WHERE org_id=$1 LIMIT 1', [buyer.org.id])).rows[0].user_id;
    const p = (await db.query(`INSERT INTO purchase_orders(buyer_org_id,supplier_org_id,po_no,status,total_minor,currency,created_by,vat_mode)
      VALUES($1,$2,$3,'DELIVERED',1000,'AZN',$4,'EXCLUSIVE') RETURNING id`,
    [buyer.org.id, supplier.org.id, randomUUID(), user])).rows[0].id;
    const i = (await db.query(`INSERT INTO purchase_order_items(po_id,buyer_org_id,supplier_org_id,line_no,name,qty,uom,unit_price_minor,line_total_minor,vat_rate_bp)
      VALUES($1,$2,$3,1,'Contention item',10,'pcs',100,1000,0) RETURNING id`,
    [p, buyer.org.id, supplier.org.id])).rows[0].id;
    return { p, i };
  };
  it('12 batches of 8 simultaneous receipts never over-receive', async () => {
    const started = Date.now();
    for (let round = 0; round < ROUNDS; round++) {
      const { p, i } = await po();
      const responses = await Promise.all(Array.from({ length: CONCURRENCY }, () =>
        http().post(`/orders/${p}/receipts`).set(auth(buyer)).send({ items: [{ poItemId: i, qty: 10 }] })));
      expect(responses.filter(r => r.status === 201)).toHaveLength(1);
      expect(responses.filter(r => r.status === 400)).toHaveLength(CONCURRENCY - 1);
      const qty = (await db.query('SELECT sum(qty_received) q FROM goods_receipt_items WHERE po_item_id=$1', [i])).rows[0].q;
      expect(Number(qty)).toBe(10);
    }
    results.push({ scenario: 'receipts', contestedRequests: ROUNDS * CONCURRENCY,
      accepted: ROUNDS, overReceived: 0, elapsedMs: Date.now() - started });
  }, 90_000);
  it('12 batches of 8 invoices reserve received quantities only once', async () => {
    const started = Date.now();
    for (let round = 0; round < ROUNDS; round++) {
      const { p, i } = await po();
      await http().post(`/orders/${p}/receipts`).set(auth(buyer)).send({ items: [{ poItemId: i, qty: 10 }] }).expect(201);
      const responses = await Promise.all(Array.from({ length: CONCURRENCY }, () =>
        http().post(`/invoices/from-po/${p}`).set(auth(supplier)).send({ items: [{ poItemId: i, qty: 10, unitPriceMinor: 100 }] })));
      expect(responses.every(r => r.status === 201)).toBe(true);
      expect(responses.filter(r => r.body.status === 'MATCHED')).toHaveLength(1);
      expect(responses.filter(r => r.body.status === 'DISPUTED')).toHaveLength(CONCURRENCY - 1);
      const matched = (await db.query("SELECT count(*) n FROM invoices WHERE po_id=$1 AND status='MATCHED'", [p])).rows[0].n;
      expect(Number(matched)).toBe(1);
    }
    results.push({ scenario: 'invoice-reservation', contestedRequests: ROUNDS * CONCURRENCY,
      matched: ROUNDS, duplicateReservations: 0, elapsedMs: Date.now() - started });
  }, 90_000);
  it('concurrent auction retries create one tick; closure rejects all late ticks', async () => {
    const started = Date.now();
    const approver = await addApprover(app, buyer.accessToken, tag);
    const req = (await http().post('/requests').set(auth(buyer)).send({ title: `Stress auction ${tag}`,
      items: [{ name: 'Auction item', qty: 1, estUnitPriceMinor: 100_000 }] }).expect(201)).body;
    await http().post(`/requests/${req.id}/submit`).set(auth(buyer)).expect(201);
    await http().post(`/requests/${req.id}/approve`).set('Authorization', `Bearer ${approver}`).expect(201);
    const ev = (await http().post(`/events/reverse/from-request/${req.id}`).set(auth(buyer)).send({
      closeAt: new Date(Date.now() + 3600_000).toISOString(), visibility: 'PUBLIC',
      startPriceMinor: 100_000, minDecrementMinor: 500,
    }).expect(201)).body;
    const pub = (await http().post(`/events/${ev.id}/publish`).set(auth(buyer)).expect(201)).body;
    const itemId = pub.items[0].id;
    for (let round = 0; round < ROUNDS; round++) {
      const key = `${tag}-${round}`;
      const amount = 99_000 - round * 1000;
      const responses = await Promise.all(Array.from({ length: CONCURRENCY }, () =>
        http().post(`/events/${ev.id}/auction/bids`).set(auth(supplier)).send({
          items: [{ eventItemId: itemId, unitPriceMinor: amount }], idempotencyKey: key,
        })));
      expect(responses.every(r => r.status === 201)).toBe(true);
      expect(new Set(responses.map(r => r.body.id)).size).toBe(1);
      expect(responses.every(r => Number(r.body.total_minor) === amount)).toBe(true);
      expect(responses.filter(r => r.body.idempotent === true)).toHaveLength(CONCURRENCY - 1);
    }
    expect(Number((await db.query('SELECT count(*) n FROM auction_bids WHERE event_id=$1', [ev.id])).rows[0].n)).toBe(ROUNDS);
    await db.query("UPDATE sourcing_events SET close_at=clock_timestamp()-interval '1 second' WHERE id=$1", [ev.id]);
    const closers = Array.from({ length: CONCURRENCY }, () => new Client({
      connectionString: process.env.DATABASE_OWNER_URL, connectionTimeoutMillis: 10_000,
    }));
    const connections = closers.map(c => c.connect());
    let responses: request.Response[] = [];
    let release: Promise<unknown> | undefined;
    try {
      await Promise.all(connections);
      const pids = await Promise.all(closers.map(async c => Number((await c.query('SELECT pg_backend_pid() pid')).rows[0].pid)));
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,42)), pg_advisory_xact_lock(hashtextextended($2,99))',
        [ev.id, `${ev.id}:stress-gate`]);
      // .then starts Supertest immediately; distinct DB clients wait on a shared
      // start barrier while the real HTTP bids wait on the event lock.
      const late = Array.from({ length: CONCURRENCY }, () => http().post(`/events/${ev.id}/auction/bids`).set(auth(supplier))
        .send({ items: [{ eventItemId: itemId, unitPriceMinor: 1 }], idempotencyKey: randomUUID() }).then(r => r));
      const close = closers.map(async c => {
        await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,99))', [`${ev.id}:stress-gate`]);
        return c.query('SELECT * FROM close_due_events()');
      });
      const all = Promise.all([Promise.all(late), Promise.all(close)]);
      release = all; // always drain outstanding work before closing its connections
      const deadline = Date.now() + 10_000;
      let observed = false;
      while (Date.now() < deadline) {
        await db.query('SELECT pg_stat_clear_snapshot()');
        const waiting = (await db.query(`SELECT
          count(*) FILTER (WHERE pid=ANY($1::int[])) closers,
          count(*) FILTER (WHERE usename='app_user' AND query LIKE '%pg_advisory_xact_lock(hashtextextended%') bids
          FROM pg_stat_activity WHERE wait_event_type='Lock' AND wait_event='advisory'`, [pids])).rows[0];
        if (Number(waiting.closers) === CONCURRENCY && Number(waiting.bids) >= CONCURRENCY) { observed = true; break; }
        await new Promise(r => setTimeout(r, 20));
      }
      await db.query('COMMIT');
      [responses] = await all;
      expect(observed).toBe(true);
    } finally {
      await db.query('ROLLBACK'); // also releases barriers on any failed assertion
      try {
        await Promise.allSettled(connections);
        if (release) await Promise.allSettled([release]);
      } finally {
        await Promise.all(closers.map(c => c.end()));
      }
    }
    // try-lock schedulers may legitimately skip an event while a bidder holds
    // its lock. One subsequent pass must close it, and never create two audits.
    await db.query('SELECT * FROM close_due_events()');
    expect(responses.every(r => r.status === 400)).toBe(true);
    expect((await db.query('SELECT status FROM sourcing_events WHERE id=$1', [ev.id])).rows[0].status).toBe('CLOSED');
    expect(Number((await db.query('SELECT count(*) n FROM auction_bids WHERE event_id=$1', [ev.id])).rows[0].n)).toBe(ROUNDS);
    expect(Number((await db.query("SELECT count(*) n FROM audit_events WHERE action='EVENT_CLOSED' AND entity_id=$1", [ev.id])).rows[0].n)).toBe(1);
    results.push({ scenario: 'auction-idempotency-and-close', contestedRequests: ROUNDS * CONCURRENCY + CONCURRENCY,
      committedTicks: ROUNDS, lateAccepted: 0, independentCloserConnections: CONCURRENCY,
      observedBlockedBidsAndClosers: true, closeAuditCount: 1, elapsedMs: Date.now() - started });
  }, 90_000);
});
