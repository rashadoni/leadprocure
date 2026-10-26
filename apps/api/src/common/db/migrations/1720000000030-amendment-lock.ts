import {MigrationInterface,QueryRunner} from 'typeorm';
export class AmendmentLock1720000000030 implements MigrationInterface {
 async up(q:QueryRunner){ await q.query(`      CREATE OR REPLACE FUNCTION po_amendment_decide(p_amendment_id uuid, p_accept boolean, p_note text DEFAULT NULL)
      RETURNS po_amendments LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE
        v_am po_amendments;
        v_po purchase_orders;
        v_actor uuid := nullif(current_setting('app.org_id', true), '')::uuid;
        v_user uuid := nullif(current_setting('app.actor_id', true), '')::uuid;
        v_ch jsonb;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(po_id::text,84)) FROM po_amendments WHERE id=p_amendment_id;
        SELECT * INTO v_am FROM po_amendments WHERE id = p_amendment_id FOR UPDATE;
        IF v_am.id IS NULL THEN RAISE EXCEPTION 'Amendment not found'; END IF;
        IF v_actor IS NULL OR v_actor <> v_am.supplier_org_id THEN
          RAISE EXCEPTION 'Only the supplier party decides an amendment';
        END IF;
        IF v_am.status <> 'PROPOSED' THEN RAISE EXCEPTION 'Amendment already decided'; END IF;

        SELECT * INTO v_po FROM purchase_orders WHERE id = v_am.po_id FOR UPDATE;
        IF v_po.status NOT IN ('ISSUED','CONFIRMED') THEN
          RAISE EXCEPTION 'PO is % — amendments only apply before fulfilment starts', v_po.status;
        END IF;
        IF EXISTS (SELECT 1 FROM goods_receipts WHERE po_id = v_po.id) THEN
          RAISE EXCEPTION 'Goods already received against this PO';
        END IF;

        IF p_accept THEN
          FOR v_ch IN SELECT * FROM jsonb_array_elements(v_am.changes) LOOP
            UPDATE purchase_order_items
              SET qty = (v_ch->>'newQty')::numeric,
                  unit_price_minor = (v_ch->>'newUnitPriceMinor')::bigint,
                  line_total_minor = round((v_ch->>'newQty')::numeric * (v_ch->>'newUnitPriceMinor')::bigint)
              WHERE id = (v_ch->>'poItemId')::uuid AND po_id = v_po.id;
          END LOOP;
          UPDATE purchase_orders
            SET total_minor = (SELECT COALESCE(sum(line_total_minor),0) FROM purchase_order_items WHERE po_id = v_po.id),
                updated_at = now()
            WHERE id = v_po.id;
          UPDATE po_amendments
            SET status = 'ACCEPTED', decided_by = v_user, decided_at = now(), decision_note = p_note
            WHERE id = p_amendment_id RETURNING * INTO v_am;
        ELSE
          UPDATE po_amendments
            SET status = 'REJECTED', decided_by = v_user, decided_at = now(), decision_note = p_note
            WHERE id = p_amendment_id RETURNING * INTO v_am;
        END IF;
        RETURN v_am;
      END $$`); }
 async down(){ throw new Error('Forward-only lock ordering'); }
}
