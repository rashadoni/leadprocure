import { MigrationInterface, QueryRunner } from 'typeorm';

// PO amendments (change orders): the buyer proposes per-line qty/price changes to an
// ISSUED/CONFIRMED order; the supplier accepts or rejects. Cross-org recipe: both org ids
// denormalized, SELECT = either party, INSERT = buyer (owning party), and the supplier's
// decision — a counterparty write that must atomically mutate PO lines + total — goes
// through the SECURITY DEFINER po_amendment_decide() seam (the po_apply_status pattern).
// `changes` snapshots old AND new values per line, so history stays readable even after
// the PO rows have been mutated by acceptance.
export class PoAmendments1720000000019 implements MigrationInterface {
  name = 'PoAmendments1720000000019';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TYPE po_amendment_status AS ENUM ('PROPOSED','ACCEPTED','REJECTED')`);
    await q.query(`
      CREATE TABLE po_amendments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        po_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        buyer_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        supplier_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        amendment_no int NOT NULL,
        status po_amendment_status NOT NULL DEFAULT 'PROPOSED',
        reason text NOT NULL,
        changes jsonb NOT NULL,        -- [{poItemId,name,oldQty,newQty,oldUnitPriceMinor,newUnitPriceMinor}]
        old_total_minor bigint NOT NULL,
        new_total_minor bigint NOT NULL,
        created_by uuid,
        decided_by uuid,
        decided_at timestamptz,
        decision_note text,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (po_id, amendment_no)
      )`);
    // one pending amendment per PO
    await q.query(`CREATE UNIQUE INDEX po_amendments_one_pending ON po_amendments(po_id) WHERE status = 'PROPOSED'`);

    await q.query(`ALTER TABLE po_amendments ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE po_amendments FORCE ROW LEVEL SECURITY`);
    // both parties read; only the buyer writes rows; the supplier decision goes via DEFINER
    await q.query(`
      CREATE POLICY po_amend_select ON po_amendments FOR SELECT
        USING (buyer_org_id = app_org_id() OR supplier_org_id = app_org_id())`);
    await q.query(`
      CREATE POLICY po_amend_insert ON po_amendments FOR INSERT
        WITH CHECK (buyer_org_id = app_org_id())`);

    await q.query(`
      CREATE FUNCTION po_amendment_decide(p_amendment_id uuid, p_accept boolean, p_note text DEFAULT NULL)
      RETURNS po_amendments LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE
        v_am po_amendments;
        v_po purchase_orders;
        v_actor uuid := nullif(current_setting('app.org_id', true), '')::uuid;
        v_user uuid := nullif(current_setting('app.actor_id', true), '')::uuid;
        v_ch jsonb;
      BEGIN
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
      END $$`);

    await q.query(`GRANT SELECT, INSERT ON po_amendments TO app_user`);
    await q.query(`INSERT INTO release_versions(version) VALUES ('1.6.0-po-amendments')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP FUNCTION IF EXISTS po_amendment_decide(uuid, boolean, text)`);
    await q.query(`DROP TABLE IF EXISTS po_amendments CASCADE`);
    await q.query(`DROP TYPE IF EXISTS po_amendment_status`);
  }
}
