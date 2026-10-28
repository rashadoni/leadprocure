import { MigrationInterface, QueryRunner } from 'typeorm';

// Budgets are AZN-only. Multi-currency budgeting without an FX policy was a trap: a budget
// in another currency simply never matched anything and sat at 0% forever, which reads as
// "we are underspending" rather than "this budget is broken".
//
// Procurement requests are AZN by construction (the API exposes no currency on them), so
// every commitment is already AZN. Only ORDERS can be foreign — a contract inherits its
// sourcing event's evaluation currency — and those are handled in the matching engine:
// they never touch an AZN budget, they surface in the unbudgeted report with their
// currency, so foreign spend is visible instead of silently absorbed at face value.
export class BudgetsAznOnly1720000000034 implements MigrationInterface {
  name = 'BudgetsAznOnly1720000000034';

  public async up(q: QueryRunner): Promise<void> {
    // The UI never offered a currency picker before this release, so a non-AZN budget can
    // only exist from a direct API call. There is no rate to convert it with and no way to
    // guess the intended AZN plan, so stop and let a human decide rather than invent a number.
    const foreign = await q.query(`SELECT name, currency, period_start FROM budgets WHERE currency <> 'AZN' LIMIT 20`);
    if (foreign.length) {
      const detail = foreign.map((b: any) => `"${b.name}" (${b.currency}, from ${b.period_start})`).join('; ');
      throw new Error(
        `Budgets are becoming AZN-only, and converting a plan without an FX policy would misstate it. ` +
        `Re-enter these in AZN and delete the originals, then re-run: ${detail}`,
      );
    }
    await q.query(`ALTER TABLE budgets ALTER COLUMN currency SET DEFAULT 'AZN'`);
    await q.query(`ALTER TABLE budgets ADD CONSTRAINT budgets_azn_only CHECK (currency = 'AZN')`);

    await q.query(`INSERT INTO release_versions(version) VALUES ('1.16.0-budgets-azn-only')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE budgets DROP CONSTRAINT IF EXISTS budgets_azn_only`);
  }
}
