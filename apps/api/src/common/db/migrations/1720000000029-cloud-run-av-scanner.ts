import { MigrationInterface, QueryRunner } from 'typeorm';

function applicationRole(): string {
  const role = process.env.DATABASE_APP_ROLE || 'app_user';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(role)) {
    throw new Error('DATABASE_APP_ROLE must be a valid PostgreSQL role name');
  }
  return `"${role}"`;
}

// Extends the asynchronous antivirus seam to every object-storage upload path.
// The scanner uses only these SECURITY DEFINER functions through the non-owner
// application connection; direct table access remains subject to RLS.
export class CloudRunAvScanner1720000000029 implements MigrationInterface {
  name = 'CloudRunAvScanner1720000000029';

  public async up(q: QueryRunner): Promise<void> {
    const appRole = applicationRole();

    await q.query(`ALTER TABLE supplier_verification_documents ADD COLUMN mime text NOT NULL DEFAULT 'application/octet-stream'`);
    await q.query(`ALTER TABLE supplier_verification_documents ADD COLUMN size_bytes bigint NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE supplier_verification_documents ADD COLUMN av_status text NOT NULL DEFAULT 'SKIPPED'`);

    // PostgreSQL cannot CREATE OR REPLACE a function when OUT parameters change.
    await q.query(`DROP FUNCTION documents_pending_scan(int)`);
    await q.query(`
      CREATE OR REPLACE FUNCTION documents_pending_scan(p_limit int DEFAULT 100)
      RETURNS TABLE (
        src text, id uuid, storage_key text, owner_org uuid, filename text,
        size_bytes bigint, sha256 text
      ) LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
        SELECT p.src, p.id, p.storage_key, p.owner_org, p.filename, p.size_bytes, p.sha256
        FROM (
          SELECT 'doc'::text, d.id, d.storage_key, d.owner_org_id, d.filename,
                 d.size_bytes, d.sha256, d.created_at
          FROM documents d WHERE d.av_status = 'PENDING'
          UNION ALL
          SELECT 'bid'::text, b.id, b.storage_key, b.supplier_org_id, b.filename,
                 b.size_bytes, b.sha256, b.created_at
          FROM bid_documents b WHERE b.av_status = 'PENDING'
          UNION ALL
          SELECT 'verification'::text, v.id, v.storage_key, v.supplier_org_id, v.filename,
                 v.size_bytes, v.sha256, v.created_at
          FROM supplier_verification_documents v WHERE v.av_status = 'PENDING'
        ) p(src, id, storage_key, owner_org, filename, size_bytes, sha256, created_at)
        ORDER BY p.created_at LIMIT GREATEST(1, LEAST(p_limit, 500))
      $$`);

    await q.query(`
      CREATE OR REPLACE FUNCTION document_set_av_status(p_src text, p_id uuid, p_status text)
      RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE v_n int;
      BEGIN
        IF p_status NOT IN ('CLEAN','INFECTED','SKIPPED','ERROR') THEN
          RAISE EXCEPTION 'Bad AV status %', p_status;
        END IF;
        IF p_src = 'doc' THEN
          UPDATE documents SET av_status = p_status WHERE id = p_id AND av_status = 'PENDING';
        ELSIF p_src = 'bid' THEN
          UPDATE bid_documents SET av_status = p_status WHERE id = p_id AND av_status = 'PENDING';
        ELSIF p_src = 'verification' THEN
          UPDATE supplier_verification_documents SET av_status = p_status
          WHERE id = p_id AND av_status = 'PENDING';
        ELSE
          RAISE EXCEPTION 'Bad AV source %', p_src;
        END IF;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        RETURN v_n > 0;
      END $$`);

    await q.query(`REVOKE ALL ON FUNCTION documents_pending_scan(int) FROM PUBLIC`);
    await q.query(`REVOKE ALL ON FUNCTION document_set_av_status(text, uuid, text) FROM PUBLIC`);
    await q.query(`GRANT EXECUTE ON FUNCTION documents_pending_scan(int) TO ${appRole}`);
    await q.query(`GRANT EXECUTE ON FUNCTION document_set_av_status(text, uuid, text) TO ${appRole}`);
    await q.query(`INSERT INTO release_versions(version) VALUES ('2.9.0-cloud-run-av-scanner')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    const appRole = applicationRole();

    await q.query(`DELETE FROM release_versions WHERE version = '2.9.0-cloud-run-av-scanner'`);
    await q.query(`DROP FUNCTION documents_pending_scan(int)`);
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
    await q.query(`
      CREATE OR REPLACE FUNCTION document_set_av_status(p_src text, p_id uuid, p_status text)
      RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE v_n int;
      BEGIN
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
    await q.query(`REVOKE ALL ON FUNCTION documents_pending_scan(int) FROM PUBLIC`);
    await q.query(`REVOKE ALL ON FUNCTION document_set_av_status(text, uuid, text) FROM PUBLIC`);
    await q.query(`GRANT EXECUTE ON FUNCTION documents_pending_scan(int) TO ${appRole}`);
    await q.query(`GRANT EXECUTE ON FUNCTION document_set_av_status(text, uuid, text) TO ${appRole}`);

    await q.query(`ALTER TABLE supplier_verification_documents DROP COLUMN av_status`);
    await q.query(`ALTER TABLE supplier_verification_documents DROP COLUMN size_bytes`);
    await q.query(`ALTER TABLE supplier_verification_documents DROP COLUMN mime`);
  }
}
