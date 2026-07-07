import { MigrationInterface, QueryRunner } from 'typeorm';

// Procurement-integrity hardening (audit remediation):
//  - evaluation criteria are LOCKED on the event before bidding opens (no post-opening
//    re-weighting that could rig the outcome — UNCITRAL Art. 11);
//  - awards link to the evaluation, carry a justification, and are soft-cancellable
//    (a hard delete would orphan contracts.award_id ON DELETE SET NULL);
//  - bids can be disqualified with a documented reason;
//  - a DISPUTED invoice (failed 3-way match) can only be approved with an override reason
//    (rebuild invoice_set_status; drop the old 2-arg form so nothing bypasses it).
export class ProcurementIntegrity1720000000020 implements MigrationInterface {
  name = 'ProcurementIntegrity1720000000020';

  public async up(q: QueryRunner): Promise<void> {
    // 1) locked, published evaluation criteria (jsonb [{key, weight}], weights sum 100)
    await q.query(`ALTER TABLE sourcing_events ADD COLUMN evaluation_criteria jsonb`);

    // 2) evaluation per-lot seam (nullable now; event-level scoring still works)
    await q.query(`ALTER TABLE evaluation_scores ADD COLUMN lot_id uuid`);

    // 3) award ↔ evaluation link + justification + soft-cancel
    await q.query(`ALTER TABLE awards ADD COLUMN evaluation_id uuid REFERENCES evaluations(id)`);
    await q.query(`ALTER TABLE awards ADD COLUMN justification text`);
    await q.query(`ALTER TABLE awards ADD COLUMN cancelled_at timestamptz`);
    await q.query(`ALTER TABLE awards ADD COLUMN cancelled_by uuid`);
    await q.query(`ALTER TABLE awards ADD COLUMN cancel_reason text`);
    // one ACTIVE award per lot (cancelled ones stay for the audit trail)
    await q.query(`ALTER TABLE awards DROP CONSTRAINT IF EXISTS awards_event_id_lot_id_key`);
    await q.query(`CREATE UNIQUE INDEX awards_active_lot ON awards(event_id, lot_id) WHERE cancelled_at IS NULL`);

    // 4) disqualification reason
    await q.query(`ALTER TABLE bids ADD COLUMN disqualified_reason text`);

    // 5) invoice override reason + rebuilt status seam that requires it for a failed match
    await q.query(`ALTER TABLE invoices ADD COLUMN override_reason text`);
    await q.query(`DROP FUNCTION IF EXISTS invoice_set_status(uuid, invoice_status)`);
    await q.query(`
      CREATE OR REPLACE FUNCTION invoice_set_status(p_id uuid, p_to invoice_status, p_reason text DEFAULT NULL)
      RETURNS invoices LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE v_inv invoices; v_actor uuid := nullif(current_setting('app.org_id', true), '')::uuid; v_ok boolean;
      BEGIN
        SELECT * INTO v_inv FROM invoices WHERE id = p_id FOR UPDATE;
        IF v_inv.id IS NULL THEN RAISE EXCEPTION 'Invoice not found'; END IF;
        IF v_actor <> v_inv.buyer_org_id THEN RAISE EXCEPTION 'Only the buyer changes invoice status'; END IF;
        v_ok := (v_inv.status IN ('MATCHED','DISPUTED','SUBMITTED') AND p_to IN ('APPROVED','REJECTED'))
             OR (v_inv.status = 'APPROVED' AND p_to = 'PAID');
        IF NOT v_ok THEN RAISE EXCEPTION 'Illegal invoice transition % -> %', v_inv.status, p_to; END IF;
        -- a failed 3-way match may only be approved with a documented override
        IF v_inv.status = 'DISPUTED' AND p_to = 'APPROVED' AND (p_reason IS NULL OR length(trim(p_reason)) < 3) THEN
          RAISE EXCEPTION 'A DISPUTED invoice requires an override reason to approve';
        END IF;
        UPDATE invoices
          SET status = p_to,
              override_reason = CASE WHEN v_inv.status = 'DISPUTED' AND p_to = 'APPROVED' THEN p_reason ELSE override_reason END
          WHERE id = p_id RETURNING * INTO v_inv;
        RETURN v_inv;
      END $$`);

    await q.query(`INSERT INTO release_versions(version) VALUES ('1.7.0-integrity')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP FUNCTION IF EXISTS invoice_set_status(uuid, invoice_status, text)`);
    await q.query(`
      CREATE OR REPLACE FUNCTION invoice_set_status(p_id uuid, p_to invoice_status)
      RETURNS invoices LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE v_inv invoices; v_actor uuid := nullif(current_setting('app.org_id', true), '')::uuid; v_ok boolean;
      BEGIN
        SELECT * INTO v_inv FROM invoices WHERE id = p_id FOR UPDATE;
        IF v_inv.id IS NULL THEN RAISE EXCEPTION 'Invoice not found'; END IF;
        IF v_actor <> v_inv.buyer_org_id THEN RAISE EXCEPTION 'Only the buyer changes invoice status'; END IF;
        v_ok := (v_inv.status IN ('MATCHED','DISPUTED','SUBMITTED') AND p_to IN ('APPROVED','REJECTED'))
             OR (v_inv.status = 'APPROVED' AND p_to = 'PAID');
        IF NOT v_ok THEN RAISE EXCEPTION 'Illegal invoice transition % -> %', v_inv.status, p_to; END IF;
        UPDATE invoices SET status = p_to, updated_at = now() WHERE id = p_id RETURNING * INTO v_inv;
        RETURN v_inv;
      END $$`);
    await q.query(`ALTER TABLE invoices DROP COLUMN IF EXISTS override_reason`);
    await q.query(`ALTER TABLE bids DROP COLUMN IF EXISTS disqualified_reason`);
    await q.query(`DROP INDEX IF EXISTS awards_active_lot`);
    await q.query(`ALTER TABLE awards ADD CONSTRAINT awards_event_id_lot_id_key UNIQUE (event_id, lot_id)`);
    for (const c of ['cancel_reason', 'cancelled_by', 'cancelled_at', 'justification', 'evaluation_id']) {
      await q.query(`ALTER TABLE awards DROP COLUMN IF EXISTS ${c}`);
    }
    await q.query(`ALTER TABLE evaluation_scores DROP COLUMN IF EXISTS lot_id`);
    await q.query(`ALTER TABLE sourcing_events DROP COLUMN IF EXISTS evaluation_criteria`);
  }
}
