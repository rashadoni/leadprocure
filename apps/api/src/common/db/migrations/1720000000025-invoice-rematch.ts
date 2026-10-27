import { MigrationInterface, QueryRunner } from 'typeorm';

// Fix: the 3-way match was a snapshot frozen at invoice submit — an invoice submitted
// before the goods receipt stayed DISPUTED forever even after everything was received,
// forcing a manual override-approve. Recording a GRN now re-runs the match for every
// still-open invoice of that PO. A SECURITY DEFINER seam because the BUYER records
// receipts but invoices are supplier-owned rows (RLS), and the invoice_set_status
// transition matrix deliberately has no DISPUTED→MATCHED edge for app callers.
export class InvoiceRematch1720000000025 implements MigrationInterface {
  name = 'InvoiceRematch1720000000025';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE FUNCTION invoice_rematch(p_po uuid)
      RETURNS TABLE(invoice_id uuid, invoice_no text, supplier_org_id uuid, old_status text, new_status text)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE
        v_inv record;
        v_lines jsonb;
        v_ok boolean;
        v_new invoice_status;
      BEGIN
        FOR v_inv IN
          SELECT i.id, i.invoice_no, i.supplier_org_id, i.status
          FROM invoices i
          WHERE i.po_id = p_po AND i.status IN ('SUBMITTED','MATCHED','DISPUTED')
          FOR UPDATE
        LOOP
          -- Same rules as submit(): price capped by the PO line, qty capped by what was
          -- received minus what OTHER non-rejected invoices already billed (draw-down).
          SELECT
            jsonb_agg(jsonb_build_object(
              'po_item_id', s.po_item_id,
              'invoice_qty', s.inv_qty, 'invoice_price', s.inv_price, 'po_price', s.po_price,
              'received', s.received, 'already_invoiced', s.invoiced_others,
              'billable', s.received - s.invoiced_others,
              'price_ok', s.inv_price <= s.po_price,
              'qty_ok', s.inv_qty <= s.received - s.invoiced_others)),
            bool_and(s.inv_price <= s.po_price AND s.inv_qty <= s.received - s.invoiced_others)
          INTO v_lines, v_ok
          FROM (
            SELECT ii.po_item_id,
                   ii.qty::numeric AS inv_qty,
                   ii.unit_price_minor::numeric AS inv_price,
                   poi.unit_price_minor::numeric AS po_price,
                   COALESCE((SELECT sum(gri.qty_received) FROM goods_receipt_items gri
                             WHERE gri.po_item_id = ii.po_item_id), 0) AS received,
                   COALESCE((SELECT sum(x.qty) FROM invoice_items x
                             JOIN invoices ix ON ix.id = x.invoice_id
                             WHERE x.po_item_id = ii.po_item_id
                               AND ix.status <> 'REJECTED' AND ix.id <> v_inv.id), 0) AS invoiced_others
            FROM invoice_items ii
            JOIN purchase_order_items poi ON poi.id = ii.po_item_id
            WHERE ii.invoice_id = v_inv.id
          ) s;

          v_ok := COALESCE(v_ok, false);
          v_new := CASE WHEN v_ok THEN 'MATCHED' ELSE 'DISPUTED' END::invoice_status;
          UPDATE invoices
             SET match = jsonb_build_object('ok', v_ok, 'lines', COALESCE(v_lines, '[]'::jsonb)),
                 status = v_new
           WHERE id = v_inv.id;

          IF v_new::text <> v_inv.status::text THEN
            invoice_id := v_inv.id; invoice_no := v_inv.invoice_no;
            supplier_org_id := v_inv.supplier_org_id;
            old_status := v_inv.status::text; new_status := v_new::text;
            RETURN NEXT;
          END IF;
        END LOOP;
      END $$`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP FUNCTION IF EXISTS invoice_rematch(uuid)`);
  }
}
