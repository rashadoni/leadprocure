import { MigrationInterface, QueryRunner } from 'typeorm';

// Group 3 — supplier verification (KYC). The buyer opens a case; the supplier uploads
// compliance documents (VÖEN, licence, bank, insurance); the buyer reviews and decides.
// Cross-org: both parties read. The buyer owns/decides the CASE (normal RLS), the
// supplier owns the DOCUMENTS (normal RLS) — no DEFINER needed since each party only
// writes rows it owns. On APPROVED the case promotes the supplier_relationship.
export class SupplierVerification1720000000015 implements MigrationInterface {
  name = 'SupplierVerification1720000000015';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TYPE verification_status AS ENUM ('NEW','IN_REVIEW','APPROVED','REJECTED')`);
    await q.query(`
      CREATE TABLE supplier_verification_cases (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        buyer_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        supplier_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        status verification_status NOT NULL DEFAULT 'NEW',
        review_notes text,
        reviewed_by uuid REFERENCES organization_users(id),
        reviewed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (buyer_org_id, supplier_org_id)
      )`);
    await q.query(`
      CREATE TABLE supplier_verification_documents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        case_id uuid NOT NULL REFERENCES supplier_verification_cases(id) ON DELETE CASCADE,
        buyer_org_id uuid NOT NULL,
        supplier_org_id uuid NOT NULL,
        doc_type text NOT NULL CHECK (doc_type IN ('VOEN','LICENSE','BANK','INSURANCE','OTHER')),
        storage_key text NOT NULL,
        filename text NOT NULL,
        sha256 text NOT NULL,
        status text NOT NULL DEFAULT 'PENDING',
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_ver_cases_buyer ON supplier_verification_cases(buyer_org_id)`);
    await q.query(`CREATE INDEX idx_ver_cases_supplier ON supplier_verification_cases(supplier_org_id)`);
    await q.query(`CREATE INDEX idx_ver_docs_case ON supplier_verification_documents(case_id)`);

    // cases: both read; only the BUYER writes/decides
    await q.query(`ALTER TABLE supplier_verification_cases ENABLE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY svc_select ON supplier_verification_cases FOR SELECT
        USING (buyer_org_id = app_org_id() OR supplier_org_id = app_org_id())`);
    await q.query(`
      CREATE POLICY svc_modify ON supplier_verification_cases FOR ALL
        USING (buyer_org_id = app_org_id()) WITH CHECK (buyer_org_id = app_org_id())`);

    // documents: both read; only the SUPPLIER writes (uploads)
    await q.query(`ALTER TABLE supplier_verification_documents ENABLE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY svd_select ON supplier_verification_documents FOR SELECT
        USING (buyer_org_id = app_org_id() OR supplier_org_id = app_org_id())`);
    await q.query(`
      CREATE POLICY svd_modify ON supplier_verification_documents FOR ALL
        USING (supplier_org_id = app_org_id()) WITH CHECK (supplier_org_id = app_org_id())`);

    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON supplier_verification_cases, supplier_verification_documents TO app_user`);
    await q.query(`INSERT INTO release_versions(version) VALUES ('2.1.0-kyc')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS supplier_verification_documents CASCADE`);
    await q.query(`DROP TABLE IF EXISTS supplier_verification_cases CASCADE`);
    await q.query(`DROP TYPE IF EXISTS verification_status`);
  }
}
