import { INestApplication } from '@nestjs/common';
import request from 'supertest';

// Segregation of duties: a request's creator can't approve it. Specs register a buyer
// (admin = creator) and use this to add a separate BUYER_APPROVER who does the approvals.
export async function addApprover(app: INestApplication, buyerToken: string, tag: string): Promise<string> {
  const http = () => request(app.getHttpServer());
  const email = `apprv-${tag}@t.test`;
  await http().post('/settings/users').set('Authorization', `Bearer ${buyerToken}`)
    .send({ email, fullName: 'Approver', password: 'password123', role: 'BUYER_APPROVER' }).expect(201);
  const r = await http().post('/auth/login').send({ email, password: 'password123' }).expect(201);
  return r.body.accessToken as string;
}
