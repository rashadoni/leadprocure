import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { teardown } from './helpers';

// Departments (cost centres): the "who spends" dimension budgets attach to. Private to
// the buyer (RLS), admin-only writes, and a department that already carries spend can be
// deactivated but not deleted.
describe('departments (API e2e)', () => {
  let app: INestApplication;
  let db: Client;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ['Authorization', `Bearer ${t}`] as [string, string];
  let buyerA: string, buyerB: string, userTok: string, userId: string;

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
    buyerA = await reg(`Dep A ${tag}`, `da-${tag}@t.test`);
    buyerB = await reg(`Dep B ${tag}`, `db-${tag}@t.test`);
    await http().post('/settings/users').set(...bearer(buyerA))
      .send({ email: `du-${tag}@t.test`, fullName: 'Dep User', password: 'password123', role: 'BUYER_USER' }).expect(201);
    userTok = (await http().post('/auth/login').send({ email: `du-${tag}@t.test`, password: 'password123' }).expect(201)).body.accessToken;
    userId = (await http().get('/settings/users').set(...bearer(buyerA)).expect(200))
      .body.find((u: any) => u.email === `du-${tag}@t.test`).id;
  });

  afterAll(async () => {
    await teardown(db, app, () => db.query(`DELETE FROM organizations WHERE legal_name LIKE $1`, [`Dep %${tag}%`]));
  });

  // The product ships in Azerbaijani; a code validator that only accepts ASCII makes the
  // natural codes unusable.
  it('accepts Azerbaijani letters in a code, still rejects spaces and punctuation', async () => {
    await http().post('/departments').set(...bearer(buyerA)).send({ code: `MƏRKƏZ-${tag}`, name: 'Baş ofis' }).expect(201);
    await http().post('/departments').set(...bearer(buyerA)).send({ code: `TƏCHİZAT-${tag}` }).expect(201);
    await http().post('/departments').set(...bearer(buyerA)).send({ code: 'iki söz' }).expect(400);
  });

  it('creates, lists and rejects a malformed code', async () => {
    await http().post('/departments').set(...bearer(buyerA)).send({ code: 'IT', name: 'IT department' }).expect(201);
    await http().post('/departments').set(...bearer(buyerA)).send({ code: 'HR' }).expect(201);
    await http().post('/departments').set(...bearer(buyerA)).send({ code: 'bad code!' }).expect(400);
    const list = await http().get('/departments').set(...bearer(buyerA)).expect(200);
    expect(list.body.map((d: any) => d.code)).toEqual(expect.arrayContaining(['HR', 'IT']));
  });

  it('a duplicate code is a clean 409, not a 500', async () => {
    await http().post('/departments').set(...bearer(buyerA)).send({ code: 'IT' }).expect(409);
  });

  it('supports a parent → child tree and refuses a self-parent', async () => {
    const it = (await http().get('/departments').set(...bearer(buyerA))).body.find((d: any) => d.code === 'IT');
    const child = await http().post('/departments').set(...bearer(buyerA))
      .send({ code: 'IT-INFRA', parentId: it.id }).expect(201);
    expect(child.body.parent_code).toBe('IT');
    await http().put(`/departments/${child.body.id}`).set(...bearer(buyerA))
      .send({ code: 'IT-INFRA', parentId: child.body.id }).expect(409);
  });

  it("buyer B cannot see buyer A's departments and may reuse the same code (RLS)", async () => {
    const list = await http().get('/departments').set(...bearer(buyerB)).expect(200);
    expect(list.body).toHaveLength(0);
    await http().post('/departments').set(...bearer(buyerB)).send({ code: 'IT' }).expect(201);
  });

  it('only an admin writes; a BUYER_USER may read', async () => {
    await http().post('/departments').set(...bearer(userTok)).send({ code: 'LEGAL' }).expect(403);
    await http().get('/departments').set(...bearer(userTok)).expect(200);
  });

  it('a request stores its department and reports the code', async () => {
    const hr = (await http().get('/departments').set(...bearer(buyerA))).body.find((d: any) => d.code === 'HR');
    const req = await http().post('/requests').set(...bearer(buyerA))
      .send({ title: `Dep req ${tag}`, category: 'IT', departmentId: hr.id, items: [{ name: 'x', qty: 1, estUnitPriceMinor: 1000 }] })
      .expect(201);
    expect(req.body.department_id).toBe(hr.id);
    expect(req.body.department_code).toBe('HR');
    const list = await http().get('/requests').set(...bearer(buyerA)).expect(200);
    expect(list.body.items.find((r: any) => r.id === req.body.id).department_code).toBe('HR');
    const filtered = await http().get(`/requests?departmentId=${hr.id}`).set(...bearer(buyerA)).expect(200);
    expect(filtered.body.items.every((r: any) => r.department_id === hr.id)).toBe(true);
  });

  it("a cross-org department id on a request is refused, not silently stored", async () => {
    const foreign = (await http().get('/departments').set(...bearer(buyerB))).body[0];
    await http().post('/requests').set(...bearer(buyerA))
      .send({ title: `Cross ${tag}`, departmentId: foreign.id, items: [{ name: 'x', qty: 1, estUnitPriceMinor: 100 }] })
      .expect(400);
  });

  it("a member's home department becomes the default on their requests", async () => {
    const it = (await http().get('/departments').set(...bearer(buyerA))).body.find((d: any) => d.code === 'IT');
    await http().post(`/settings/users/${userId}/department`).set(...bearer(buyerA))
      .send({ departmentId: it.id }).expect(201);
    const req = await http().post('/requests').set(...bearer(userTok))
      .send({ title: `Home dep ${tag}`, items: [{ name: 'x', qty: 1, estUnitPriceMinor: 500 }] })
      .expect(201);
    expect(req.body.department_code).toBe('IT');
  });

  it('a department in use cannot be deleted (409); an unused one can', async () => {
    const list = (await http().get('/departments').set(...bearer(buyerA))).body;
    const hr = list.find((d: any) => d.code === 'HR');
    expect(hr.usage_count).toBeGreaterThan(0);
    await http().delete(`/departments/${hr.id}`).set(...bearer(buyerA)).expect(409);

    const spare = await http().post('/departments').set(...bearer(buyerA)).send({ code: `TMP-${tag}` }).expect(201);
    await http().delete(`/departments/${spare.body.id}`).set(...bearer(buyerA)).expect(200);
  });

  it('deactivating retires a department: it can no longer be picked for new spend', async () => {
    const hr = (await http().get('/departments').set(...bearer(buyerA))).body.find((d: any) => d.code === 'HR');
    await http().put(`/departments/${hr.id}`).set(...bearer(buyerA)).send({ code: 'HR', isActive: false }).expect(200);
    await http().post('/requests').set(...bearer(buyerA))
      .send({ title: `Inactive ${tag}`, departmentId: hr.id, items: [{ name: 'x', qty: 1, estUnitPriceMinor: 100 }] })
      .expect(400);
  });

  // ---------- who may be named owner ----------
  //
  // The owner is not a label: a budget warning is addressed to this person alone
  // (`departments.owner_user_id` → notify.notifyUser), so the column has to hold somebody
  // who can act on it. The picker stopped offering outsiders and deactivated people, but a
  // picker is not a check — the id travels in the request body, and the endpoint took
  // anything shaped like a uuid.
  describe('the owner must be someone who can receive the warning', () => {
    let ownerId: string;

    beforeAll(async () => {
      // A member who never signs in: `/auth/login` is throttled to 10/min and this block
      // has no reason to spend one.
      const users = await http().post('/settings/users').set(...bearer(buyerA))
        .send({ email: `own-${tag}@t.test`, fullName: 'Dep Owner', password: 'password123', role: 'BUYER_USER' })
        .expect(201);
      ownerId = users.body.find((u: any) => u.email === `own-${tag}@t.test`).id;
    });

    it('accepts an active member and reports them on the row', async () => {
      const dep = await http().post('/departments').set(...bearer(buyerA))
        .send({ code: `OWNED-${tag}`, ownerUserId: ownerId }).expect(201);
      expect(dep.body.owner_user_id).toBe(ownerId);
      expect(dep.body.owner_name).toBe('Dep Owner');
      expect(dep.body.owner_status).toBe('ACTIVE');
    });

    it("refuses another organisation's user, on create and on update", async () => {
      const foreign = (await http().get('/settings/users').set(...bearer(buyerB)).expect(200)).body[0].id;
      const refused = await http().post('/departments').set(...bearer(buyerA))
        .send({ code: `FOREIGN-${tag}`, ownerUserId: foreign }).expect(400);
      expect(refused.body.message).toMatch(/member of your organization/i);
      // The refusal is the whole write: no half-made department is left behind.
      expect((await http().get('/departments').set(...bearer(buyerA))).body
        .some((d: any) => d.code === `FOREIGN-${tag}`)).toBe(false);

      const dep = (await http().get('/departments').set(...bearer(buyerA))).body
        .find((d: any) => d.code === `OWNED-${tag}`);
      await http().put(`/departments/${dep.id}`).set(...bearer(buyerA))
        .send({ code: dep.code, ownerUserId: foreign }).expect(400);
      expect((await http().get('/departments').set(...bearer(buyerA))).body
        .find((d: any) => d.code === `OWNED-${tag}`).owner_user_id).toBe(ownerId);
    });

    it('refuses a deactivated member as a NEW owner', async () => {
      await db.query(`UPDATE organization_users SET status='SUSPENDED' WHERE id=$1`, [ownerId]);
      const refused = await http().post('/departments').set(...bearer(buyerA))
        .send({ code: `OFF-${tag}`, ownerUserId: ownerId }).expect(400);
      expect(refused.body.message).toMatch(/deactivated/i);
    });

    // The decision this block exists to pin down. A person is switched off long after they
    // were named, and the department legitimately goes on pointing at them: the screen shows
    // the name marked «(deaktiv)» (owner_status), and the warning itself is widened to the
    // organisation by NotifyService, which records the widening. Refusing the unchanged value
    // instead would make renaming or retiring that department impossible until somebody also
    // picked a new owner — and `PUT /departments/:id` replaces the whole row, so EVERY edit
    // resends the owner as it stands. A rule that blocks unrelated edits is a rule that gets
    // worked around, not obeyed.
    it('keeps an owner who was deactivated after being named, and still allows other edits', async () => {
      const dep = (await http().get('/departments').set(...bearer(buyerA))).body
        .find((d: any) => d.code === `OWNED-${tag}`);
      expect(dep.owner_status).toBe('SUSPENDED'); // the screen can say so
      const renamed = await http().put(`/departments/${dep.id}`).set(...bearer(buyerA))
        .send({ code: dep.code, name: 'Renamed while owner is off', ownerUserId: ownerId, isActive: false })
        .expect(200);
      expect(renamed.body.owner_user_id).toBe(ownerId);
      expect(renamed.body.name).toBe('Renamed while owner is off');
      expect(renamed.body.is_active).toBe(false);
    });

    // The read side of the same promise. The check above closes the door, but rows written
    // before it existed — or straight in SQL — can still point outside the organisation, and
    // `organization_users` has no RLS of its own: the owner subqueries used to answer with a
    // stranger's name and state to anyone who can open the settings page.
    it("does not report the name or state of an owner outside the organisation", async () => {
      const foreign = (await http().get('/settings/users').set(...bearer(buyerB)).expect(200)).body[0];
      const dep = (await http().get('/departments').set(...bearer(buyerA))).body
        .find((d: any) => d.code === `OWNED-${tag}`);
      await db.query(`UPDATE departments SET owner_user_id=$2 WHERE id=$1`, [dep.id, foreign.id]);
      const row = (await http().get('/departments').set(...bearer(buyerA)).expect(200)).body
        .find((d: any) => d.code === `OWNED-${tag}`);
      // The id is still there — it is the buyer's own column and the screen needs to show
      // that the row points somewhere — but nothing about the person is disclosed.
      expect(row.owner_user_id).toBe(foreign.id);
      expect(row.owner_name).toBeNull();
      expect(row.owner_status).toBeNull();
      // back to the owner the rest of this block is about
      await db.query(`UPDATE departments SET owner_user_id=$2 WHERE id=$1`, [dep.id, ownerId]);
    });

    it('clearing the owner is always allowed', async () => {
      const dep = (await http().get('/departments').set(...bearer(buyerA))).body
        .find((d: any) => d.code === `OWNED-${tag}`);
      const cleared = await http().put(`/departments/${dep.id}`).set(...bearer(buyerA))
        .send({ code: dep.code, isActive: false }).expect(200);
      expect(cleared.body.owner_user_id).toBeNull();
      // …and once cleared, the deactivated person cannot be put back.
      await http().put(`/departments/${dep.id}`).set(...bearer(buyerA))
        .send({ code: dep.code, ownerUserId: ownerId, isActive: false }).expect(400);
    });
  });
});
