import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';

// Server-side offset pagination on the growth lists (requests/events/contracts/orders):
// the API returns a { items, total, page, pageSize } envelope, honours ?page/?pageSize,
// and reports the full RLS-scoped total independent of the page window.
describe('list pagination (API e2e)', () => {
  let app: INestApplication;
  let db: Client;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ['Authorization', `Bearer ${t}`] as [string, string];
  let buyer: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const r = await http()
      .post('/auth/register/buyer')
      .send({ legalName: `Pg Buyer ${tag}`, email: `pg-${tag}@t.test`, password: 'password123', fullName: `Pg ${tag}` })
      .expect(201);
    buyer = r.body.accessToken;
    // seed 3 requests so a pageSize of 2 spans two pages
    for (let i = 1; i <= 3; i++) {
      await http().post('/requests').set(...bearer(buyer))
        .send({ title: `Pg req ${tag} #${i}`, items: [{ name: 'x', qty: 1, estUnitPriceMinor: 100 }] })
        .expect(201);
    }
  });

  afterAll(async () => {
    await db.query(`DELETE FROM organizations WHERE legal_name LIKE $1`, [`Pg %${tag}%`]);
    await db.end();
    await app.close();
  });

  it('returns a { items, total, page, pageSize } envelope', async () => {
    const res = await http().get('/requests').set(...bearer(buyer)).expect(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.total).toBe('number');
    expect(res.body.page).toBe(1);
    expect(res.body.total).toBeGreaterThanOrEqual(3);
  });

  it('honours pageSize and total is the full count, not the page size', async () => {
    const p1 = await http().get('/requests').query({ page: 1, pageSize: 2 }).set(...bearer(buyer)).expect(200);
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.pageSize).toBe(2);
    expect(p1.body.total).toBeGreaterThanOrEqual(3);
  });

  it('page 2 returns the next window with no overlap', async () => {
    const p1 = await http().get('/requests').query({ page: 1, pageSize: 2 }).set(...bearer(buyer)).expect(200);
    const p2 = await http().get('/requests').query({ page: 2, pageSize: 2 }).set(...bearer(buyer)).expect(200);
    expect(p2.body.page).toBe(2);
    const ids1 = new Set(p1.body.items.map((r: any) => r.id));
    for (const r of p2.body.items) expect(ids1.has(r.id)).toBe(false);
  });

  it('clamps a garbage pageSize instead of trusting it', async () => {
    const res = await http().get('/requests').query({ page: 0, pageSize: 99999 }).set(...bearer(buyer)).expect(200);
    expect(res.body.page).toBe(1); // page floored to 1
    expect(res.body.pageSize).toBeLessThanOrEqual(200); // pageSize capped
  });
});
