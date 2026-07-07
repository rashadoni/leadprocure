import { MigrationInterface, QueryRunner } from 'typeorm';

// Race-free document numbering. REQ/PO/CTR/INV numbers were minted with count(*)+1, so two
// concurrent creates in the same org computed the same number — one then hit the per-org
// UNIQUE (…_no) constraint and 500'd. Replace with a per-(org, doc_type) atomic counter
// allocated by a SECURITY DEFINER function (single upsert → no race, no direct table grant).
export class DocumentCounters1720000000021 implements MigrationInterface {
  name = 'DocumentCounters1720000000021';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE document_counters (
        owner_org_id uuid NOT NULL,
        doc_type text NOT NULL,
        next_no bigint NOT NULL DEFAULT 0,
        PRIMARY KEY (owner_org_id, doc_type)
      )`);

    // Seed each org's counter from its current row count so numbering continues unbroken
    // (the old scheme's next number was that org's count(*) + 1).
    await q.query(`INSERT INTO document_counters(owner_org_id, doc_type, next_no)
      SELECT owner_org_id, 'REQ', count(*) FROM procurement_requests GROUP BY owner_org_id
      ON CONFLICT DO NOTHING`);
    await q.query(`INSERT INTO document_counters(owner_org_id, doc_type, next_no)
      SELECT buyer_org_id, 'PO', count(*) FROM purchase_orders GROUP BY buyer_org_id
      ON CONFLICT DO NOTHING`);
    await q.query(`INSERT INTO document_counters(owner_org_id, doc_type, next_no)
      SELECT buyer_org_id, 'CTR', count(*) FROM contracts GROUP BY buyer_org_id
      ON CONFLICT DO NOTHING`);
    await q.query(`INSERT INTO document_counters(owner_org_id, doc_type, next_no)
      SELECT supplier_org_id, 'INV', count(*) FROM invoices GROUP BY supplier_org_id
      ON CONFLICT DO NOTHING`);

    // Atomic allocation: one statement increments and returns, so concurrent callers serialize
    // on the row lock and each gets a distinct number.
    await q.query(`
      CREATE OR REPLACE FUNCTION next_document_no(p_org uuid, p_type text)
      RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE v bigint;
      BEGIN
        INSERT INTO document_counters(owner_org_id, doc_type, next_no) VALUES (p_org, p_type, 1)
        ON CONFLICT (owner_org_id, doc_type) DO UPDATE SET next_no = document_counters.next_no + 1
        RETURNING next_no INTO v;
        RETURN v;
      END $$`);

    await q.query(`INSERT INTO release_versions(version) VALUES ('1.8.0-doc-counters')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP FUNCTION IF EXISTS next_document_no(uuid, text)`);
    await q.query(`DROP TABLE IF EXISTS document_counters`);
  }
}
