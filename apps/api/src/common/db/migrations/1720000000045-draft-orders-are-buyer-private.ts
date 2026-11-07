import { MigrationInterface, QueryRunner } from 'typeorm';

// A draft order was already on the supplier's screen.
//
// `purchase_orders` is created in DRAFT by all three paths that make one — a direct
// purchase, an order drawn against a contract, a catalogue call-off — and the buyer then
// presses «Выдать заказ» to send it. The read policy, though, admitted either party from
// the moment the row existed: `buyer_org_id = app_org_id() OR supplier_org_id =
// app_org_id()`. So the counterparty saw the order, its lines and its money while the buyer
// was still preparing it, and the act of issuing changed nothing they could perceive — it
// had been in their «Заказы в работе» all along. Found in the interface audit, on the demo
// stand: PO-2026-0009, «Черновик», 144,00 AZN, sitting in the supplier's list at the same
// moment the buyer's screen offered the button that supposedly sends it.
//
// The supplier now reads an order from ISSUED onwards. Three tables carry the rule, because
// three tables carry the order: the header, its lines, and its status history (a draft that
// is cancelled writes a DRAFT → CANCELLED row, which is the one case history exists for a
// row the supplier never saw). Lines and history have no status of their own, so they ask
// the header for it. That subquery is not a policy cycle: `purchase_orders`'s own policy
// references nothing, so nothing references back — the rule AGENTS.md states about
// `is_invited_supplier` does not apply here, and no SECURITY DEFINER seam is needed.
//
// The buyer's half of every policy is untouched: a buyer sees their own orders in every
// state, which is what a draft is for.
export class DraftOrdersAreBuyerPrivate1720000000045 implements MigrationInterface {
  name = 'DraftOrdersAreBuyerPrivate1720000000045';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`DROP POLICY purchase_orders_select ON purchase_orders`);
    await q.query(`
      CREATE POLICY purchase_orders_select ON purchase_orders FOR SELECT
        USING (buyer_org_id = app_org_id()
               OR (supplier_org_id = app_org_id() AND status <> 'DRAFT'))`);

    await q.query(`DROP POLICY purchase_order_items_select ON purchase_order_items`);
    await q.query(`
      CREATE POLICY purchase_order_items_select ON purchase_order_items FOR SELECT
        USING (buyer_org_id = app_org_id()
               OR (supplier_org_id = app_org_id()
                   AND EXISTS (SELECT 1 FROM purchase_orders p
                               WHERE p.id = po_id AND p.status <> 'DRAFT')))`);

    await q.query(`DROP POLICY po_hist_select ON po_status_history`);
    await q.query(`
      CREATE POLICY po_hist_select ON po_status_history FOR SELECT
        USING (buyer_org_id = app_org_id()
               OR (supplier_org_id = app_org_id()
                   AND EXISTS (SELECT 1 FROM purchase_orders p
                               WHERE p.id = po_id AND p.status <> 'DRAFT')))`);
  }

  // Back to both parties from creation — the state this migration exists to leave.
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP POLICY po_hist_select ON po_status_history`);
    await q.query(`
      CREATE POLICY po_hist_select ON po_status_history FOR SELECT
        USING (buyer_org_id = app_org_id() OR supplier_org_id = app_org_id())`);

    await q.query(`DROP POLICY purchase_order_items_select ON purchase_order_items`);
    await q.query(`
      CREATE POLICY purchase_order_items_select ON purchase_order_items FOR SELECT
        USING (buyer_org_id = app_org_id() OR supplier_org_id = app_org_id())`);

    await q.query(`DROP POLICY purchase_orders_select ON purchase_orders`);
    await q.query(`
      CREATE POLICY purchase_orders_select ON purchase_orders FOR SELECT
        USING (buyer_org_id = app_org_id() OR supplier_org_id = app_org_id())`);
  }
}
