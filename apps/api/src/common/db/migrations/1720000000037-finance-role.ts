import { MigrationInterface, QueryRunner } from 'typeorm';

// A finance controller is a distinct job, and until now the system had no word for it.
// Whoever watched the money had to be a BUYER_ADMIN — which also hands them supplier
// blocking, user management and every other lever. Least privilege, but also plain
// accuracy: the person who signs off a plan is not the person who runs procurement.
//
// The role slots into machinery that already exists. approval_policies store steps as
// {order, role}, and approval_steps check the acting user's role against the step — so
// naming BUYER_FINANCE in a chain gives requests over a threshold a mandatory finance
// sign-off with no new workflow code at all.
export class FinanceRole1720000000037 implements MigrationInterface {
  name = 'FinanceRole1720000000037';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TYPE membership_role ADD VALUE IF NOT EXISTS 'BUYER_FINANCE'`);
    await q.query(`INSERT INTO release_versions(version) VALUES ('1.19.0-finance-role')`);
  }

  public async down(): Promise<void> {
    // Postgres cannot drop a single enum value; the role simply stops being assigned.
  }
}
