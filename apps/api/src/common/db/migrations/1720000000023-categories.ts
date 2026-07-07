import { MigrationInterface, QueryRunner } from 'typeorm';

// Managed procurement categories. Category was a free-text string on requests/policies/
// budgets, so "IT", "it" and "АйТи" silently split the method policy, budgets and analytics.
// A curated per-buyer list (RLS by buyer_org_id, like the other owner-scoped tables) gives
// the request form a controlled source; the column stays text, so existing data is untouched.
export class Categories1720000000023 implements MigrationInterface {
  name = 'Categories1720000000023';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE procurement_categories (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        buyer_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        code text NOT NULL,
        name text,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (buyer_org_id, code)
      )`);
    await q.query(`ALTER TABLE procurement_categories ENABLE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY procurement_categories_rls ON procurement_categories
        USING (buyer_org_id = app_org_id())
        WITH CHECK (buyer_org_id = app_org_id())`);
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON procurement_categories TO app_user`);
    await q.query(`INSERT INTO release_versions(version) VALUES ('1.10.0-categories')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS procurement_categories`);
  }
}
