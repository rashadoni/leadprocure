import { MigrationInterface, QueryRunner } from 'typeorm';

// Monthly phasing of a plan. Pace and forecast used to assume spend arrives evenly: at the
// end of May a yearly budget "should" be 42% used. For anything seasonal that is simply
// wrong — heating lands in winter, campaigns land in Q4 — so a department gets flagged as
// overspending in March and as comfortable in October, both times incorrectly.
//
// A budget may carry one row per month of its own period, holding that month's share of the
// plan in basis points. The shares must add up to exactly 10000 (100%); a budget with no
// rows keeps the old even proration, which is the right default for genuinely flat spend.
// The shares deliberately hold percentages, not amounts: a revision that changes
// amount_minor must not silently leave a phasing that no longer sums to the plan.
export class BudgetPhasing1720000000039 implements MigrationInterface {
  name = 'BudgetPhasing1720000000039';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE budget_phasing (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        buyer_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        budget_id uuid NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
        -- first day of the month this share belongs to; must fall inside the budget period
        month_start date NOT NULL,
        share_bp integer NOT NULL CHECK (share_bp >= 0 AND share_bp <= 10000),
        created_by uuid REFERENCES organization_users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT budget_phasing_month_is_first_day CHECK (date_trunc('month', month_start) = month_start),
        CONSTRAINT budget_phasing_unique_month UNIQUE (budget_id, month_start)
      )`);
    await q.query(`CREATE INDEX budget_phasing_budget ON budget_phasing (budget_id, month_start)`);
    await q.query(`ALTER TABLE budget_phasing ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE budget_phasing FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY budget_phasing_rls ON budget_phasing
        USING (buyer_org_id = app_org_id())
        WITH CHECK (buyer_org_id = app_org_id())`);
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON budget_phasing TO app_user`);

    await q.query(`INSERT INTO release_versions(version) VALUES ('1.19.0-budget-phasing')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS budget_phasing`);
  }
}
