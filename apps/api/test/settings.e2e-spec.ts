import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';

// Organization members: the module had no suite of its own, and all three holes below were
// reachable with ordinary clicks from the Settings page.
describe('organization members (API e2e)', () => {
  let app: INestApplication;
  let db: Client;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ['Authorization', `Bearer ${t}`] as [string, string];
  let adminA: string, adminB: string;
  const adminAEmail = `mem-a-${tag}@t.test`;
  const memberEmail = `mem-one-${tag}@t.test`;

  const reg = async (name: string, email: string) =>
    (await http().post('/auth/register/buyer')
      .send({ legalName: name, email, password: 'password123', fullName: name })
      .expect(201)).body.accessToken;

  const listUsers = async (token: string) =>
    (await http().get('/settings/users').set(...bearer(token)).expect(200)).body as any[];

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    db = new Client({ connectionString: process.env.DATABASE_OWNER_URL ?? process.env.DATABASE_URL });
    await db.connect();
    adminA = await reg(`Mem A ${tag}`, adminAEmail);
    adminB = await reg(`Mem B ${tag}`, `mem-b-${tag}@t.test`);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM organizations WHERE legal_name LIKE $1`, [`Mem %${tag}%`]);
    await db.query(`DELETE FROM organization_users WHERE email LIKE $1`, [`mem-%${tag}@t.test`]);
    await db.end();
    await app.close();
  });

  it('refuses a role that does not belong to this kind of organization', async () => {
    // The shared enum carries every role; only the web UI's own list kept SUPPLIER_USER
    // out of a buyer org, so the API accepted it and the member landed with no buyer
    // access at all and the supplier-only routes open to them.
    const refused = await http().post('/settings/users').set(...bearer(adminA))
      .send({ email: `mem-sup-${tag}@t.test`, fullName: 'Wrong Side', password: 'password123', role: 'SUPPLIER_USER' })
      .expect(400);
    expect(refused.body.message).toMatch(/BUYER organization/);
    expect(await listUsers(adminA)).toHaveLength(1);
  });

  it('adds a member once, records it, and will not give the same person a second role', async () => {
    const added = await http().post('/settings/users').set(...bearer(adminA))
      .send({ email: memberEmail, fullName: 'Member One', password: 'password123', role: 'BUYER_USER' })
      .expect(201);
    expect(added.body.filter((u: any) => u.email === memberEmail)).toHaveLength(1);

    // The dead end: a second role for the same pair was legal under the old three-column
    // key, and setRole updates EVERY membership of the pair at once — so the next role
    // change collided with that constraint and answered 500, for ever.
    const twice = await http().post('/settings/users').set(...bearer(adminA))
      .send({ email: memberEmail, fullName: 'Member One', password: 'password123', role: 'BUYER_APPROVER' })
      .expect(400);
    expect(twice.body.message).toMatch(/already a member/);

    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM memberships m JOIN organization_users u ON u.id = m.user_id
       WHERE u.email = $1`, [memberEmail],
    );
    expect(rows[0].n).toBe(1);

    // and the role control still works afterwards, which is what the dead end took away
    const userId = added.body.find((u: any) => u.email === memberEmail).id;
    await http().post(`/settings/users/${userId}/role`).set(...bearer(adminA))
      .send({ role: 'BUYER_APPROVER' }).expect(201);
    expect((await listUsers(adminA)).filter((u) => u.email === memberEmail).map((u) => u.role))
      .toEqual(['BUYER_APPROVER']);

    // granting access was the one membership change that left no trace
    const audit = await db.query(
      `SELECT payload FROM audit_events WHERE action = 'MEMBER_ADDED' AND payload->>'email' = $1`,
      [memberEmail],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].payload.role).toBe('BUYER_USER');
  });

  it('refuses the wrong-side role on an existing member too', async () => {
    const userId = (await listUsers(adminA)).find((u) => u.email === memberEmail).id;
    await http().post(`/settings/users/${userId}/role`).set(...bearer(adminA))
      .send({ role: 'SUPPLIER_USER' }).expect(400);
    expect((await listUsers(adminA)).find((u) => u.email === memberEmail).role).toBe('BUYER_APPROVER');
  });

  it('keeps the guards that were already there', async () => {
    const mine = (await listUsers(adminA)).find((u) => u.email === adminAEmail);
    await http().post(`/settings/users/${mine.id}/role`).set(...bearer(adminA))
      .send({ role: 'BUYER_USER' }).expect(403); // never your own role

    const theirs = (await listUsers(adminB))[0];
    await http().post(`/settings/users/${theirs.id}/role`).set(...bearer(adminA))
      .send({ role: 'BUYER_USER' }).expect(400); // not a member of your organization
    expect((await listUsers(adminB))[0].role).toBe('BUYER_ADMIN');
  });
});
