import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';

// Sending channels (own SMTP / WhatsApp). A blank secret means "keep the stored one" so the
// UI never has to re-type it — which has to stop at the FIRST connect, where there is
// nothing stored: saving '' produced a row that reads as connected and fails every send.
describe('channels (API e2e)', () => {
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
    db = new Client({ connectionString: process.env.DATABASE_OWNER_URL ?? process.env.DATABASE_URL });
    await db.connect();
    buyer = (
      await http().post('/auth/register/buyer')
        .send({ legalName: `Chan ${tag}`, email: `ch-${tag}@t.test`, password: 'password123', fullName: 'Chan' })
        .expect(201)
    ).body.accessToken;
  });

  afterAll(async () => {
    await db.query(`DELETE FROM organizations WHERE legal_name LIKE $1`, [`Chan %${tag}%`]);
    await db.end();
    await app.close();
  });

  it('refuses a first connect with no secret instead of storing an empty one', async () => {
    const res = await http().put('/channels/EMAIL').set(...bearer(buyer))
      .send({ host: 'smtp.example.test', port: 587, user: 'noreply@example.test', from: 'noreply@example.test' })
      .expect(400);
    expect(String(res.body.message)).toContain('password');

    // nothing was written: the channel must not read as connected
    const list = (await http().get('/channels').set(...bearer(buyer)).expect(200)).body;
    const email = list.find((c: any) => c.channel === 'EMAIL');
    expect(email?.connected ?? false).toBe(false);
  });

  it('accepts the secret once, and a later save may omit it to keep the stored one', async () => {
    await http().put('/channels/EMAIL').set(...bearer(buyer))
      .send({ host: 'smtp.example.test', port: 587, user: 'noreply@example.test', from: 'noreply@example.test', password: 's3cret' })
      .expect(200);
    const after = (await http().get('/channels').set(...bearer(buyer)).expect(200)).body
      .find((c: any) => c.channel === 'EMAIL');
    expect(after.connected).toBe(true);
    expect(after.config.has_password).toBe(true);

    // second save without the password keeps the stored one rather than blanking it
    await http().put('/channels/EMAIL').set(...bearer(buyer))
      .send({ host: 'smtp2.example.test', port: 587, user: 'noreply@example.test', from: 'noreply@example.test' })
      .expect(200);
    const kept = (await http().get('/channels').set(...bearer(buyer)).expect(200)).body
      .find((c: any) => c.channel === 'EMAIL');
    expect(kept.config.has_password).toBe(true);
    expect(kept.config.host).toBe('smtp2.example.test');
  });
});
