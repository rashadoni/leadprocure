import 'reflect-metadata';
import { loadRootEnv } from './common/config/env';

loadRootEnv();

import { Client } from 'pg';
import * as argon2 from 'argon2';

// Dev/demo seed. Runs as app_user through the same RLS paths the API uses,
// switching org context with set_config — proving the policies while seeding.
async function main(): Promise<void> {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  const existing = await db.query(`SELECT id FROM organization_users WHERE email = 'admin@acme.test'`);
  if (existing.rows.length) {
    console.log('Seed already applied — skipping.');
    await db.end();
    return;
  }

  const as = (orgId: string, role: string) =>
    db.query(`SELECT set_config('app.org_id',$1,false), set_config('app.role',$2,false)`, [orgId, role]);

  const org = async (kind: string, name: string, voen: string | null) =>
    (
      await db.query(
        `INSERT INTO organizations(kind, legal_name, voen) VALUES ($1,$2,$3) RETURNING id`,
        [kind, name, voen],
      )
    ).rows[0].id as string;

  const password = 'Passw0rd!';
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const user = async (email: string, fullName: string) =>
    (
      await db.query(
        `INSERT INTO organization_users(email, password_hash, full_name) VALUES ($1,$2,$3) RETURNING id`,
        [email, hash, fullName],
      )
    ).rows[0].id as string;
  const member = (userId: string, orgId: string, role: string) =>
    db.query(`INSERT INTO memberships(user_id, org_id, role) VALUES ($1,$2,$3)`, [userId, orgId, role]);

  // --- buyer: Acme ---
  const acme = await org('BUYER', 'Acme MMC', '1234567890');
  const admin = await user('admin@acme.test', 'Acme Admin');
  const approver = await user('approver@acme.test', 'Acme Approver');
  const buyerUser = await user('user@acme.test', 'Acme User');
  await member(admin, acme, 'BUYER_ADMIN');
  await member(approver, acme, 'BUYER_APPROVER');
  await member(buyerUser, acme, 'BUYER_USER');
  await as(acme, 'BUYER_ADMIN');
  await db.query(`INSERT INTO buyer_profiles(org_id, default_currency) VALUES ($1,'AZN')`, [acme]);
  // 0–50k AZN direct, above → sealed RFQ (etender.gov.az reference threshold)
  await db.query(
    `INSERT INTO procurement_method_policies(buyer_org_id, category, min_amount_minor, max_amount_minor, method)
     VALUES ($1,'*',0,5000000,'DIRECT'), ($1,'*',5000000,NULL,'RFQ')`,
    [acme],
  );

  // --- suppliers ---
  const mkSupplier = async (name: string, voen: string, email: string, categories: string[]) => {
    const id = await org('SUPPLIER', name, voen);
    const u = await user(email, `${name} Seller`);
    await member(u, id, 'SUPPLIER_USER');
    await as(id, 'SUPPLIER_USER');
    await db.query(`INSERT INTO supplier_profiles(org_id, categories) VALUES ($1,$2)`, [id, categories]);
    return id;
  };
  const supplyOne = await mkSupplier('Supply One MMC', '2345678901', 'seller@supply-one.test', ['workwear', 'office']);
  const bakuMetal = await mkSupplier('Baku Metal ASC', '3456789012', 'seller@baku-metal.test', ['metal', 'construction']);

  // Acme pre-approves Supply One in its registry
  await as(acme, 'BUYER_ADMIN');
  await db.query(
    `INSERT INTO supplier_relationships(buyer_org_id, supplier_org_id, status) VALUES ($1,$2,'APPROVED')`,
    [acme, supplyOne],
  );

  await db.query(
    `INSERT INTO fx_rates(base, quote, rate) VALUES ('USD','AZN',1.70), ('EUR','AZN',1.85)
     ON CONFLICT (base, quote, as_of) DO NOTHING`,
  );

  // --- departments + budgets ---
  // Without these the budget module opens empty on a demo stand, which is exactly the
  // screen finance is here to look at. IT owns its budget through the approver; the plain
  // buyer user sits in OPS, so their requests default to it (and they only see OPS budgets).
  const dept = async (code: string, name: string, ownerUserId: string | null) =>
    (
      await db.query(
        `INSERT INTO departments(buyer_org_id, code, name, owner_user_id) VALUES ($1,$2,$3,$4) RETURNING id`,
        [acme, code, name, ownerUserId],
      )
    ).rows[0].id as string;
  const it = await dept('IT', 'İnformasiya texnologiyaları', approver);
  const ops = await dept('OPS', 'Əməliyyat', admin);
  await db.query(`UPDATE memberships SET department_id = $2 WHERE user_id = $1 AND org_id = $3`, [buyerUser, ops, acme]);
  await db.query(`UPDATE memberships SET department_id = $2 WHERE user_id = $1 AND org_id = $3`, [approver, it, acme]);

  await db.query(
    `INSERT INTO procurement_categories(buyer_org_id, code, name)
     VALUES ($1,'IT','Avadanlıq və proqram təminatı'), ($1,'OFFICE','Ofis təchizatı')`,
    [acme],
  );

  const year = new Date().getFullYear();
  const quarter = Math.floor(new Date().getMonth() / 3) + 1;
  const qStart = new Date(Date.UTC(year, (quarter - 1) * 3, 1));
  const qEnd = new Date(Date.UTC(year, quarter * 3, 0));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const budget = async (
    name: string, departmentId: string | null, category: string,
    type: string, start: string, end: string, amountMinor: number,
  ) => {
    const id = (
      await db.query(
        `INSERT INTO budgets(buyer_org_id, name, category, department_id, period_type,
           period_start, period_end, amount_minor, currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'AZN') RETURNING id`,
        [acme, name, category, departmentId, type, start, end, amountMinor],
      )
    ).rows[0].id as string;
    // the ledger starts with the opening plan, same as it would through the API
    await db.query(
      `INSERT INTO budget_revisions(buyer_org_id, budget_id, amount_after_minor, reason, created_by)
       VALUES ($1,$2,$3,'Initial plan',$4)`,
      [acme, id, amountMinor, admin],
    );
    return id;
  };
  // No two budgets may cover the same (department, category, period) — the scopes below are
  // deliberately disjoint: an org-wide ceiling, IT for the year, OPS for this quarter.
  await budget('Ümumi büdcə', null, '*', 'YEAR', `${year}-01-01`, `${year}-12-31`, 50_000_00);
  await budget('IT büdcəsi', it, 'IT', 'YEAR', `${year}-01-01`, `${year}-12-31`, 20_000_00);
  await budget('OPS rüblük', ops, 'OFFICE', 'QUARTER', iso(qStart), iso(qEnd), 6_000_00);
  await db.query(
    `INSERT INTO budget_policies(buyer_org_id, warn_pct, block_pct) VALUES ($1, 80, NULL)`,
    [acme],
  );

  console.log('Seeded successfully.\n');
  console.log('Buyer org  : Acme MMC');
  console.log('  admin@acme.test / ' + password + '  (BUYER_ADMIN)');
  console.log('  approver@acme.test / ' + password + '  (BUYER_APPROVER)');
  console.log('  user@acme.test / ' + password + '  (BUYER_USER)');
  console.log('Departments: IT (owner: approver), OPS (owner: admin) — user@acme.test sits in OPS');
  console.log(`Budgets    : org-wide ${year} · IT ${year} · OPS ${year} Q${quarter}; warn at 80%, block off`);
  console.log('Suppliers  :');
  console.log('  seller@supply-one.test / ' + password + '  (Supply One MMC — pre-approved by Acme)');
  console.log('  seller@baku-metal.test / ' + password + '  (Baku Metal ASC)');
  console.log(`\nOrg ids: acme=${acme} supplyOne=${supplyOne} bakuMetal=${bakuMetal}`);
  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
