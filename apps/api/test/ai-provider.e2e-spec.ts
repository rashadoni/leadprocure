import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { createServer, type Server } from 'http';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { addApprover } from './helpers';

type ProviderBid = { bid_id: string; supplier_name: string; total_minor: number; delivery_days: number | null; reliability: number };
type ProviderInput = { currency: string; bids: ProviderBid[] };

describe('LP-A12 real HTTP scorer boundary with actual auth/SQL/RLS', () => {
  let app: INestApplication, db: Client, server: Server;
  let buyer: string, foreignBuyer: string, eventId: string, lotId: string, bestBidId: string;
  let mode: 'json' | 'bad-json' | 'unavailable' | 'disconnect' = 'json';
  let transform: (data: any) => void = () => {};
  const received: ProviderInput[] = [];
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const endpoint = () => `/events/${eventId}/ai-recommendation?lotId=${lotId}&language=az`;
  const valid = (input: ProviderInput) => {
    const bestPrice = Math.min(...input.bids.map(b => b.total_minor));
    const deliveries = input.bids.filter(b => b.delivery_days !== null).map(b => b.delivery_days as number);
    const bestDelivery = deliveries.length ? Math.min(...deliveries) : null;
    const ranking = input.bids.map(b => {
      const priceScore = b.total_minor === 0 ? 100 : Math.round(bestPrice / b.total_minor * 100);
      const deliveryScore = b.delivery_days == null || bestDelivery == null ? 60 : b.delivery_days === 0 ? 100 : Math.round(bestDelivery / b.delivery_days * 100);
      return { bidId: b.bid_id, supplierName: b.supplier_name, totalMinor: b.total_minor, deliveryDays: b.delivery_days,
        priceScore, deliveryScore, reliabilityScore: b.reliability,
        weightedTotal: Math.round((priceScore * 0.5 + deliveryScore * 0.2 + b.reliability * 0.3) * 10) / 10,
        reasons: ['No scorecard history yet (neutral reliability)'] };
    }).sort((a, b) => b.weightedTotal - a.weightedTotal);
    return { model: 'fixture-http-scorer', weights: { price: 0.5, delivery: 0.2, reliability: 0.3 }, ranking,
      recommendedBidId: ranking[0].bidId, rationale: 'A controlled local HTTP provider, not a live LLM.' };
  };
  beforeAll(async () => {
    // A real socket/JSON boundary: only the remote scorer is controlled. All database,
    // request context, guards and localization below are the actual application.
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const input = JSON.parse(Buffer.concat(chunks).toString()) as ProviderInput;
        received.push(input);
        if (mode === 'disconnect') { req.socket.destroy(); return; }
        if (mode === 'unavailable') { res.writeHead(503); res.end('unavailable'); return; }
        res.setHeader('content-type', 'application/json');
        if (mode === 'bad-json') { res.end('not-json'); return; }
        const data = valid(input); transform(data); res.end(JSON.stringify(data));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind');
    const previous = process.env.AI_ORCHESTRATOR_URL;
    process.env.AI_ORCHESTRATOR_URL = `http://127.0.0.1:${address.port}`;
    try {
      const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = mod.createNestApplication(); app.use(cookieParser());
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
    } finally {
      if (previous === undefined) delete process.env.AI_ORCHESTRATOR_URL; else process.env.AI_ORCHESTRATOR_URL = previous;
    }
    db = new Client({ connectionString: process.env.DATABASE_OWNER_URL }); await db.connect();
    const register = async (kind: string, name: string) => (await http().post(`/auth/register/${kind}`).send({
      legalName: `AI boundary ${name} ${tag}`, fullName: name, email: `ai-${name}-${tag}@audit.invalid`, password: 'Fixture-password123',
    }).expect(201)).body;
    buyer = (await register('buyer', 'buyer')).accessToken;
    foreignBuyer = (await register('buyer', 'other')).accessToken;
    const approver = await addApprover(app, buyer, `ai-${tag}`);
    const suppliers = [await register('supplier', 'zero'), await register('supplier', 'positive')];
    const req = (await http().post('/requests').set(auth(buyer)).send({ title: `AI boundary ${tag}`, items: [{ name: 'Comparable item', qty: 1, estUnitPriceMinor: 100 }] }).expect(201)).body;
    await http().post(`/requests/${req.id}/submit`).set(auth(buyer)).expect(201);
    await http().post(`/requests/${req.id}/approve`).set(auth(approver)).expect(201);
    const event = (await http().post(`/events/from-request/${req.id}`).set(auth(buyer)).send({ visibility: 'PUBLIC', closeAt: new Date(Date.now() + 3600000).toISOString() }).expect(201)).body;
    eventId = event.id; lotId = event.lots[0].id;
    await http().post(`/events/${eventId}/publish`).set(auth(buyer)).expect(201);
    for (let i = 0; i < suppliers.length; i++) {
      const bid = (await http().post(`/events/${eventId}/bid`).set(auth(suppliers[i].accessToken)).send({
        deliveryDays: i * 2, items: [{ eventItemId: event.items[0].id, unitPriceMinor: i * 100 }],
      }).expect(201)).body;
      if (!i) bestBidId = bid.id;
    }
    // No financial/proposal payload may be sent to an external provider before opening.
    await http().get(endpoint()).set(auth(buyer)).expect(400);
    expect(received).toHaveLength(0);
    await db.query(`UPDATE sourcing_events SET close_at=now()-interval '1 second' WHERE id=$1`, [eventId]);
    await db.query('SELECT * FROM close_due_events()');
    await http().post(`/events/${eventId}/open`).set(auth(buyer)).expect(201);
  });
  afterAll(async () => {
    if (app) await app.close(); if (db) await db.end();
    if (server) await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  });
  beforeEach(() => { mode = 'json'; transform = () => {}; });
  const assertFallback = async () => {
    const count = received.length;
    const response = await http().get(endpoint()).set(auth(buyer)).expect(200);
    expect(received).toHaveLength(count + 1);
    expect(response.body.model).toBe('heuristic-v1');
    expect(response.body.recommendedBidId).toBe(bestBidId);
    expect(response.body.ranking).toHaveLength(2);
    expect(response.body.weights).toEqual({ price: 0.5, delivery: 0.2, reliability: 0.3 });
    expect(response.body.rationale).toContain('köməkçi');
    for (const row of response.body.ranking) {
      for (const key of ['priceScore', 'deliveryScore', 'reliabilityScore', 'weightedTotal']) {
        expect(Number.isFinite(row[key])).toBe(true); expect(row[key]).toBeGreaterThanOrEqual(0); expect(row[key]).toBeLessThanOrEqual(100);
      }
      expect(row.reasons.every((reason: unknown) => typeof reason === 'string')).toBe(true);
    }
  };
  it('accepts valid zero/same-day scores while keeping price, identity and delivery facts authoritative', async () => {
    transform = data => { for (const row of data.ranking) { row.supplierName = 'FORGED PROVIDER NAME'; row.totalMinor = 999999; row.deliveryDays = 999; } };
    const result = await http().get(endpoint()).set(auth(buyer)).expect(200);
    expect(result.body.model).toBe('fixture-http-scorer');
    expect(result.body.recommendedBidId).toBe(bestBidId);
    expect(result.body.ranking[0]).toMatchObject({ totalMinor: 0, deliveryDays: 0, priceScore: 100, deliveryScore: 100, reliabilityScore: 60, weightedTotal: 88 });
    expect(result.body.ranking[0].supplierName).toBe(`AI boundary zero ${tag}`);
    expect(JSON.stringify(result.body)).not.toContain('FORGED PROVIDER NAME');
    const payload = received[received.length - 1];
    expect(payload.currency).toBe('AZN');
    expect(payload.bids.find(b => b.bid_id === bestBidId)).toMatchObject({ total_minor: 0, delivery_days: 0, reliability: 60 });
    expect((await http().get(`/events/${eventId}`).set(auth(buyer)).expect(200)).body.awards).toEqual([]);
  });
  const invalid: Array<[string, (data: any) => void]> = [
    ['missing weights', d => { delete d.weights; }],
    ['string weights', d => { d.weights.price = '0.5'; }],
    ['different weighting policy', d => { d.weights = { price: 0.6, delivery: 0.1, reliability: 0.3 }; }],
    ['empty model', d => { d.model = ''; }],
    ['object rationale', d => { d.rationale = { text: 'wrong shape' }; }],
    ['missing reasons', d => { delete d.ranking[0].reasons; }],
    ['non-string reason', d => { d.ranking[0].reasons = [42]; }],
    ['non-finite score encoded as null', d => { d.ranking[0].priceScore = NaN; }],
    ['negative score', d => { d.ranking[0].priceScore = -1; }],
    ['duplicate bid IDs', d => { d.ranking[1].bidId = d.ranking[0].bidId; }],
    ['unknown bid ID', d => { d.ranking[1].bidId = randomUUID(); }],
    ['inverted ranking', d => { d.ranking.reverse(); d.recommendedBidId = d.ranking[0].bidId; }],
    ['inconsistent weighted total', d => { d.ranking[0].weightedTotal = 99; }],
  ];
  it.each(invalid)('falls back safely for %s', async (_name, mutation) => { transform = mutation; await assertFallback(); });
  it.each(['bad-json', 'unavailable', 'disconnect'] as const)('falls back for actual HTTP %s', async failure => { mode = failure; await assertFallback(); });
  it('a foreign buyer cannot obtain the event or cause a scorer request', async () => {
    const count = received.length;
    await http().get(endpoint()).set(auth(foreignBuyer)).expect(404);
    expect(received).toHaveLength(count);
  });
});
