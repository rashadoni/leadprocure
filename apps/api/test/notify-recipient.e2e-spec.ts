import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { addApprover, teardown } from './helpers';
import { MailProvider, Mail } from '../src/common/mail/mail.module';

// An ADDRESSED notification must never be narrower than nobody.
//
// A budget warning is addressed to one person on purpose — the head of the department that
// owns the plan (`departments.owner_user_id`), because an alarm mailed to forty people is
// one nobody acts on. The fallback for "nobody is named" was always the whole organisation.
// The fallback for "the named person cannot receive it" did not exist: the fan-out selects
// the recipient org's ACTIVE users AND narrows by user id, so a deactivated owner emptied
// the recipient list instead of widening it, and the warning reached NOBODY while the
// department screen went on showing a filled-in owner.
//
// The two outcomes this suite keeps apart are "went to the one person who answers for it"
// and "went to the whole organisation because that person cannot be reached" — and the
// second one has to leave a trace, or it is indistinguishable afterwards from "went
// nowhere".
describe('addressed notifications: a recipient who cannot receive widens to the org', () => {
  let app: INestApplication;
  let db: Client;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ['Authorization', `Bearer ${t}`] as [string, string];
  const sent: Mail[] = [];
  const year = new Date().getUTCFullYear();
  let admin: string, approver: string, org: string;
  let liveOwnerId: string, deadOwnerId: string;
  let liveDep: string, deadDep: string, staleDep: string;

  const adminEmail = `nf-${tag}@t.test`;
  const approverEmail = `apprv-nf-${tag}@t.test`;
  const liveOwnerEmail = `live-${tag}@t.test`;
  const deadOwnerEmail = `dead-${tag}@t.test`;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitForMail = async (pred: (m: Mail) => boolean, ms = 4000): Promise<Mail | undefined> => {
    const until = Date.now() + ms;
    for (;;) {
      const hit = sent.find(pred);
      if (hit || Date.now() >= until) return hit;
      await sleep(50);
    }
  };
  const threshold = (m: Mail) => m.subject.includes('Бюджет на пороге');

  // A member, created without a login: `/auth/login` is throttled to 10/min and this suite
  // has no reason to spend one on somebody who never signs in.
  const addMember = async (email: string, fullName: string) => {
    const users = await http().post('/settings/users').set(...bearer(admin))
      .send({ email, fullName, password: 'password123', role: 'BUYER_USER' }).expect(201);
    return users.body.find((u: { email: string }) => u.email === email).id as string;
  };

  // A live plan for one department, then a request in it big enough to cross the 80% warn
  // line. The approval is the moment the warning is emitted.
  const planAndCross = async (departmentId: string, name: string, amountMinor: number, spendMinor: number) => {
    const created = await http().post('/budgets').set(...bearer(admin))
      .send({ name: `${name} ${tag}`, departmentId, periodYear: year, amountMinor }).expect(201);
    await http().post(`/budgets/${created.body.id}/submit`).set(...bearer(admin)).expect(201);
    await http().post(`/budgets/${created.body.id}/approve`).set(...bearer(approver)).expect(201);
    const req = await http().post('/requests').set(...bearer(admin))
      .send({ title: `${name} req ${tag}`, category: 'MISC', departmentId,
        items: [{ name: 'x', qty: 1, estUnitPriceMinor: spendMinor }] }).expect(201);
    await http().post(`/requests/${req.body.id}/submit`).set(...bearer(admin)).expect(201);
    const done = await http().post(`/requests/${req.body.id}/approve`).set(...bearer(approver)).expect(201);
    expect(done.body.status).toBe('APPROVED');
    return `${name} ${tag}`;
  };

  const noteFor = async (budgetName: string) =>
    (await db.query(
      `SELECT recipient_user_id FROM notifications
        WHERE type='BUDGET_THRESHOLD_CROSSED' AND payload->>'budget' = $1`,
      [budgetName],
    )).rows;

  const widenings = async () =>
    (await db.query(
      `SELECT payload FROM audit_events
        WHERE action='NOTIFICATION_WIDENED_TO_ORG' AND org_id=$1 ORDER BY seq`,
      [org],
    )).rows;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailProvider)
      .useValue({ kind: 'test', send: async (m: Mail) => { sent.push(m); } })
      .compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    // owner connection: deactivating a member and reading the audit chain are both outside
    // any request context, which RLS default-denies on the app_user role.
    db = new Client({ connectionString: process.env.DATABASE_OWNER_URL });
    await db.connect();

    const reg = await http().post('/auth/register/buyer')
      .send({ legalName: `Notify ${tag}`, fullName: 'Admin', email: adminEmail, password: 'password123' })
      .expect(201);
    admin = reg.body.accessToken;
    org = reg.body.org.id;
    approver = await addApprover(app, admin, `nf-${tag}`);
    liveOwnerId = await addMember(liveOwnerEmail, 'Live Owner');
    deadOwnerId = await addMember(deadOwnerEmail, 'Dead Owner');
    liveDep = (await http().post('/departments').set(...bearer(admin))
      .send({ code: `LIVE-${tag}`, ownerUserId: liveOwnerId }).expect(201)).body.id;
    deadDep = (await http().post('/departments').set(...bearer(admin))
      .send({ code: `DEAD-${tag}`, ownerUserId: deadOwnerId }).expect(201)).body.id;
    // A plan may not overlap another on the same (department, category, currency, period),
    // so the stale-owner case gets a department of its own rather than a second plan.
    staleDep = (await http().post('/departments').set(...bearer(admin))
      .send({ code: `STALE-${tag}` }).expect(201)).body.id;
    await http().put('/requests/method-policies').set(...bearer(admin))
      .send({ policies: [{ category: '*', minAmountMinor: 0, maxAmountMinor: null, method: 'DIRECT' }] })
      .expect(200);
  });

  afterAll(async () => {
    // The pause belongs INSIDE `app` so a failed cleanup cannot eat it: the post-commit
    // fan-out finishes reading recipients on its own connection after the response.
    await teardown(
      db,
      { close: async () => { await sleep(500); await app.close(); } },
      () => db.query(`DELETE FROM organizations WHERE legal_name LIKE $1`, [`Notify %${tag}%`]),
    );
  });

  // The control: this is the behaviour the targeting exists for, and it must survive the fix.
  it('an ACTIVE owner is the only person mailed, and nothing is recorded as widened', async () => {
    const budget = await planAndCross(liveDep, 'Live plan', 100_000, 90_000);

    const mail = await waitForMail((m) => m.to === liveOwnerEmail && threshold(m));
    expect(mail).toBeTruthy();
    expect(mail!.text).toContain('90%');
    expect(sent.some((m) => m.to === adminEmail && threshold(m))).toBe(false);
    expect(sent.some((m) => m.to === approverEmail && threshold(m))).toBe(false);

    const rows = await noteFor(budget);
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient_user_id).toBe(liveOwnerId);
    expect(await widenings()).toHaveLength(0);
  });

  // The defect. Before the fix the assertions below fail on the FIRST one: no mail at all.
  it('a deactivated owner does not silence the warning — the org is mailed instead', async () => {
    await db.query(`UPDATE organization_users SET status='SUSPENDED' WHERE id=$1`, [deadOwnerId]);
    const budget = await planAndCross(deadDep, 'Dead plan', 100_000, 85_000);

    const toAdmin = await waitForMail((m) => m.to === adminEmail && threshold(m));
    expect(toAdmin).toBeTruthy();
    expect(toAdmin!.text).toContain('85%');
    expect(await waitForMail((m) => m.to === approverEmail && threshold(m), 500)).toBeTruthy();
    // The switched-off owner is not mailed: they cannot sign in to act on it either.
    expect(sent.some((m) => m.to === deadOwnerEmail)).toBe(false);

    // The in-app row stops naming somebody who can no longer read it, so the whole org
    // sees an unaddressed notice rather than one addressed past them.
    const rows = await noteFor(budget);
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient_user_id).toBeNull();
  });

  // "Reached everyone" and "reached nobody" must not look the same in hindsight.
  it('the widening is in the audit trail, naming who was meant to get it and why', async () => {
    const rows = await widenings();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({
      type: 'BUDGET_THRESHOLD_CROSSED',
      intended_user_id: deadOwnerId,
      recipient_org_id: org,
    });
    expect(String(rows[0].payload.reason)).toMatch(/active member/i);
  });

  // A member removed from the organisation is the same case as a deactivated one: the id on
  // the department is stale either way, and the alarm still has to land somewhere.
  it('an owner who is no longer a member of the org widens the same way', async () => {
    await http().post('/auth/register/buyer')
      .send({ legalName: `Notify stranger ${tag}`, fullName: 'Stranger', email: `str-${tag}@t.test`, password: 'password123' })
      .expect(201);
    const strangerId = (await db.query(`SELECT id FROM organization_users WHERE email=$1`, [`str-${tag}@t.test`])).rows[0].id;
    // Straight into the column: the API refuses this owner (see departments.e2e-spec), and
    // what is under test here is the delivery of a notice whose target has gone stale.
    await db.query(`UPDATE departments SET owner_user_id=$2 WHERE id=$1`, [staleDep, strangerId]);

    const before = sent.length;
    const budget = await planAndCross(staleDep, 'Stale plan', 100_000, 95_000);
    expect(await waitForMail((m) => m.to === adminEmail && threshold(m) && m.text!.includes('95%'))).toBeTruthy();
    expect(sent.slice(before).some((m) => m.to === `str-${tag}@t.test`)).toBe(false);
    expect((await noteFor(budget))[0].recipient_user_id).toBeNull();
    expect(await widenings()).toHaveLength(2);
  });
});
