import { MigrationInterface, QueryRunner } from 'typeorm';

// Budget thresholds per buyer org. Until now the only control was a warning attached to
// an approval that had ALREADY tipped a budget over — a request eating 99% of its budget
// said nothing at all, and nothing could stop an overspend.
//
// warn_pct fires a notification on crossing; block_pct actually refuses the approval and
// is NULL (off) by default, because turning it on changes a control that has never
// blocked anything — that has to be a deliberate act, not a migration side effect.
export class BudgetPolicies1720000000032 implements MigrationInterface {
  name = 'BudgetPolicies1720000000032';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE budget_policies (
        buyer_org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
        warn_pct int NOT NULL DEFAULT 80 CHECK (warn_pct > 0 AND warn_pct <= 1000),
        block_pct int CHECK (block_pct IS NULL OR (block_pct > 0 AND block_pct <= 1000)),
        allow_override boolean NOT NULL DEFAULT true,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`ALTER TABLE budget_policies ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE budget_policies FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY budget_policies_rls ON budget_policies
        USING (buyer_org_id = app_org_id())
        WITH CHECK (buyer_org_id = app_org_id())`);
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON budget_policies TO app_user`);

    await q.query(`INSERT INTO release_versions(version) VALUES ('1.14.0-budget-policies')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS budget_policies`);
  }
}
