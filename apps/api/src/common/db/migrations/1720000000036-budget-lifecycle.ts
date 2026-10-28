import { MigrationInterface, QueryRunner } from 'typeorm';

// A budget becomes a document. Until now it was a row an admin could create, edit and
// silently re-edit in one motion — while a procurement REQUEST, which commits far less
// money, went through DRAFT → SUBMITTED → APPROVED with a segregation-of-duties check.
// The heavier document had the lighter controls.
//
// Lifecycle: DRAFT (being drafted, does not hold money yet) → PENDING (submitted for
// approval, frozen) → APPROVED (in force; the amount moves only through a reasoned
// revision) → CLOSED (period signed off, nothing changes at all).
//
// Existing rows are back-filled as APPROVED: they were already in force and had already
// been drawn against, so demoting them to DRAFT would silently zero out live commitments.
export class BudgetLifecycle1720000000036 implements MigrationInterface {
  name = 'BudgetLifecycle1720000000036';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TYPE budget_status AS ENUM ('DRAFT','PENDING','APPROVED','CLOSED')`);
    await q.query(`
      ALTER TABLE budgets
        ADD COLUMN status budget_status NOT NULL DEFAULT 'DRAFT',
        ADD COLUMN submitted_by uuid REFERENCES organization_users(id) ON DELETE SET NULL,
        ADD COLUMN submitted_at timestamptz,
        ADD COLUMN approved_by uuid REFERENCES organization_users(id) ON DELETE SET NULL,
        ADD COLUMN approved_at timestamptz,
        ADD COLUMN closed_by uuid REFERENCES organization_users(id) ON DELETE SET NULL,
        ADD COLUMN closed_at timestamptz,
        ADD COLUMN created_by uuid REFERENCES organization_users(id) ON DELETE SET NULL`);

    // Everything that exists today is live money — see the note above.
    await q.query(`UPDATE budgets SET status = 'APPROVED', approved_at = created_at`);

    // Utilization only ever considers budgets that are actually in force, so the matching
    // engine can filter on this without a second lookup.
    await q.query(`CREATE INDEX budgets_status ON budgets (buyer_org_id, status)`);

    await q.query(`INSERT INTO release_versions(version) VALUES ('1.18.0-budget-lifecycle')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS budgets_status`);
    await q.query(`
      ALTER TABLE budgets
        DROP COLUMN IF EXISTS created_by,
        DROP COLUMN IF EXISTS closed_at,
        DROP COLUMN IF EXISTS closed_by,
        DROP COLUMN IF EXISTS approved_at,
        DROP COLUMN IF EXISTS approved_by,
        DROP COLUMN IF EXISTS submitted_at,
        DROP COLUMN IF EXISTS submitted_by,
        DROP COLUMN IF EXISTS status`);
    await q.query(`DROP TYPE IF EXISTS budget_status`);
  }
}
