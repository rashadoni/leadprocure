import { MigrationInterface, QueryRunner } from 'typeorm';

// Budget periods: year / quarter / month. `period_year` alone could only express an annual
// ceiling, but finance plans and reviews by quarter, so a budget now carries a date RANGE
// (period_start … period_end) plus the type that produced it. One range engine covers the
// calendar year, a quarter, a month and — later — a non-calendar fiscal year.
//
// `period_year` is intentionally KEPT and back-filled in step with the range, so this
// migration is safe to deploy before the code that stops reading it; dropping the column
// is a separate, later migration.
//
// Also adds procurement_requests.approved_at. Commitment was dated by created_at, so a
// request raised on 28 Dec and approved on 5 Jan committed against the PREVIOUS year's
// budget. Harmless-looking at annual granularity, fatal at monthly.
export class BudgetPeriods1720000000029 implements MigrationInterface {
  name = 'BudgetPeriods1720000000029';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE budgets
        ADD COLUMN period_type text NOT NULL DEFAULT 'YEAR'
          CHECK (period_type IN ('YEAR','QUARTER','MONTH')),
        ADD COLUMN period_start date,
        ADD COLUMN period_end date`);
    // Existing rows are annual by definition — expand the year into its calendar range.
    await q.query(`
      UPDATE budgets
      SET period_start = make_date(period_year, 1, 1),
          period_end   = make_date(period_year, 12, 31)
      WHERE period_start IS NULL`);
    await q.query(`ALTER TABLE budgets ALTER COLUMN period_start SET NOT NULL`);
    await q.query(`ALTER TABLE budgets ALTER COLUMN period_end SET NOT NULL`);
    await q.query(`ALTER TABLE budgets ADD CONSTRAINT budgets_period_order CHECK (period_end >= period_start)`);

    // Uniqueness moves with the period: "IT Q1" and "IT Q2" are different budgets that
    // used to collide under (name, year).
    await q.query(`ALTER TABLE budgets DROP CONSTRAINT budgets_buyer_org_id_name_period_year_key`);
    await q.query(`ALTER TABLE budgets ADD CONSTRAINT budgets_org_name_period_key UNIQUE (buyer_org_id, name, period_start)`);
    await q.query(`CREATE INDEX budgets_period ON budgets (buyer_org_id, period_start, period_end)`);

    await q.query(`ALTER TABLE procurement_requests ADD COLUMN approved_at timestamptz`);
    // Best-effort back-fill: the exact approval instant was never stored, and updated_at
    // is the closest proxy (approval is the last write on most approved requests). Historic
    // periods are therefore approximate; everything approved from here on is exact.
    await q.query(`UPDATE procurement_requests SET approved_at = updated_at WHERE status = 'APPROVED'`);
    await q.query(`CREATE INDEX procurement_requests_approved_at ON procurement_requests (approved_at)`);

    await q.query(`INSERT INTO release_versions(version) VALUES ('1.12.0-budget-periods')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS procurement_requests_approved_at`);
    await q.query(`ALTER TABLE procurement_requests DROP COLUMN IF EXISTS approved_at`);
    await q.query(`DROP INDEX IF EXISTS budgets_period`);
    await q.query(`ALTER TABLE budgets DROP CONSTRAINT IF EXISTS budgets_org_name_period_key`);
    await q.query(`ALTER TABLE budgets ADD CONSTRAINT budgets_buyer_org_id_name_period_year_key UNIQUE (buyer_org_id, name, period_year)`);
    await q.query(`ALTER TABLE budgets DROP CONSTRAINT IF EXISTS budgets_period_order`);
    await q.query(`
      ALTER TABLE budgets
        DROP COLUMN IF EXISTS period_end,
        DROP COLUMN IF EXISTS period_start,
        DROP COLUMN IF EXISTS period_type`);
  }
}
