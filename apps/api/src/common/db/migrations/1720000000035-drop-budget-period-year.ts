import { MigrationInterface, QueryRunner } from 'typeorm';

// Retire budgets.period_year. Migration 0029 kept it deliberately — back-filled in step
// with period_start/period_end — so the schema change could ship ahead of the code that
// still read it. That code is gone: every query slices by the date range, and the
// periodYear the API still returns is derived from period_start.
//
// Two sources of truth for the same fact is how they drift: nothing stopped a write from
// setting period_year = 2026 on a range starting in 2025.
export class DropBudgetPeriodYear1720000000035 implements MigrationInterface {
  name = 'DropBudgetPeriodYear1720000000035';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE budgets DROP COLUMN IF EXISTS period_year`);
    await q.query(`INSERT INTO release_versions(version) VALUES ('1.17.0-drop-period-year')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE budgets ADD COLUMN period_year int`);
    await q.query(`UPDATE budgets SET period_year = EXTRACT(YEAR FROM period_start)::int`);
    await q.query(`ALTER TABLE budgets ALTER COLUMN period_year SET NOT NULL`);
  }
}
