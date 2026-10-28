import { MigrationInterface, QueryRunner } from 'typeorm';

// Budgets gain the department dimension: department_id NULL = "any department" (the
// org-wide ceiling), a value = that cost centre's own ceiling.
//
// The EXCLUDE constraint is the structural half of the no-double-counting rule: two
// budgets covering the same (department, category, currency) over overlapping dates used
// to both count the same request in full. Matching still picks ONE budget per request by
// specificity, but this stops the ambiguous data from being created in the first place.
// NULLs are compared as equal here on purpose — two org-wide budgets for the same
// category and quarter are exactly the collision we want to reject.
export class BudgetDepartments1720000000030 implements MigrationInterface {
  name = 'BudgetDepartments1720000000030';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE budgets ADD COLUMN department_id uuid REFERENCES departments(id) ON DELETE SET NULL`);
    await q.query(`CREATE INDEX budgets_department ON budgets (buyer_org_id, department_id, period_start)`);

    await q.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);

    // Nothing stopped a buyer from creating two same-scope budgets before this release
    // (uniqueness was only on the name), and there is no safe way to guess which one
    // should survive. Fail the migration with the offenders named, so the operator fixes
    // the data deliberately instead of debugging a raw 23P01 later.
    const clashes = await q.query(`
      SELECT a.buyer_org_id, a.name AS name_a, b.name AS name_b, a.category, a.currency,
             a.period_start AS start_a, b.period_start AS start_b
      FROM budgets a JOIN budgets b
        ON a.id < b.id
       AND a.buyer_org_id = b.buyer_org_id
       AND a.category = b.category
       AND a.currency = b.currency
       AND coalesce(a.department_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = coalesce(b.department_id, '00000000-0000-0000-0000-000000000000'::uuid)
       AND daterange(a.period_start, a.period_end, '[]') && daterange(b.period_start, b.period_end, '[]')
      LIMIT 20`);
    if (clashes.length) {
      const detail = clashes
        .map((c: any) => `"${c.name_a}" (${c.start_a}) vs "${c.name_b}" (${c.start_b}) — category ${c.category}, ${c.currency}`)
        .join('; ');
      throw new Error(
        `Cannot enforce one budget per (department, category, currency, period): overlapping budgets exist. ` +
        `Merge or re-scope these first, then re-run the migration: ${detail}`,
      );
    }

    await q.query(`
      ALTER TABLE budgets ADD CONSTRAINT budgets_no_overlap EXCLUDE USING gist (
        buyer_org_id WITH =,
        coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
        category WITH =,
        currency WITH =,
        daterange(period_start, period_end, '[]') WITH &&
      )`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE budgets DROP CONSTRAINT IF EXISTS budgets_no_overlap`);
    await q.query(`DROP INDEX IF EXISTS budgets_department`);
    await q.query(`ALTER TABLE budgets DROP COLUMN IF EXISTS department_id`);
  }
}
