import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 2 block C: open-descending reverse auction + event Q&A/addenda.
//
// Auction design (per Codex phase-2 review):
// - auction_bids is an APPEND-ONLY ledger (accepted and rejected ticks alike);
//   the existing bids row is just the supplier's current-best cleartext snapshot.
// - Suppliers must see the anonymous best price but NOT each other's rows, so the
//   aggregate goes through SECURITY DEFINER auction_state() (ENABLE, not FORCE RLS —
//   same seam pattern as is_invited_supplier / po_apply_status).
// - Concurrency: bid submission locks the sourcing_events row FOR UPDATE first;
//   validation reads the best AFTER the lock, so decrement races cannot interleave.
// - Anti-sniping: a bid landing within extend_threshold of close_at pushes close_at
//   out by extend_by, capped by max_extensions.
//
// Q&A: suppliers ask (until qna_cutoff_at), buyer answers/publishes; published rows
// are disclosed equally to every supplier who can see the event; unpublished rows
// are visible only to the asker and the buyer.
export class AuctionQna1720000000004 implements MigrationInterface {
  name = 'AuctionQna1720000000004';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE sourcing_events
        ADD COLUMN auction_start_price_minor bigint,
        ADD COLUMN auction_min_decrement_minor bigint,
        ADD COLUMN auction_extend_threshold_sec int NOT NULL DEFAULT 120,
        ADD COLUMN auction_extend_by_sec int NOT NULL DEFAULT 120,
        ADD COLUMN auction_extension_count int NOT NULL DEFAULT 0,
        ADD COLUMN auction_max_extensions int NOT NULL DEFAULT 10,
        ADD COLUMN qna_cutoff_at timestamptz`);

    await q.query(`
      CREATE TABLE auction_bids (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id uuid NOT NULL REFERENCES sourcing_events(id) ON DELETE CASCADE,
        supplier_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        submitted_by uuid REFERENCES organization_users(id),
        total_minor bigint NOT NULL,
        currency char(3) NOT NULL DEFAULT 'AZN',
        payload jsonb NOT NULL DEFAULT '{}',
        accepted boolean NOT NULL DEFAULT false,
        rejected_reason text,
        idempotency_key text,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_auction_bids_event ON auction_bids(event_id, accepted, total_minor)`);
    await q.query(`
      CREATE UNIQUE INDEX uq_auction_bids_idem ON auction_bids(event_id, supplier_org_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL`);

    await q.query(`ALTER TABLE auction_bids ENABLE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY ab_select ON auction_bids FOR SELECT USING (
        supplier_org_id = app_org_id()
        OR EXISTS (SELECT 1 FROM sourcing_events e WHERE e.id = auction_bids.event_id AND e.buyer_org_id = app_org_id())
      )`);
    await q.query(`
      CREATE POLICY ab_insert ON auction_bids FOR INSERT
        WITH CHECK (supplier_org_id = app_org_id())`);

    // Anonymous aggregate for suppliers (bypasses ab_select via owner + no FORCE).
    await q.query(`
      CREATE FUNCTION auction_state(p_event_id uuid)
      RETURNS TABLE(best_total_minor bigint, accepted_count int, distinct_bidders int)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
      $$ SELECT min(total_minor), count(*)::int, count(DISTINCT supplier_org_id)::int
         FROM auction_bids WHERE event_id = p_event_id AND accepted $$`);

    // ---- Q&A rework ----
    await q.query(`
      ALTER TABLE event_qna
        ADD COLUMN kind text NOT NULL DEFAULT 'QUESTION',
        ADD COLUMN asked_by_user_id uuid,
        ADD COLUMN answered_by_user_id uuid,
        ADD COLUMN is_published boolean NOT NULL DEFAULT false,
        ADD COLUMN published_at timestamptz`);

    await q.query(`DROP POLICY event_qna_select ON event_qna`);
    await q.query(`DROP POLICY event_qna_modify ON event_qna`);
    await q.query(`
      CREATE POLICY event_qna_select ON event_qna FOR SELECT USING (
        EXISTS (SELECT 1 FROM sourcing_events e WHERE e.id = event_qna.event_id AND e.buyer_org_id = app_org_id())
        OR asked_by_org_id = app_org_id()
        OR (is_published AND EXISTS (SELECT 1 FROM sourcing_events e WHERE e.id = event_qna.event_id))
      )`);
    await q.query(`
      CREATE POLICY event_qna_buyer_all ON event_qna FOR ALL USING (
        EXISTS (SELECT 1 FROM sourcing_events e WHERE e.id = event_qna.event_id AND e.buyer_org_id = app_org_id())
      ) WITH CHECK (
        EXISTS (SELECT 1 FROM sourcing_events e WHERE e.id = event_qna.event_id AND e.buyer_org_id = app_org_id())
      )`);
    // Suppliers may insert their own question on any event they can see.
    await q.query(`
      CREATE POLICY event_qna_supplier_ask ON event_qna FOR INSERT WITH CHECK (
        asked_by_org_id = app_org_id()
        AND EXISTS (SELECT 1 FROM sourcing_events e WHERE e.id = event_qna.event_id)
      )`);

    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON auction_bids TO app_user`);
    await q.query(`INSERT INTO release_versions(version) VALUES ('1.2.0-auction-qna')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP FUNCTION IF EXISTS auction_state(uuid)`);
    await q.query(`DROP TABLE IF EXISTS auction_bids CASCADE`);
    await q.query(`ALTER TABLE event_qna
      DROP COLUMN IF EXISTS kind, DROP COLUMN IF EXISTS asked_by_user_id,
      DROP COLUMN IF EXISTS answered_by_user_id, DROP COLUMN IF EXISTS is_published,
      DROP COLUMN IF EXISTS published_at`);
    await q.query(`ALTER TABLE sourcing_events
      DROP COLUMN IF EXISTS auction_start_price_minor, DROP COLUMN IF EXISTS auction_min_decrement_minor,
      DROP COLUMN IF EXISTS auction_extend_threshold_sec, DROP COLUMN IF EXISTS auction_extend_by_sec,
      DROP COLUMN IF EXISTS auction_extension_count, DROP COLUMN IF EXISTS auction_max_extensions,
      DROP COLUMN IF EXISTS qna_cutoff_at`);
  }
}
