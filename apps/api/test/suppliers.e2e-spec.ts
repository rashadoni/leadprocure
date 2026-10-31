import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';

// Supplier scorecards are not a note: reliability carries 30% of the weighted total the
// award recommendation ranks by (SCORING_WEIGHTS in common/ai/ai-scorer.ts). Nothing here
// had a suite of its own.
describe('supplier scorecards (API e2e)', () => {
  let app: INestApplication;
  let db: Client;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ['Authorization', `Bearer ${t}`] as [string, string];
  let adminTok: string, userTok: string;
  let buyerOrgId: string, supplierOrgId: string, foreignPoId: string;
  const plainUserEmail = `sup-user-${tag}@t.test`;

  const orgIdOf = async (name: string) =>
    (await db.query(`SELECT id FROM organizations WHERE legal_name = $1`, [name])).rows[0].id;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    db = new Client({ connectionString: process.env.DATABASE_OWNER_URL ?? process.env.DATABASE_URL });
    await db.connect();

    adminTok = (await http().post('/auth/register/buyer')
      .send({ legalName: `Sup Buyer ${tag}`, email: `sup-admin-${tag}@t.test`, password: 'password123', fullName: 'Admin' })
      .expect(201)).body.accessToken;
    await http().post('/auth/register/supplier')
      .send({ legalName: `Sup Seller ${tag}`, email: `sup-seller-${tag}@t.test`, password: 'password123', fullName: 'Seller' })
      .expect(201);
    buyerOrgId = await orgIdOf(`Sup Buyer ${tag}`);
    supplierOrgId = await orgIdOf(`Sup Seller ${tag}`);

    // a plain member of the same buyer organization
    await http().post('/settings/users').set(...bearer(adminTok))
      .send({ email: plainUserEmail, fullName: 'Plain User', password: 'password123', role: 'BUYER_USER' })
      .expect(201);
    userTok = (await http().post('/auth/login')
      .send({ email: plainUserEmail, password: 'password123' }).expect(201)).body.accessToken;

    // A REAL order with this supplier, belonging to a different buyer. Foreign keys are
    // not subject to RLS, so before the check this id was accepted and handed straight
    // back out of GET /scorecard — a random uuid would only have proved the FK still bites.
    await http().post('/auth/register/buyer')
      .send({ legalName: `Sup Other ${tag}`, email: `sup-other-${tag}@t.test`, password: 'password123', fullName: 'Other' })
      .expect(201);
    const otherOrgId = await orgIdOf(`Sup Other ${tag}`);
    const otherUser = (await db.query(
      `SELECT id FROM organization_users WHERE email = $1`, [`sup-other-${tag}@t.test`],
    )).rows[0].id;
    foreignPoId = (await db.query(
      `INSERT INTO purchase_orders(buyer_org_id, supplier_org_id, po_no, total_minor, currency, created_by)
       VALUES ($1,$2,$3,0,'AZN',$4) RETURNING id`,
      [otherOrgId, supplierOrgId, `PO-OTHER-${tag}`, otherUser],
    )).rows[0].id;
  });

  afterAll(async () => {
    await db.query(`DELETE FROM organizations WHERE legal_name LIKE $1`, [`Sup %${tag}%`]);
    await db.query(`DELETE FROM organization_users WHERE email LIKE $1`, [`sup-%${tag}@t.test`]);
    await db.end();
    await app.close();
  });

  it('a plain member cannot move the ranking a rating feeds', async () => {
    // Someone who may not approve a request, invite a supplier or block one may not move
    // 30% of the award recommendation's weight either.
    const refused = await http().post(`/suppliers/${supplierOrgId}/scorecard`).set(...bearer(userTok))
      .send({ metric: 'OTIF', score: 100 }).expect(403);
    // pin WHICH guard answered: the roles guard runs before the licence one
    expect(refused.body.message).toMatch(/Insufficient role/);
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM supplier_scorecard_entries WHERE supplier_org_id = $1`,
      [supplierOrgId],
    );
    expect(rows[0].n).toBe(0);
  });

  it('an approver rates a supplier, and it is recorded', async () => {
    const res = await http().post(`/suppliers/${supplierOrgId}/scorecard`).set(...bearer(adminTok))
      .send({ metric: 'OTIF', score: 80, note: 'on time' }).expect(201);
    expect(res.body.averages).toEqual([{ metric: 'OTIF', avg_score: 80, n: 1 }]);

    const audit = await db.query(
      `SELECT payload FROM audit_events WHERE action = 'SCORECARD_ENTRY_ADDED'
         AND payload->>'supplier_org_id' = $1`,
      [supplierOrgId],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('refuses a rating aimed at something that is not a supplier', async () => {
    // The target was never checked, so an entry could be hung on any uuid — a buyer
    // organization included — and still be averaged into the reliability index.
    await http().post(`/suppliers/${buyerOrgId}/scorecard`).set(...bearer(adminTok))
      .send({ metric: 'QUALITY', score: 10 }).expect(404);
  });

  it('refuses a rating that cites an order which is not yours with this supplier', async () => {
    await http().post(`/suppliers/${supplierOrgId}/scorecard`).set(...bearer(adminTok))
      .send({ metric: 'COMMS', score: 50, sourcePoId: foreignPoId }).expect(400);
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM supplier_scorecard_entries WHERE supplier_org_id = $1`,
      [supplierOrgId],
    );
    expect(rows[0].n).toBe(1); // only the approver's rating above survived
  });

  it('leaves reading alone for a plain member of the buyer organization', async () => {
    // Deliberately only about the buyer side. The GET carries no @Roles at all, and
    // sce_select also admits the rated supplier, so a supplier can read its buyers' free
    // text notes about it — pre-existing, a separate decision, and not something this
    // test should be read as blessing.
    const asUser = await http().get(`/suppliers/${supplierOrgId}/scorecard`).set(...bearer(userTok)).expect(200);
    expect(asUser.body.averages).toEqual([{ metric: 'OTIF', avg_score: 80, n: 1 }]);
  });
});
