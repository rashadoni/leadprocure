import { MigrationInterface, QueryRunner } from 'typeorm';

// Plan / Commitment / Actual. Budgets only knew the estimate on an approved request, so a
// request approved at 100k that turned into a 130k PO reported 100k forever, and a request
// that never became a PO held its reserve for good.
//
// purchase_orders.request_id is the missing link. Walking request → event → contract → PO
// at read time is not an option: the chain breaks on direct purchases (no event) and on
// catalog call-offs (no request at all), so the origin is denormalized onto the PO at
// creation. department_id rides along for reporting on POs whose request is gone.
//
// request_status gains CANCELLED: an approved request that is abandoned must be able to
// release its commitment. Without it, a reserve was permanent.
export class BudgetActuals1720000000031 implements MigrationInterface {
  name = 'BudgetActuals1720000000031';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE purchase_orders
        ADD COLUMN request_id uuid REFERENCES procurement_requests(id) ON DELETE SET NULL,
        ADD COLUMN department_id uuid REFERENCES departments(id) ON DELETE SET NULL`);
    await q.query(`CREATE INDEX purchase_orders_request ON purchase_orders (request_id)`);

    // Back-fill what the chain can still prove: award → event → request.
    await q.query(`
      UPDATE purchase_orders po
      SET request_id = se.request_id
      FROM contracts c
      JOIN awards a ON a.id = c.award_id
      JOIN sourcing_events se ON se.id = a.event_id
      WHERE po.contract_id = c.id AND se.request_id IS NOT NULL AND po.request_id IS NULL`);
    await q.query(`
      UPDATE purchase_orders po
      SET department_id = pr.department_id
      FROM procurement_requests pr
      WHERE pr.id = po.request_id AND po.department_id IS NULL`);

    await q.query(`ALTER TABLE invoices ADD COLUMN department_id uuid REFERENCES departments(id) ON DELETE SET NULL`);
    await q.query(`
      UPDATE invoices i SET department_id = po.department_id
      FROM purchase_orders po WHERE po.id = i.po_id AND po.department_id IS NOT NULL`);

    // ALTER TYPE … ADD VALUE cannot run inside the transaction that then uses the value,
    // but adding it alone is fine — the value is used by later statements in other txs.
    await q.query(`ALTER TYPE request_status ADD VALUE IF NOT EXISTS 'CANCELLED'`);
    await q.query(`ALTER TABLE procurement_requests ADD COLUMN cancelled_at timestamptz, ADD COLUMN cancel_reason text`);

    await q.query(`INSERT INTO release_versions(version) VALUES ('1.13.0-budget-actuals')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    // request_status keeps CANCELLED: Postgres cannot drop a single enum value.
    await q.query(`ALTER TABLE procurement_requests DROP COLUMN IF EXISTS cancel_reason, DROP COLUMN IF EXISTS cancelled_at`);
    await q.query(`ALTER TABLE invoices DROP COLUMN IF EXISTS department_id`);
    await q.query(`DROP INDEX IF EXISTS purchase_orders_request`);
    await q.query(`
      ALTER TABLE purchase_orders
        DROP COLUMN IF EXISTS department_id,
        DROP COLUMN IF EXISTS request_id`);
  }
}
