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

  console.log('Seeded successfully.\n');
  console.log('Buyer org  : Acme MMC');
  console.log('  admin@acme.test / ' + password + '  (BUYER_ADMIN)');
  console.log('  approver@acme.test / ' + password + '  (BUYER_APPROVER)');
  console.log('  user@acme.test / ' + password + '  (BUYER_USER)');
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
