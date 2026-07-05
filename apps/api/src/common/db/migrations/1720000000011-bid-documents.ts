import { MigrationInterface, QueryRunner } from 'typeorm';

// Cross-org bid attachments (Group 1a). Same secrecy gate as bid_items: the supplier
// who owns the bid can always read/write its docs; the buyer can read them only once
// the event has reached the opening ceremony (OPENING/EVALUATION/AWARDED). Parties are
// denormalized so the policies never join through another RLS table's policy.
export class BidDocuments1720000000011 implements MigrationInterface {
  name = 'BidDocuments1720000000011';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE bid_documents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        bid_id uuid NOT NULL REFERENCES bids(id) ON DELETE CASCADE,
        buyer_org_id uuid NOT NULL,
        supplier_org_id uuid NOT NULL,
        storage_key text NOT NULL,
        filename text NOT NULL,
        mime text NOT NULL,
        size_bytes bigint NOT NULL DEFAULT 0,
        sha256 text NOT NULL,
        av_status text NOT NULL DEFAULT 'SKIPPED',
        created_by uuid REFERENCES organization_users(id),
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_bid_docs_bid ON bid_documents(bid_id)`);
    await q.query(`ALTER TABLE bid_documents ENABLE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY bid_docs_select ON bid_documents FOR SELECT USING (
        supplier_org_id = app_org_id()
        OR EXISTS (SELECT 1 FROM bids b JOIN sourcing_events e ON e.id = b.event_id
                   WHERE b.id = bid_documents.bid_id AND e.buyer_org_id = app_org_id()
                     AND e.status IN ('OPENING','EVALUATION','AWARDED'))
      )`);
    await q.query(`
      CREATE POLICY bid_docs_write ON bid_documents FOR ALL
        USING (supplier_org_id = app_org_id())
        WITH CHECK (supplier_org_id = app_org_id())`);
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON bid_documents TO app_user`);
    await q.query(`INSERT INTO release_versions(version) VALUES ('1.6.0-bid-docs')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS bid_documents CASCADE`);
  }
}
