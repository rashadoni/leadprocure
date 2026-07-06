import { MigrationInterface, QueryRunner } from 'typeorm';

// Budgets & commitment control (MVP): a buyer defines a spend ceiling per category and
// calendar year. Utilization is an *encumbrance* model — APPROVED procurement requests
// commit against the matching budget (category + year + currency). Private buyer table:
// RLS by buyer_org_id = app_org_id(), like the other owner-scoped tables.
export class Budgets1720000000018 implements MigrationInterface {
  name = 'Budgets1720000000018';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE budgets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        buyer_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name text NOT NULL,
        category text NOT NULL DEFAULT '*',   -- '*' matches every category
        period_year int NOT NULL,
        amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
        currency char(3) NOT NULL DEFAULT 'AZN',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (buyer_org_id, name, period_year)
      )`);
    await q.query(`CREATE INDEX budgets_lookup ON budgets (buyer_org_id, period_year, category)`);
    await q.query(`ALTER TABLE budgets ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE budgets FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY budgets_rls ON budgets
        USING (buyer_org_id = app_org_id())
        WITH CHECK (buyer_org_id = app_org_id())`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS budgets`);
  }
}
