import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 2 block A: contracts + purchase orders ("Заказы в работе").
//
// RLS design (per Codex phase-2 review): POs are CROSS-ORG documents. Both party ids
// are DENORMALIZED onto every row (buyer_org_id + supplier_org_id) so policies compare
// columns directly — no joins through awards/bids/events, hence no policy recursion
// and no accidental leakage. Suppliers never get direct UPDATE on purchase_orders:
// every status transition goes through the SECURITY DEFINER po_apply_status(), which
// validates the actor's side and legal transition, updates the PO and appends history
// in one step. Tables the function touches are ENABLE (not FORCE) RLS — same pattern
// as event_invitations (app_user stays fully constrained; owner-owned function works).
export class ContractsOrders1720000000003 implements MigrationInterface {
  name = 'ContractsOrders1720000000003';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TYPE contract_status AS ENUM ('DRAFT','ACTIVE','CLOSED','CANCELLED')`);
    await q.query(
      `CREATE TYPE po_status AS ENUM ('DRAFT','ISSUED','CONFIRMED','PACKED','SHIPPED','DELIVERED','ACCEPTED','REJECTED','CANCELLED')`,
    );

    await q.query(`
      CREATE TABLE contracts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        buyer_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        supplier_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        event_id uuid REFERENCES sourcing_events(id) ON DELETE SET NULL,
        award_id uuid REFERENCES awards(id) ON DELETE SET NULL,
        contract_no text NOT NULL,
        title text NOT NULL,
        total_minor bigint NOT NULL DEFAULT 0,
        currency char(3) NOT NULL DEFAULT 'AZN',
        vat_mode vat_mode NOT NULL DEFAULT 'EXCLUSIVE',
        status contract_status NOT NULL DEFAULT 'DRAFT',
        valid_from date,
        valid_to date,
        created_by uuid NOT NULL REFERENCES organization_users(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (buyer_org_id, contract_no)
      )`);

    await q.query(`
      CREATE TABLE purchase_orders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        contract_id uuid REFERENCES contracts(id) ON DELETE SET NULL,
        buyer_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        supplier_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        po_no text NOT NULL,
        status po_status NOT NULL DEFAULT 'DRAFT',
        total_minor bigint NOT NULL DEFAULT 0,
        currency char(3) NOT NULL DEFAULT 'AZN',
        note text,
        issued_at timestamptz,
        created_by uuid NOT NULL REFERENCES organization_users(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (buyer_org_id, po_no)
      )`);

    await q.query(`
      CREATE TABLE purchase_order_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        po_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        buyer_org_id uuid NOT NULL,
        supplier_org_id uuid NOT NULL,
        event_item_id uuid REFERENCES event_items(id) ON DELETE SET NULL,
        line_no int NOT NULL,
        name text NOT NULL,
        qty numeric NOT NULL DEFAULT 1,
        uom text NOT NULL DEFAULT 'pcs',
        unit_price_minor bigint NOT NULL DEFAULT 0,
        line_total_minor bigint NOT NULL DEFAULT 0,
        vat_rate_bp int NOT NULL DEFAULT 1800
      )`);

    await q.query(`
      CREATE TABLE po_status_history (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        po_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        buyer_org_id uuid NOT NULL,
        supplier_org_id uuid NOT NULL,
        from_status po_status,
        to_status po_status NOT NULL,
        actor_org_id uuid NOT NULL,
        actor_user_id uuid,
        note text,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);

    await q.query(`CREATE INDEX idx_contracts_buyer ON contracts(buyer_org_id)`);
    await q.query(`CREATE INDEX idx_contracts_supplier ON contracts(supplier_org_id)`);
    await q.query(`CREATE INDEX idx_pos_buyer ON purchase_orders(buyer_org_id, status)`);
    await q.query(`CREATE INDEX idx_pos_supplier ON purchase_orders(supplier_org_id, status)`);
    await q.query(`CREATE INDEX idx_po_items_po ON purchase_order_items(po_id)`);
    await q.query(`CREATE INDEX idx_po_history_po ON po_status_history(po_id)`);

    // --- RLS: both parties read; only the buyer writes headers/items directly ---
    for (const t of ['contracts', 'purchase_orders', 'purchase_order_items'] as const) {
      await q.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
      await q.query(`
        CREATE POLICY ${t}_select ON ${t} FOR SELECT
          USING (buyer_org_id = app_org_id() OR supplier_org_id = app_org_id())`);
      await q.query(`
        CREATE POLICY ${t}_modify ON ${t} FOR ALL
          USING (buyer_org_id = app_org_id())
          WITH CHECK (buyer_org_id = app_org_id())`);
    }
    await q.query(`ALTER TABLE po_status_history ENABLE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY po_hist_select ON po_status_history FOR SELECT
        USING (buyer_org_id = app_org_id() OR supplier_org_id = app_org_id())`);
    // History rows are written ONLY by po_apply_status() (owner), never by app_user.

    // --- the single sanctioned status-transition seam ---
    await q.query(`
      CREATE FUNCTION po_apply_status(p_po_id uuid, p_to po_status, p_note text DEFAULT NULL)
      RETURNS purchase_orders LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE
        v_po purchase_orders;
        v_actor uuid := nullif(current_setting('app.org_id', true), '')::uuid;
        v_user uuid := nullif(current_setting('app.actor_id', true), '')::uuid;
        v_ok boolean := false;
      BEGIN
        SELECT * INTO v_po FROM purchase_orders WHERE id = p_po_id FOR UPDATE;
        IF v_po.id IS NULL THEN RAISE EXCEPTION 'PO not found'; END IF;
        IF v_actor IS NULL THEN RAISE EXCEPTION 'No org context'; END IF;

        -- buyer transitions
        IF v_actor = v_po.buyer_org_id THEN
          v_ok := (v_po.status = 'DRAFT'     AND p_to = 'ISSUED')
               OR (v_po.status = 'DELIVERED' AND p_to IN ('ACCEPTED','REJECTED'))
               OR (v_po.status IN ('DRAFT','ISSUED') AND p_to = 'CANCELLED');
        -- supplier transitions
        ELSIF v_actor = v_po.supplier_org_id THEN
          v_ok := (v_po.status = 'ISSUED'    AND p_to = 'CONFIRMED')
               OR (v_po.status = 'CONFIRMED' AND p_to = 'PACKED')
               OR (v_po.status = 'PACKED'    AND p_to = 'SHIPPED')
               OR (v_po.status = 'SHIPPED'   AND p_to = 'DELIVERED');
        ELSE
          RAISE EXCEPTION 'Not a party to this PO';
        END IF;
        IF NOT v_ok THEN
          RAISE EXCEPTION 'Illegal transition % -> % for this actor', v_po.status, p_to;
        END IF;

        UPDATE purchase_orders
          SET status = p_to,
              issued_at = CASE WHEN p_to = 'ISSUED' THEN now() ELSE issued_at END,
              updated_at = now()
          WHERE id = p_po_id
          RETURNING * INTO v_po;
        INSERT INTO po_status_history(po_id, buyer_org_id, supplier_org_id, from_status, to_status,
                                      actor_org_id, actor_user_id, note)
          VALUES (p_po_id, v_po.buyer_org_id, v_po.supplier_org_id,
                  (SELECT h.to_status FROM po_status_history h WHERE h.po_id = p_po_id
                   ORDER BY h.created_at DESC LIMIT 1),
                  p_to, v_actor, v_user, p_note);
        RETURN v_po;
      END $$`);

    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON contracts, purchase_orders, purchase_order_items TO app_user`);
    await q.query(`GRANT SELECT ON po_status_history TO app_user`);
    await q.query(`INSERT INTO release_versions(version) VALUES ('1.1.0-contracts')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP FUNCTION IF EXISTS po_apply_status(uuid, po_status, text)`);
    for (const t of ['po_status_history', 'purchase_order_items', 'purchase_orders', 'contracts']) {
      await q.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
    }
    await q.query(`DROP TYPE IF EXISTS po_status`);
    await q.query(`DROP TYPE IF EXISTS contract_status`);
  }
}
