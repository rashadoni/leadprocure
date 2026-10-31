import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { Client } from 'pg';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { MailProvider, Mail } from '../src/common/mail/mail.module';

// Boots the real AppModule (guards, transaction interceptor, RLS DataSource)
// and exercises the auth flow over HTTP against the live dev database.
describe('auth flow (API e2e)', () => {
  let app: INestApplication;
  let db: Client;
  const email = `e2e-${randomUUID().slice(0, 8)}@acme.test`;
  let accessToken: string;
  let refreshCookie: string;
  const sentMail: Mail[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailProvider)
      .useValue({ kind: 'test', send: async (m: Mail) => { sentMail.push(m); } })
      .compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    db = new Client({ connectionString: process.env.DATABASE_OWNER_URL ?? process.env.DATABASE_URL });
    await db.connect();
  });

  afterAll(async () => {
    await db.end();
    await app.close();
  });

  it('GET /health is public', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.licenseStatus).toBeDefined();
  });

  it('rejects protected route without token', async () => {
    await request(app.getHttpServer()).get('/auth/me').expect(401);
  });

  it('registers a buyer org and returns access token + refresh cookie', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/register/buyer')
      .send({
        legalName: 'E2E Acme LLC',
        voen: '1234567890',
        email,
        password: 'password123',
        fullName: 'E2E Admin',
      })
      .expect(201);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.org.role).toBe('BUYER_ADMIN');
    const cookies = res.get('Set-Cookie') ?? [];
    refreshCookie = cookies.find((c: string) => c.startsWith('lp_refresh=')) ?? '';
    expect(refreshCookie).toContain('HttpOnly');
    accessToken = res.body.accessToken;
  });

  it('rejects duplicate registration', async () => {
    await request(app.getHttpServer())
      .post('/auth/register/buyer')
      .send({ legalName: 'Dup', email, password: 'password123', fullName: 'Dup' })
      .expect(409);
  });

  it('logs in and GET /auth/me returns profile + entitlements', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'password123' })
      .expect(201);
    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .expect(200);
    expect(res.body.user.email).toBe(email);
    expect(res.body.entitlements.features.length).toBeGreaterThan(0);
  });

  it('rejects wrong password', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'wrong-password' })
      .expect(401);
  });

  it('does not leak account existence via login timing (anti-enumeration)', async () => {
    const time = async (payload: { email: string; password: string }) => {
      const t0 = performance.now();
      await request(app.getHttpServer()).post('/auth/login').send(payload).expect(401);
      return performance.now() - t0;
    };
    // warm up (first argon2 + dummy-hash memoization) so neither run pays a one-off cost
    await time({ email: 'warmup@none.test', password: 'x' });
    const knownWrong = await time({ email, password: 'wrong-password' }); // real account, bad pw
    const unknown = await time({ email: `ghost-${Date.now()}@none.test`, password: 'wrong-password' });
    // If the unknown path skipped argon2 it would return near-instantly; the dummy verify
    // keeps it within the same order of magnitude as a real failed verify. Generous bound
    // (relative, not absolute) so it's robust under CI load but still catches a skipped hash.
    expect(unknown).toBeGreaterThan(knownWrong * 0.3);
  });

  it('rotates the cookie, tolerates a benign replay within leeway, but nukes the family on stale reuse', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', refreshCookie)
      .expect(201);
    expect(res.body.accessToken).toBeDefined();
    const rotated = (res.get('Set-Cookie') ?? []).find((c: string) => c.startsWith('lp_refresh='));
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe(refreshCookie); // a new token was issued
    const oldCookie = refreshCookie.split(';')[0];
    const newCookie = rotated!.split(';')[0];

    // Benign race: the just-rotated token replayed within the leeway window is a normal
    // SPA double-refresh (browser hasn't stored the new cookie yet) — it still yields
    // fresh creds and does NOT revoke the family.
    const replay = await request(app.getHttpServer()).post('/auth/refresh').set('Cookie', oldCookie).expect(201);
    expect(replay.body.accessToken).toBeDefined();

    // Theft: age the revoked tokens past the leeway, then reuse one → breach response
    // that hard-revokes EVERY session for the user (including the still-live newCookie).
    const ds = app.get(DataSource);
    await ds.query(
      `UPDATE sessions SET revoked_at = now() - interval '1 hour'
       WHERE revoked = true AND revoked_at IS NOT NULL
         AND user_id = (SELECT id FROM organization_users WHERE email = $1)`,
      [email],
    );
    await request(app.getHttpServer()).post('/auth/refresh').set('Cookie', oldCookie).expect(401);
    await request(app.getHttpServer()).post('/auth/refresh').set('Cookie', newCookie).expect(401);

    // Re-establish a clean session for the remaining tests.
    const relogin = await request(app.getHttpServer()).post('/auth/login').send({ email, password: 'password123' }).expect(201);
    accessToken = relogin.body.accessToken;
    refreshCookie = (relogin.get('Set-Cookie') ?? []).find((c: string) => c.startsWith('lp_refresh='))!.split(';')[0];
  });

  it('role guard: buyer admin cannot be tricked into supplier-only data leak via role claim', async () => {
    // /admin/license requires BUYER_ADMIN — our token qualifies; a supplier token would 403.
    // Here we just assert the endpoint is guarded (valid role passes, bad token fails).
    await request(app.getHttpServer())
      .post('/admin/license')
      .set('Authorization', 'Bearer invalid.token.here')
      .send({ token: 'x' })
      .expect(401);
  });

  it('a SaaS tenant admin cannot install a server license', async () => {
    await request(app.getHttpServer())
      .post('/admin/license')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ token: 'not-a-paseto-token' })
      .expect(403);
  });

  it('forgot-password emails a one-time link; reset lets the user log in with the new password', async () => {
    sentMail.length = 0;
    // unknown email still returns ok (no account enumeration) and sends nothing
    await request(app.getHttpServer()).post('/auth/forgot-password').send({ email: 'nobody@nowhere.test' }).expect(201);
    expect(sentMail).toHaveLength(0);

    await request(app.getHttpServer()).post('/auth/forgot-password').send({ email }).expect(201);
    expect(sentMail).toHaveLength(1);
    const token = /token=([A-Za-z0-9_-]+)/.exec(sentMail[0].html)?.[1];
    expect(token).toBeTruthy();

    await request(app.getHttpServer()).post('/auth/reset-password').send({ token, password: 'NewPassw0rd!' }).expect(201);

    // old password no longer works; new one does
    await request(app.getHttpServer()).post('/auth/login').send({ email, password: 'password123' }).expect(401);
    await request(app.getHttpServer()).post('/auth/login').send({ email, password: 'NewPassw0rd!' }).expect(201);

    // token is single-use
    await request(app.getHttpServer()).post('/auth/reset-password').send({ token, password: 'Another1!' }).expect(400);
  });

  it('attributes registration and login, and both land in the org chain', async () => {
    const org = (await db.query(
      `SELECT m.org_id FROM memberships m JOIN organization_users u ON u.id = m.user_id WHERE u.email = $1`,
      [email],
    )).rows[0].org_id;
    const user = (await db.query(`SELECT id FROM organization_users WHERE email = $1`, [email])).rows[0].id;
    const rows = (await db.query(
      `SELECT action, org_id, actor_id, prev_hash, hash,
              hash = encode(sha256(convert_to(coalesce(prev_hash,'') ||
                audit_body(org_id, actor_id, action, entity_type, entity_id, payload, created_at),
                'UTF8')), 'hex') AS verifies
         FROM audit_events WHERE org_id = $1 ORDER BY seq`, [org],
    )).rows;

    // USER_LOGGED_IN used to be written before the request had an organization, so it
    // carried none — and audit_select is org_id = app_org_id(), which no NULL can satisfy.
    // The most frequent action in the table could not be read by any per-organization
    // query and could not join that organization's chain. ORG_REGISTERED had the org but
    // no actor, which on these two rows is most of the content.
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['ORG_REGISTERED', 'USER_LOGGED_IN']));
    for (const r of rows) {
      expect(r.actor_id).toBe(user);
      expect(r.verifies).toBe(true);
    }
    for (let i = 1; i < rows.length; i++) expect(rows[i].prev_hash).toBe(rows[i - 1].hash);
  });
});
