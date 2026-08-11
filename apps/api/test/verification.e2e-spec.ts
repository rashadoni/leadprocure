import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';

// Supplier verification (KYC): buyer opens a case, supplier uploads a doc (cross-org),
// buyer reviews and approves → the supplier is promoted to APPROVED in the registry.
describe('supplier verification (KYC)', () => {
  let app: INestApplication;
  let db: Client;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ['Authorization', `Bearer ${t}`] as [string, string];

  let buyer: string, buyer2: string, supplier: string, supplierOrg: string;
  let caseId: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const reg = async (path: string, name: string, email: string) => {
      const r = await http().post(path).send({ legalName: name, email, password: 'password123', fullName: name }).expect(201);
      return { token: r.body.accessToken as string, org: r.body.org.id as string };
    };
    ({ token: buyer } = await reg('/auth/register/buyer', `KYC Buyer ${tag}`, `kb-${tag}@t.test`));
    ({ token: buyer2 } = await reg('/auth/register/buyer', `KYC Buyer2 ${tag}`, `kb2-${tag}@t.test`));
    ({ token: supplier, org: supplierOrg } = await reg('/auth/register/supplier', `KYC Sup ${tag}`, `ks-${tag}@t.test`));
  });

  afterAll(async () => {
    await db.query(`DELETE FROM organizations WHERE legal_name LIKE $1`, [`KYC %${tag}%`]);
    await db.end();
    await app.close();
  });

  it('buyer opens a case; supplier uploads a document', async () => {
    const c = await http().post('/verification/cases').set(...bearer(buyer)).send({ supplierOrgId: supplierOrg }).expect(201);
    caseId = c.body.id;
    expect(c.body.status).toBe('NEW');

    const pre = await http().post('/verification/presign').set(...bearer(supplier))
      .send({ filename: 'voen.pdf', mime: 'application/pdf' }).expect(201);
    const withDoc = await http().post(`/verification/cases/${caseId}/documents`).set(...bearer(supplier))
      .send({ docType: 'VOEN', storageKey: pre.body.storageKey, filename: 'voen.pdf', sha256: 'a'.repeat(64) }).expect(201);
    expect(withDoc.body.documents).toHaveLength(1);
    expect(withDoc.body.documents[0].doc_type).toBe('VOEN');
  });

  it('buyer sees the case + doc; foreign buyer does not', async () => {
    const asBuyer = await http().get(`/verification/cases/${caseId}`).set(...bearer(buyer)).expect(200);
    expect(asBuyer.body.documents).toHaveLength(1);
    // The card is headed by whose dossier this is — the drill-down used to drop both names.
    expect(asBuyer.body.supplier_name).toBeTruthy();
    expect(asBuyer.body.buyer_name).toBeTruthy();
    await http().get(`/verification/cases/${caseId}`).set(...bearer(buyer2)).expect(404);
    const list2 = await http().get('/verification/cases').set(...bearer(buyer2)).expect(200);
    expect(list2.body.map((c: any) => c.id)).not.toContain(caseId);
  });

  it('supplier cannot decide the case (buyer-only)', async () => {
    await http().post(`/verification/cases/${caseId}/decide`).set(...bearer(supplier)).send({ status: 'APPROVED' }).expect(403);
  });

  it('buyer approves → supplier becomes APPROVED in the registry', async () => {
    const decided = await http().post(`/verification/cases/${caseId}/decide`).set(...bearer(buyer)).send({ status: 'APPROVED' }).expect(201);
    expect(decided.body.status).toBe('APPROVED');
    const registry = await http().get('/suppliers').set(...bearer(buyer)).expect(200);
    const rel = registry.body.find((r: any) => r.supplier_org_id === supplierOrg);
    expect(rel.status).toBe('APPROVED');
  });
});
