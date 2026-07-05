import { MigrationInterface, QueryRunner } from 'typeorm';

// Operational plumbing for the sealed-RFQ lifecycle:
// 1) close_due_events(): SECURITY DEFINER — the deadline scheduler runs with no request
//    context (no app.org_id), so it cannot pass RLS as app_user. The owner-owned function
//    is the sanctioned seam: it closes due events and appends system audit rows (org NULL).
// 2) Opening-ceremony policies: the BUYER writes decrypted amounts into bids/bid_items,
//    but those tables are supplier-owned under RLS. Allow buyer writes ONLY while their
//    own event is in OPENING/EVALUATION.
export class SourcingOps1720000000002 implements MigrationInterface {
  name = 'SourcingOps1720000000002';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE FUNCTION close_due_events() RETURNS TABLE(event_id uuid, buyer_org_id uuid)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        RETURN QUERY
        WITH closed AS (
          UPDATE sourcing_events e SET status = 'CLOSED', updated_at = now()
          WHERE e.status = 'OPEN' AND e.close_at IS NOT NULL AND e.close_at <= now()
          RETURNING e.id, e.buyer_org_id AS borg
        ), audited AS (
          INSERT INTO audit_events(actor_id, org_id, action, entity_type, entity_id, payload, prev_hash, hash)
          SELECT NULL, NULL, 'EVENT_CLOSED', 'sourcing_event', c.id,
                 jsonb_build_object('buyer_org_id', c.borg, 'closed_at', now()),
                 NULL, md5(c.id::text || clock_timestamp()::text)
          FROM closed c
          RETURNING 1
        )
        SELECT c.id, c.borg FROM closed c;
      END $$`);

    await q.query(`
      CREATE POLICY bids_buyer_ceremony ON bids FOR UPDATE
        USING (EXISTS (SELECT 1 FROM sourcing_events e
                       WHERE e.id = bids.event_id AND e.buyer_org_id = app_org_id()
                         AND e.status IN ('OPENING','EVALUATION')))
        WITH CHECK (EXISTS (SELECT 1 FROM sourcing_events e
                            WHERE e.id = bids.event_id AND e.buyer_org_id = app_org_id()
                              AND e.status IN ('OPENING','EVALUATION')))`);

    await q.query(`
      CREATE POLICY bid_items_buyer_opening ON bid_items FOR INSERT
        WITH CHECK (EXISTS (SELECT 1 FROM bids b JOIN sourcing_events e ON e.id = b.event_id
                            WHERE b.id = bid_items.bid_id AND e.buyer_org_id = app_org_id()
                              AND e.status = 'OPENING'))`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP POLICY IF EXISTS bid_items_buyer_opening ON bid_items`);
    await q.query(`DROP POLICY IF EXISTS bids_buyer_ceremony ON bids`);
    await q.query(`DROP FUNCTION IF EXISTS close_due_events()`);
  }
}
