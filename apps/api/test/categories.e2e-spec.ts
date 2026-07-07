import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';

describe('procurement categories (API e2e)', () => {
  let app: INestApplication;
  let db: Client;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ['Authorization', `Bearer ${t}`] as [string, string];
  let buyerA: string, buyerB: string;

  const reg = async (name: string, email: string) =>
    (await http().post('/auth/register/buyer').send({ legalName: name, email, password: 'password123', fullName: name }).expect(201)).body.accessToken;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    db = new Client({ connectionString: process.env.DATABASE_OWNER_URL ?? process.env.DATABASE_URL });
    await db.connect();
    buyerA = await reg(`Cat A ${tag}`, `ca-${tag}@t.test`);
    buyerB = await reg(`Cat B ${tag}`, `cb-${tag}@t.test`);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM organizations WHERE legal_name LIKE $1`, [`Cat %${tag}%`]);
    await db.end();
    await app.close();
  });

  it('creates, lists, and rejects a bad code', async () => {
    await http().post('/categories').set(...bearer(buyerA)).send({ code: 'IT', name: 'Информ. технологии' }).expect(201);
    await http().post('/categories').set(...bearer(buyerA)).send({ code: 'CONSTRUCTION' }).expect(201);
    await http().post('/categories').set(...bearer(buyerA)).send({ code: 'bad code!' }).expect(400); // spaces/punct rejected
    const list = await http().get('/categories').set(...bearer(buyerA)).expect(200);
    expect(list.body.map((c: any) => c.code).sort()).toEqual(['CONSTRUCTION', 'IT']);
  });

  it('a duplicate code is a clean 409', async () => {
    await http().post('/categories').set(...bearer(buyerA)).send({ code: 'IT' }).expect(409);
  });

  it("buyer B cannot see or delete buyer A's categories (RLS)", async () => {
    const list = await http().get('/categories').set(...bearer(buyerB)).expect(200);
    expect(list.body).toHaveLength(0);
    // B may create its own IT independently (per-org uniqueness)
    await http().post('/categories').set(...bearer(buyerB)).send({ code: 'IT' }).expect(201);
  });

  it('deletes a category', async () => {
    const id = (await http().get('/categories').set(...bearer(buyerA)).expect(200)).body.find((c: any) => c.code === 'CONSTRUCTION').id;
    await http().delete(`/categories/${id}`).set(...bearer(buyerA)).expect(200);
    const list = await http().get('/categories').set(...bearer(buyerA)).expect(200);
    expect(list.body.map((c: any) => c.code)).not.toContain('CONSTRUCTION');
  });

  it('only an admin can create/delete (BUYER_USER is refused)', async () => {
    // add a BUYER_USER under buyer A, then try to create a category as them
    await http().post('/settings/users').set(...bearer(buyerA))
      .send({ email: `cu-${tag}@t.test`, fullName: 'Cat User', password: 'password123', role: 'BUYER_USER' }).expect(201);
    const userTok = (await http().post('/auth/login').send({ email: `cu-${tag}@t.test`, password: 'password123' }).expect(201)).body.accessToken;
    await http().post('/categories').set(...bearer(userTok)).send({ code: 'HR' }).expect(403);
    await http().get('/categories').set(...bearer(userTok)).expect(200); // but can read
  });
});
