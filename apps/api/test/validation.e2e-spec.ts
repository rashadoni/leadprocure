import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';

// Defense-in-depth: the request DTOs (class-validator) reject malformed input at the edge
// with 400 before any handler/service runs. Proves money must be a non-negative integer,
// enums/UUIDs are checked, required fields are enforced, nested arrays validate per-item,
// and unknown keys are stripped (whitelist) rather than trusted.
describe('input validation (API e2e)', () => {
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
      .send({ legalName: `Val Buyer ${tag}`, email: `val-${tag}@t.test`, password: 'password123', fullName: `Val ${tag}` })
      .expect(201);
    buyer = r.body.accessToken;
  });

  afterAll(async () => {
    await db.query(`DELETE FROM organizations WHERE legal_name LIKE $1`, [`Val %${tag}%`]);
    await db.end();
    await app.close();
  });

  const okItem = { name: 'Widget', qty: 2, estUnitPriceMinor: 100 };

  it('rejects a request with a missing title', async () => {
    await http().post('/requests').set(...bearer(buyer)).send({ items: [okItem] }).expect(400);
  });

  it('rejects a non-integer (float) quantity in a nested item', async () => {
    await http().post('/requests').set(...bearer(buyer))
      .send({ title: `Bad qty ${tag}`, items: [{ ...okItem, qty: 1.5 }] }).expect(400);
  });

  it('rejects negative money (estUnitPriceMinor) in a nested item', async () => {
    await http().post('/requests').set(...bearer(buyer))
      .send({ title: `Bad money ${tag}`, items: [{ ...okItem, estUnitPriceMinor: -5 }] }).expect(400);
  });

  it('rejects money sent as a string (type is enforced, not coerced)', async () => {
    await http().post('/requests').set(...bearer(buyer))
      .send({ title: `String money ${tag}`, items: [{ ...okItem, estUnitPriceMinor: '100' }] }).expect(400);
  });

  it('rejects an invalid vatMode enum', async () => {
    await http().post('/requests').set(...bearer(buyer))
      .send({ title: `Bad vat ${tag}`, vatMode: 'MAYBE', items: [okItem] }).expect(400);
  });

  it('rejects items that is not an array', async () => {
    await http().post('/requests').set(...bearer(buyer))
      .send({ title: `Bad items ${tag}`, items: 'nope' }).expect(400);
  });

  it('rejects a non-UUID supplierOrgId (opening a verification case)', async () => {
    await http().post('/verification/cases').set(...bearer(buyer))
      .send({ supplierOrgId: 'not-a-uuid' }).expect(400);
  });

  it('accepts a valid request and strips unknown keys (whitelist)', async () => {
    const res = await http().post('/requests').set(...bearer(buyer))
      .send({ title: `Good ${tag}`, injected: 'DROP TABLE', items: [{ ...okItem, hacker: true }] })
      .expect(201);
    // the stripped keys never reach the persisted row
    expect(res.body.injected).toBeUndefined();
    expect(res.body.title).toBe(`Good ${tag}`);
  });
});
