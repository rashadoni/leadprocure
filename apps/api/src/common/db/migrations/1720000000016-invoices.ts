import { MigrationInterface, QueryRunner } from 'typeorm';

// Group 4 — Procure-to-Pay tail: invoices with a 3-way match (invoice ↔ PO ↔ receipt).
// Cross-org: the SUPPLIER submits the invoice (owns the row), the BUYER approves/pays via
// the SECURITY DEFINER invoice_set_status() seam (buyer can't own a supplier-owned row).
export class Invoices1720000000016 implements MigrationInterface {
  name = 'Invoices1720000000016';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TYPE invoice_status AS ENUM ('SUBMITTED','MATCHED','DISPUTED','APPROVED','PAID','REJECTED')`);
    await q.query(`
      CREATE TABLE invoices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        buyer_org_id uuid NOT NULL,
        supplier_org_id uuid NOT NULL,
        po_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        invoice_no text NOT NULL,
        currency char(3) NOT NULL DEFAULT 'AZN',
        net_minor bigint NOT NULL DEFAULT 0,
        vat_minor bigint NOT NULL DEFAULT 0,
        gross_minor bigint NOT NULL DEFAULT 0,
        status invoice_status NOT NULL DEFAULT 'SUBMITTED',
        match jsonb NOT NULL DEFAULT '{}',
        issued_at timestamptz NOT NULL DEFAULT now(),
        due_date date,
        created_by uuid REFERENCES organization_users(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (supplier_org_id, invoice_no)
      )`);
    await q.query(`
      CREATE TABLE invoice_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
        po_item_id uuid NOT NULL REFERENCES purchase_order_items(id) ON DELETE CASCADE,
        buyer_org_id uuid NOT NULL,
        supplier_org_id uuid NOT NULL,
        qty numeric NOT NULL,
        unit_price_minor bigint NOT NULL,
        line_total_minor bigint NOT NULL
      )`);
    await q.query(`CREATE INDEX idx_invoices_buyer ON invoices(buyer_org_id, status)`);
    await q.query(`CREATE INDEX idx_invoices_supplier ON invoices(supplier_org_id, status)`);
    await q.query(`CREATE INDEX idx_invoice_items_inv ON invoice_items(invoice_id)`);

    // invoices: both read; only the SUPPLIER writes (submits)
    await q.query(`ALTER TABLE invoices ENABLE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY inv_select ON invoices FOR SELECT
        USING (buyer_org_id = app_org_id() OR supplier_org_id = app_org_id())`);
    await q.query(`
      CREATE POLICY inv_modify ON invoices FOR ALL
        USING (supplier_org_id = app_org_id()) WITH CHECK (supplier_org_id = app_org_id())`);
    await q.query(`ALTER TABLE invoice_items ENABLE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY invi_select ON invoice_items FOR SELECT
        USING (buyer_org_id = app_org_id() OR supplier_org_id = app_org_id())`);
    await q.query(`
      CREATE POLICY invi_modify ON invoice_items FOR ALL
        USING (supplier_org_id = app_org_id()) WITH CHECK (supplier_org_id = app_org_id())`);

    // Buyer-side status transitions (approve / reject / pay).
    await q.query(`
      CREATE FUNCTION invoice_set_status(p_id uuid, p_to invoice_status)
      RETURNS invoices LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE v_inv invoices; v_actor uuid := nullif(current_setting('app.org_id', true), '')::uuid; v_ok boolean;
      BEGIN
        SELECT * INTO v_inv FROM invoices WHERE id = p_id FOR UPDATE;
        IF v_inv.id IS NULL THEN RAISE EXCEPTION 'Invoice not found'; END IF;
        IF v_actor <> v_inv.buyer_org_id THEN RAISE EXCEPTION 'Only the buyer changes invoice status'; END IF;
        v_ok := (v_inv.status IN ('MATCHED','DISPUTED','SUBMITTED') AND p_to IN ('APPROVED','REJECTED'))
             OR (v_inv.status = 'APPROVED' AND p_to = 'PAID');
        IF NOT v_ok THEN RAISE EXCEPTION 'Illegal invoice transition % -> %', v_inv.status, p_to; END IF;
        UPDATE invoices SET status = p_to WHERE id = p_id RETURNING * INTO v_inv;
        RETURN v_inv;
      END $$`);

    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON invoices, invoice_items TO app_user`);
    await q.query(`INSERT INTO release_versions(version) VALUES ('2.2.0-p2p')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP FUNCTION IF EXISTS invoice_set_status(uuid, invoice_status)`);
    await q.query(`DROP TABLE IF EXISTS invoice_items CASCADE`);
    await q.query(`DROP TABLE IF EXISTS invoices CASCADE`);
    await q.query(`DROP TYPE IF EXISTS invoice_status`);
  }
}
