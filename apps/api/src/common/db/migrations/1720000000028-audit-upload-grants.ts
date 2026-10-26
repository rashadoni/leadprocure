import { MigrationInterface, QueryRunner } from 'typeorm';
export class AuditUploadGrants1720000000028 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`CREATE TABLE upload_grants (
      storage_key text PRIMARY KEY, owner_org_id uuid NOT NULL REFERENCES organizations(id),
      filename text NOT NULL, mime text NOT NULL, expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',
      consumed_at timestamptz);
      ALTER TABLE upload_grants ENABLE ROW LEVEL SECURITY;
      ALTER TABLE upload_grants FORCE ROW LEVEL SECURITY;
      CREATE POLICY upload_owner ON upload_grants USING(owner_org_id=app_org_id()) WITH CHECK(owner_org_id=app_org_id());
      GRANT SELECT, INSERT, UPDATE ON upload_grants TO app_user;
      ALTER TABLE supplier_verification_documents ADD COLUMN av_status text NOT NULL DEFAULT 'PENDING';`);
    await q.query(`CREATE FUNCTION supplier_is_blocked(p_buyer uuid, p_supplier uuid) RETURNS boolean
      LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
      SELECT EXISTS(SELECT 1 FROM supplier_relationships WHERE buyer_org_id=p_buyer AND supplier_org_id=p_supplier AND status='BLOCKED') $$`);
    await q.query(`CREATE OR REPLACE FUNCTION documents_pending_scan(p_limit int DEFAULT 5)
      RETURNS TABLE(src text,id uuid,storage_key text,owner_org uuid,filename text)
      LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
      SELECT src,id,storage_key,owner_org,filename FROM (
        SELECT 'doc'::text src,id,storage_key,owner_org_id owner_org,filename,created_at FROM documents WHERE av_status='PENDING'
        UNION ALL SELECT 'bid',id,storage_key,supplier_org_id,filename,created_at FROM bid_documents WHERE av_status='PENDING'
        UNION ALL SELECT 'kyc',id,storage_key,supplier_org_id,filename,created_at FROM supplier_verification_documents WHERE av_status='PENDING'
      ) pending ORDER BY created_at LIMIT p_limit $$`);
    await q.query(`CREATE OR REPLACE FUNCTION document_set_av_status(p_src text,p_id uuid,p_status text) RETURNS boolean
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE n int; BEGIN
      IF p_status NOT IN ('CLEAN','INFECTED','SKIPPED') THEN RAISE EXCEPTION 'Invalid verdict'; END IF;
      IF p_src='doc' THEN UPDATE documents SET av_status=p_status WHERE id=p_id AND av_status='PENDING';
      ELSIF p_src='bid' THEN UPDATE bid_documents SET av_status=p_status WHERE id=p_id AND av_status='PENDING';
      ELSIF p_src='kyc' THEN UPDATE supplier_verification_documents SET av_status=p_status WHERE id=p_id AND av_status='PENDING';
      ELSE RAISE EXCEPTION 'Invalid source'; END IF;
      GET DIAGNOSTICS n=ROW_COUNT; RETURN n>0; END $$`);
  }
  async down() { throw new Error('Forward-only security migration'); }
}
