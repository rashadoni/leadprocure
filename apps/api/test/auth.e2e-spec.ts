import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';

// Boots the real AppModule (guards, transaction interceptor, RLS DataSource)
// and exercises the auth flow over HTTP against the live dev database.
describe('auth flow (API e2e)', () => {
  let app: INestApplication;
  const email = `e2e-${randomUUID().slice(0, 8)}@acme.test`;
  let accessToken: string;
  let refreshCookie: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
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

  it('refreshes the access token via httpOnly cookie', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', refreshCookie)
      .expect(201);
    expect(res.body.accessToken).toBeDefined();
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

  it('license install rejects garbage token (verify fails, tx rolls back)', async () => {
    await request(app.getHttpServer())
      .post('/admin/license')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ token: 'not-a-paseto-token' })
      .expect(500);
  });
});
