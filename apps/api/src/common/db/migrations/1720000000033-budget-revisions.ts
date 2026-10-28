import { MigrationInterface, QueryRunner } from 'typeorm';

// Budget revisions. PUT /budgets/:id used to overwrite amount_minor in place and record
// only the name in the audit trail, so "the plan was 500k, then someone made it 900k in
// March" was unrecoverable. Finance needs original plan → revisions → current, each with
// a date, an author and a reason.
//
// The current amount stays on budgets.amount_minor (every read path already uses it);
// budget_revisions is the append-only ledger that explains how it got there. Row 0 is
// seeded for every existing budget so the history is complete from day one.
export class BudgetRevisions1720000000033 implements MigrationInterface {
  name = 'BudgetRevisions1720000000033';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE budget_revisions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        buyer_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        budget_id uuid NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
        amount_before_minor bigint,          -- NULL on the initial plan
        amount_after_minor bigint NOT NULL,
        reason text,
        -- set when this revision carried an unspent remainder in from another period
        rollover_from_budget_id uuid REFERENCES budgets(id) ON DELETE SET NULL,
        created_by uuid REFERENCES organization_users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX budget_revisions_budget ON budget_revisions (budget_id, created_at)`);
    await q.query(`ALTER TABLE budget_revisions ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE budget_revisions FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY budget_revisions_rls ON budget_revisions
        USING (buyer_org_id = app_org_id())
        WITH CHECK (buyer_org_id = app_org_id())`);
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON budget_revisions TO app_user`);

    // Seed the opening entry for budgets that predate the ledger.
    await q.query(`
      INSERT INTO budget_revisions(buyer_org_id, budget_id, amount_before_minor, amount_after_minor, reason, created_at)
      SELECT b.buyer_org_id, b.id, NULL, b.amount_minor, 'Initial plan (recorded at upgrade)', b.created_at
      FROM budgets b`);

    await q.query(`INSERT INTO release_versions(version) VALUES ('1.15.0-budget-revisions')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS budget_revisions`);
  }
}
