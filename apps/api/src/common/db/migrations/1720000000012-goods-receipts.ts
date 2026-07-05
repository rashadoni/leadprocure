import { MigrationInterface, QueryRunner } from 'typeorm';

// Group 1c — goods receipt (GRN). The buyer records what actually arrived against a PO,
// possibly in several partial receipts. Cross-org read (both parties), BUYER writes
// (receiving is buyer-side). Feeds the 3-way match in Group 4.
export class GoodsReceipts1720000000012 implements MigrationInterface {
  name = 'GoodsReceipts1720000000012';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE goods_receipts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        po_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        buyer_org_id uuid NOT NULL,
        supplier_org_id uuid NOT NULL,
        received_by uuid REFERENCES organization_users(id),
        note text,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE TABLE goods_receipt_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        gr_id uuid NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
        po_item_id uuid NOT NULL REFERENCES purchase_order_items(id) ON DELETE CASCADE,
        buyer_org_id uuid NOT NULL,
        supplier_org_id uuid NOT NULL,
        qty_received numeric NOT NULL
      )`);
    await q.query(`CREATE INDEX idx_gr_po ON goods_receipts(po_id)`);
    await q.query(`CREATE INDEX idx_gr_items_gr ON goods_receipt_items(gr_id)`);

    for (const t of ['goods_receipts', 'goods_receipt_items'] as const) {
      await q.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
      await q.query(`
        CREATE POLICY ${t}_select ON ${t} FOR SELECT
          USING (buyer_org_id = app_org_id() OR supplier_org_id = app_org_id())`);
      await q.query(`
        CREATE POLICY ${t}_modify ON ${t} FOR ALL
          USING (buyer_org_id = app_org_id())
          WITH CHECK (buyer_org_id = app_org_id())`);
    }
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON goods_receipts, goods_receipt_items TO app_user`);
    await q.query(`INSERT INTO release_versions(version) VALUES ('1.7.0-grn')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS goods_receipt_items CASCADE`);
    await q.query(`DROP TABLE IF EXISTS goods_receipts CASCADE`);
  }
}
