import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';

// Multi-step approval: a large request needs approver → admin; each step is role-gated
// and the request is only APPROVED once every step has approved.
describe('multi-step approval workflow', () => {
  let app: INestApplication;
  let db: Client;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ['Authorization', `Bearer ${t}`] as [string, string];

  let admin: string, approver: string, requester: string, reqId: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();

    const reg = await http().post('/auth/register/buyer')
      .send({ legalName: `Appr Buyer ${tag}`, email: `appr-${tag}@t.test`, password: 'password123', fullName: 'Admin' }).expect(201);
    admin = reg.body.accessToken;

    // admin adds a BUYER_APPROVER, then that user logs in
    await http().post('/settings/users').set(...bearer(admin))
      .send({ email: `apprv-${tag}@t.test`, fullName: 'Approver', password: 'password123', role: 'BUYER_APPROVER' }).expect(201);
    const login = await http().post('/auth/login').send({ email: `apprv-${tag}@t.test`, password: 'password123' }).expect(201);
    approver = login.body.accessToken;

    // a plain BUYER_USER raises the request — so the approver (step 1) and admin (step 2)
    // are both someone OTHER than the creator (segregation of duties).
    await http().post('/settings/users').set(...bearer(admin))
      .send({ email: `req-${tag}@t.test`, fullName: 'Requester', password: 'password123', role: 'BUYER_USER' }).expect(201);
    const rlogin = await http().post('/auth/login').send({ email: `req-${tag}@t.test`, password: 'password123' }).expect(201);
    requester = rlogin.body.accessToken;

    // 2-step chain for large amounts
    await http().put('/requests/approval-policies').set(...bearer(admin)).send({
      policies: [
        { minAmountMinor: 0, maxAmountMinor: 5_000_000, steps: [{ order: 1, role: 'BUYER_APPROVER' }] },
        { minAmountMinor: 5_000_000, maxAmountMinor: null, steps: [{ order: 1, role: 'BUYER_APPROVER' }, { order: 2, role: 'BUYER_ADMIN' }] },
      ],
    }).expect(200);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM organizations WHERE legal_name LIKE $1`, [`Appr %${tag}%`]);
    await db.end();
    await app.close();
  });

  it('a large request materializes a 2-step chain on submit', async () => {
    const r = await http().post('/requests').set(...bearer(requester))
      .send({ title: `Big ${tag}`, items: [{ name: 'Machine', qty: 1, estUnitPriceMinor: 6_000_000 }] }).expect(201);
    reqId = r.body.id;
    const submitted = await http().post(`/requests/${reqId}/submit`).set(...bearer(requester)).expect(201);
    expect(submitted.body.approvals).toHaveLength(2);
    expect(submitted.body.approvals.map((a: any) => a.approver_role)).toEqual(['BUYER_APPROVER', 'BUYER_ADMIN']);
  });

  it('step 1 (approver) keeps the request SUBMITTED', async () => {
    const res = await http().post(`/requests/${reqId}/approve`).set(...bearer(approver)).expect(201);
    expect(res.body.status).toBe('SUBMITTED');
    expect(res.body.approvals[0].status).toBe('APPROVED');
    expect(res.body.approvals[1].status).toBe('SUBMITTED');
  });

  it('the approver cannot perform step 2 (needs admin)', async () => {
    await http().post(`/requests/${reqId}/approve`).set(...bearer(approver)).expect(400);
  });

  it('step 2 (admin) finalizes the request to APPROVED', async () => {
    const res = await http().post(`/requests/${reqId}/approve`).set(...bearer(admin)).expect(201);
    expect(res.body.status).toBe('APPROVED');
    expect(res.body.approvals.every((a: any) => a.status === 'APPROVED')).toBe(true);
    expect(res.body.method_resolved).toBeDefined();
  });

  it('the same person cannot clear two steps of one request (segregation of duties)', async () => {
    // a second admin, so step 2 can be completed by someone OTHER than whoever did step 1
    await http().post('/settings/users').set(...bearer(admin))
      .send({ email: `admin2-${tag}@t.test`, fullName: 'Admin2', password: 'password123', role: 'BUYER_ADMIN' }).expect(201);
    const admin2 = (await http().post('/auth/login').send({ email: `admin2-${tag}@t.test`, password: 'password123' }).expect(201)).body.accessToken;

    const r = await http().post('/requests').set(...bearer(requester))
      .send({ title: `SoD chain ${tag}`, items: [{ name: 'M', qty: 1, estUnitPriceMinor: 6_000_000 }] }).expect(201);
    await http().post(`/requests/${r.body.id}/submit`).set(...bearer(requester)).expect(201);
    // admin clears step 1 (BUYER_ADMIN satisfies the BUYER_APPROVER role) …
    const s1 = await http().post(`/requests/${r.body.id}/approve`).set(...bearer(admin)).expect(201);
    expect(s1.body.status).toBe('SUBMITTED');
    // … but is blocked from also clearing step 2 of the same request
    await http().post(`/requests/${r.body.id}/approve`).set(...bearer(admin)).expect(403);
    // a different admin can
    const s2 = await http().post(`/requests/${r.body.id}/approve`).set(...bearer(admin2)).expect(201);
    expect(s2.body.status).toBe('APPROVED');
  });
});
