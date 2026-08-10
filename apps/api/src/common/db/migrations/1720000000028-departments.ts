import { MigrationInterface, QueryRunner } from 'typeorm';

// Departments (cost centres) — the dimension finance actually budgets on. Until now the
// only spend dimension was `category` (what is bought), so "budget per department" (who
// spends) had nothing to attach to. A curated per-buyer list, RLS by buyer_org_id like
// procurement_categories, with an optional parent for a department → sub-department tree
// and an owner who is answerable for the budget.
//
// FK choice: every reference to departments is ON DELETE SET NULL, never RESTRICT.
// Organizations cascade-delete their departments AND their requests, and a RESTRICT here
// would race that cascade and block org deletion. "You cannot delete a department that is
// in use" is enforced in the service as a clean 409 instead.
export class Departments1720000000028 implements MigrationInterface {
  name = 'Departments1720000000028';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE departments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        buyer_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        code text NOT NULL,
        name text,
        parent_id uuid REFERENCES departments(id) ON DELETE SET NULL,
        owner_user_id uuid REFERENCES organization_users(id) ON DELETE SET NULL,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (buyer_org_id, code)
      )`);
    await q.query(`CREATE INDEX departments_parent ON departments (parent_id)`);
    await q.query(`ALTER TABLE departments ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE departments FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY departments_rls ON departments
        USING (buyer_org_id = app_org_id())
        WITH CHECK (buyer_org_id = app_org_id())`);
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON departments TO app_user`);

    // Which department's budget a request spends. Nullable on purpose: historic requests
    // predate departments and report under an explicit "unassigned" bucket.
    await q.query(
      `ALTER TABLE procurement_requests
         ADD COLUMN department_id uuid REFERENCES departments(id) ON DELETE SET NULL`,
    );
    await q.query(`CREATE INDEX procurement_requests_department ON procurement_requests (department_id)`);

    // A user's home department — the default for their requests and (later) the scope a
    // BUYER_USER may see budgets for.
    await q.query(
      `ALTER TABLE memberships
         ADD COLUMN department_id uuid REFERENCES departments(id) ON DELETE SET NULL`,
    );

    await q.query(`INSERT INTO release_versions(version) VALUES ('1.11.0-departments')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE memberships DROP COLUMN IF EXISTS department_id`);
    await q.query(`DROP INDEX IF EXISTS procurement_requests_department`);
    await q.query(`ALTER TABLE procurement_requests DROP COLUMN IF EXISTS department_id`);
    await q.query(`DROP TABLE IF EXISTS departments`);
  }
}
