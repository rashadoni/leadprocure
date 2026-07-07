import { MigrationInterface, QueryRunner } from 'typeorm';

// Antivirus scan seams. Uploads are presigned (the API never sees the bytes), so scanning
// is asynchronous: a cron worker pulls PENDING files from storage and streams them to
// clamd. The worker runs outside any request context, where RLS shows it nothing —
// same problem the deadline scheduler has — so it goes through SECURITY DEFINER
// functions instead of raw table access (established seam pattern: close_due_events).
export class AvScanSeams1720000000022 implements MigrationInterface {
  name = 'AvScanSeams1720000000022';

  public async up(q: QueryRunner): Promise<void> {
    // Pending files across both attachment tables; src tells the worker which one.
    await q.query(`
      CREATE OR REPLACE FUNCTION documents_pending_scan(p_limit int DEFAULT 5)
      RETURNS TABLE (src text, id uuid, storage_key text, owner_org uuid, filename text)
      LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
        SELECT p.src, p.id, p.storage_key, p.owner_org, p.filename FROM (
          SELECT 'doc'::text, d.id, d.storage_key, d.owner_org_id, d.filename, d.created_at
          FROM documents d WHERE d.av_status = 'PENDING'
          UNION ALL
          SELECT 'bid'::text, b.id, b.storage_key, b.supplier_org_id, b.filename, b.created_at
          FROM bid_documents b WHERE b.av_status = 'PENDING'
        ) p(src, id, storage_key, owner_org, filename, created_at)
        ORDER BY p.created_at LIMIT p_limit
      $$`);

    // Verdict write: only PENDING rows may transition (idempotent under worker overlap).
    await q.query(`
      CREATE OR REPLACE FUNCTION document_set_av_status(p_src text, p_id uuid, p_status text)
      RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE v_n int;
      BEGIN
        -- SKIPPED = deliberately not scanned (e.g. beyond clamd's stream size limit)
        IF p_status NOT IN ('CLEAN','INFECTED','SKIPPED') THEN RAISE EXCEPTION 'Bad AV status %', p_status; END IF;
        IF p_src = 'doc' THEN
          UPDATE documents SET av_status = p_status WHERE id = p_id AND av_status = 'PENDING';
        ELSIF p_src = 'bid' THEN
          UPDATE bid_documents SET av_status = p_status WHERE id = p_id AND av_status = 'PENDING';
        ELSE
          RAISE EXCEPTION 'Bad AV source %', p_src;
        END IF;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        RETURN v_n > 0;
      END $$`);

    await q.query(`INSERT INTO release_versions(version) VALUES ('1.9.0-av-scan')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP FUNCTION IF EXISTS document_set_av_status(text, uuid, text)`);
    await q.query(`DROP FUNCTION IF EXISTS documents_pending_scan(int)`);
  }
}
