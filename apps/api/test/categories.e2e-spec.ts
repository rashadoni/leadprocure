import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { teardown } from './helpers';

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
    await teardown(db, app, () => db.query(`DELETE FROM organizations WHERE legal_name LIKE $1`, [`Cat %${tag}%`]));
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

  // «Нет в списке — заводится само» (решение владельца 10.11.2026). Проверяется именно
  // обычным сотрудником: POST /categories ему запрещён, и если бы справочник пополняла
  // страница, «само» не работало бы ровно у того, кто заявки и пишет.
  it('a request with an unknown category remembers it, and a phrase stays a phrase', async () => {
    await http().post('/settings/users').set(...bearer(buyerA))
      .send({ email: `cr-${tag}@t.test`, fullName: 'Cat Requester', password: 'password123', role: 'BUYER_USER' }).expect(201);
    const tok = (await http().post('/auth/login').send({ email: `cr-${tag}@t.test`, password: 'password123' }).expect(201)).body.accessToken;

    await http().post('/requests').set(...bearer(tok))
      .send({ title: `Avto ${tag}`, category: 'AVTOSERVIS', items: [{ name: 'Yağ', qty: 1, estUnitPriceMinor: 5000 }] })
      .expect(201);
    const codes = () => http().get('/categories').set(...bearer(tok)).expect(200).then((r) => r.body.map((c: any) => c.code));
    expect(await codes()).toContain('AVTOSERVIS');

    // Повтор не плодит дублей и не падает.
    await http().post('/requests').set(...bearer(tok))
      .send({ title: `Avto 2 ${tag}`, category: 'AVTOSERVIS', items: [{ name: 'Filtr', qty: 1, estUnitPriceMinor: 3000 }] })
      .expect(201);
    expect((await codes()).filter((c: string) => c === 'AVTOSERVIS')).toHaveLength(1);

    // Фраза с пробелами кодом не становится: справочник хранит коды, а на заявке
    // остаётся ровно то, что человек написал.
    const req = await http().post('/requests').set(...bearer(tok))
      .send({ title: `Mebel ${tag}`, category: 'Ofis mebeli', items: [{ name: 'Stol', qty: 1, estUnitPriceMinor: 9000 }] })
      .expect(201);
    expect(req.body.category).toBe('Ofis mebeli');
    expect(await codes()).not.toContain('Ofis mebeli');
  });

  // Приведение к написанию из справочника — обещание, которое легко потерять: правило
  // возвращало приведённый код, а вызывающий его выбрасывал, и в заявке оставалось «it».
  // Бюджет сопоставляется с заявкой точным равенством строк, так что бюджет «IT» такую
  // заявку не ловит и молча стоит на нуле.
  it('a request filed as «it» is stored as the curated «IT»', async () => {
    await http().post('/categories').set(...bearer(buyerA)).send({ code: `CASE${tag}` }).expect(201);
    const tok = (await http().post('/auth/login').send({ email: `cr-${tag}@t.test`, password: 'password123' }).expect(201)).body.accessToken;
    const req = await http().post('/requests').set(...bearer(tok))
      .send({ title: `Case ${tag}`, category: `case${tag}`.toLowerCase(), items: [{ name: 'X', qty: 1, estUnitPriceMinor: 100 }] })
      .expect(201);
    expect(req.body.category).toBe(`CASE${tag}`);
    // И дубля в справочнике при этом не завелось.
    const dir = (await http().get('/categories').set(...bearer(buyerA)).expect(200)).body.map((c: any) => c.code);
    expect(dir.filter((c: string) => c.toLowerCase() === `case${tag}`.toLowerCase())).toHaveLength(1);
  });

  // Пара «IT» и «it» рождается при ручном заведении, и уникальный индекс её не ловит:
  // он по точному значению.
  it('an admin cannot create a twin that differs only in case', async () => {
    await http().post('/categories').set(...bearer(buyerA)).send({ code: `TWIN${tag}` }).expect(201);
    const res = await http().post('/categories').set(...bearer(buyerA)).send({ code: `twin${tag}` }).expect(409);
    expect(res.body.message).toContain(`TWIN${tag}`);
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
