import { MigrationInterface, QueryRunner } from 'typeorm';

// Freeze the numbers when a period is signed off.
//
// Utilization is derived — recomputed from the current state of requests and orders every
// time it is read. That is right for a live budget and wrong for a closed one: cancel an
// old request today, or re-date an order, and last quarter's reported spend silently moves.
// Finance signs a number; the number has to stay signed.
//
// So closing stores what the budget WAS, and a CLOSED budget reports the snapshot instead
// of a fresh calculation. Reopening clears it, because a reopened period is live again.
export class BudgetCloseSnapshot1720000000038 implements MigrationInterface {
  name = 'BudgetCloseSnapshot1720000000038';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE budgets
        ADD COLUMN closed_committed_minor bigint,
        ADD COLUMN closed_actual_minor bigint`);

    // Budgets closed before this migration have no snapshot; they keep computing live until
    // they are reopened and closed again. Back-filling a guess would be worse than the gap.
    await q.query(`INSERT INTO release_versions(version) VALUES ('1.20.0-close-snapshot')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE budgets
        DROP COLUMN IF EXISTS closed_actual_minor,
        DROP COLUMN IF EXISTS closed_committed_minor`);
  }
}
