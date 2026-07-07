import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { addApprover } from './helpers';
import { MailProvider, Mail } from '../src/common/mail/mail.module';

// Email loop: in-app notifications fan out to the recipient org's ACTIVE users by email,
// AFTER the transaction commits. Failed actions send nothing; the body is built from a
// whitelist so amounts can never leak into outbound mail.
describe('email notifications (API e2e)', () => {
  let app: INestApplication;
  let db: Client;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ['Authorization', `Bearer ${t}`] as [string, string];
  const sent: Mail[] = [];
  let buyer: string, supplier: string, supplierOrg: string;
  let approver: string;
  let poId: string, poItemId: string;

  const waitForMail = async (pred: (m: Mail) => boolean, ms = 3000): Promise<Mail | undefined> => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const hit = sent.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 50));
    }
    return undefined;
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailProvider)
      .useValue({ kind: 'test', send: async (m: Mail) => { sent.push(m); } })
      .compile();
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
    ({ token: buyer } = await reg('/auth/register/buyer', `Ml Buyer ${tag}`, `mb-${tag}@t.test`));
    approver = await addApprover(app, buyer, tag);
    ({ token: supplier, org: supplierOrg } = await reg('/auth/register/supplier', `Ml Sup ${tag}`, `ms-${tag}@t.test`));

    await http().post(`/suppliers/${supplierOrg}/invite`).set(...bearer(buyer)).expect(201);
    const reg2 = await http().get('/suppliers').set(...bearer(buyer)).expect(200);
    const relId = reg2.body.find((r: any) => r.supplier_org_id === supplierOrg).id;
    await http().post(`/suppliers/relationships/${relId}/status`).set(...bearer(buyer)).send({ status: 'APPROVED' }).expect(201);
    await http().put('/requests/method-policies').set(...bearer(buyer))
      .send({ policies: [{ category: '*', minAmountMinor: 0, maxAmountMinor: null, method: 'DIRECT' }] }).expect(200);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM organizations WHERE legal_name LIKE $1`, [`Ml %${tag}%`]);
    await db.end();
    await app.close();
  });

  it('a direct order emails the supplier org users (post-commit fan-out)', async () => {
    const req = await http().post('/requests').set(...bearer(buyer))
      .send({ title: `Ml req ${tag}`, items: [{ name: 'Cable', qty: 4, estUnitPriceMinor: 700_00 }] }).expect(201);
    await http().post(`/requests/${req.body.id}/submit`).set(...bearer(buyer)).expect(201);
    await http().post(`/requests/${req.body.id}/approve`).set(...bearer(approver)).expect(201);
    const po = await http().post(`/orders/direct/from-request/${req.body.id}`).set(...bearer(buyer))
      .send({ supplierOrgId: supplierOrg }).expect(201);
    poId = po.body.id;
    poItemId = po.body.items[0].id;

    const mail = await waitForMail((m) => m.to === `ms-${tag}@t.test` && m.subject.includes('Новый заказ'));
    expect(mail).toBeTruthy();
    expect(mail!.text).toContain(po.body.po_no); // whitelisted field
    // in-app row exists too
    const notes = await http().get('/notifications').set(...bearer(supplier)).expect(200);
    expect(notes.body.some((n: any) => n.type === 'DIRECT_ORDER_CREATED')).toBe(true);
  });

  it('the buyer org gets NO email about the supplier-directed notification', async () => {
    expect(sent.some((m) => m.to === `mb-${tag}@t.test` && m.subject.includes('Новый заказ'))).toBe(false);
  });

  it('a failed action sends no email', async () => {
    const before = sent.length;
    // amendment on a DRAFT-status PO is rejected by guards → no notify, no mail
    await http().post(`/orders/${poId}/amendments`).set(...bearer(buyer))
      .send({ reason: 'x', items: [{ poItemId, qty: 0 }] }).expect(400);
    await new Promise((r) => setTimeout(r, 300));
    expect(sent.length).toBe(before);
  });

  it('amendment email carries po_no but never amounts (whitelist)', async () => {
    await http().post(`/orders/${poId}/status`).set(...bearer(buyer)).send({ status: 'ISSUED' }).expect(201);
    await http().post(`/orders/${poId}/amendments`).set(...bearer(buyer))
      .send({ reason: 'more units', items: [{ poItemId, qty: 9 }] }).expect(201);
    const mail = await waitForMail((m) => m.to === `ms-${tag}@t.test` && m.subject.includes('изменение заказа'));
    expect(mail).toBeTruthy();
    // amounts (old/new totals in minor units) must not appear in the body
    expect(mail!.text).not.toContain('280000'); // 4 × 700_00
    expect(mail!.text).not.toContain('630000'); // 9 × 700_00
    expect(mail!.text).not.toContain('total');
  });
});
