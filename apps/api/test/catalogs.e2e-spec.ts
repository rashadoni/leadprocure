import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';

// Catalogs: buyer keeps agreed prices, re-orders instantly (→ PO), MOQ enforced,
// cross-org visible to the supplier, isolated from other buyers.
describe('catalogs + instant re-order', () => {
  let app: INestApplication;
  let db: Client;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ['Authorization', `Bearer ${t}`] as [string, string];

  let buyer: string, buyer2: string, supplier: string, supplierOrg: string;
  let catalogId: string, itemId: string;

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
    ({ token: buyer } = await reg('/auth/register/buyer', `Cat Buyer ${tag}`, `cb-${tag}@t.test`));
    ({ token: buyer2 } = await reg('/auth/register/buyer', `Cat Buyer2 ${tag}`, `cb2-${tag}@t.test`));
    ({ token: supplier, org: supplierOrg } = await reg('/auth/register/supplier', `Cat Sup ${tag}`, `cs-${tag}@t.test`));
  });

  afterAll(async () => {
    await db.query(`DELETE FROM organizations WHERE legal_name LIKE $1`, [`Cat %${tag}%`]);
    await db.end();
    await app.close();
  });

  it('buyer creates a catalog with a MOQ item and activates it', async () => {
    const cat = await http().post('/catalogs').set(...bearer(buyer))
      .send({ supplierOrgId: supplierOrg, title: `Office ${tag}` }).expect(201);
    catalogId = cat.body.id;
    const withItem = await http().post(`/catalogs/${catalogId}/items`).set(...bearer(buyer))
      .send({ name: 'A4 paper', uom: 'box', unitPriceMinor: 50_000, moq: 10 }).expect(201);
    itemId = withItem.body.items[0].id;
    const active = await http().post(`/catalogs/${catalogId}/activate`).set(...bearer(buyer)).expect(201);
    expect(active.body.status).toBe('ACTIVE');
  });

  it('an order below MOQ is rejected; at/above MOQ creates a PO', async () => {
    await http().post(`/catalogs/${catalogId}/order`).set(...bearer(buyer))
      .send({ items: [{ catalogItemId: itemId, qty: 5 }] }).expect(400); // below MOQ 10
    const po = await http().post(`/catalogs/${catalogId}/order`).set(...bearer(buyer))
      .send({ items: [{ catalogItemId: itemId, qty: 10 }] }).expect(201);
    expect(Number(po.body.total_minor)).toBe(500_000); // 10 × 50k
    // the PO reached the supplier
    const supOrders = await http().get('/orders').set(...bearer(supplier)).expect(200);
    expect(supOrders.body.map((p: any) => p.id)).toContain(po.body.id);
  });

  it('supplier can read the catalog; a different buyer cannot', async () => {
    const asSupplier = await http().get('/catalogs').set(...bearer(supplier)).expect(200);
    expect(asSupplier.body.map((c: any) => c.id)).toContain(catalogId);
    const asBuyer2 = await http().get('/catalogs').set(...bearer(buyer2)).expect(200);
    expect(asBuyer2.body.map((c: any) => c.id)).not.toContain(catalogId);
    await http().get(`/catalogs/${catalogId}`).set(...bearer(buyer2)).expect(404);
  });

  it('a supplier cannot create or modify a catalog', async () => {
    await http().post('/catalogs').set(...bearer(supplier)).send({ supplierOrgId: supplierOrg, title: 'x' }).expect(403);
  });
});
