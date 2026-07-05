import { MigrationInterface, QueryRunner } from 'typeorm';

// Group 2 — digital catalogs with an agreed-price matrix. A buyer keeps contracted
// items at fixed prices (often seeded from an awarded bid) and re-orders instantly
// without a new tender. Cross-org: both parties read, the BUYER maintains it.
export class Catalogs1720000000014 implements MigrationInterface {
  name = 'Catalogs1720000000014';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TYPE catalog_status AS ENUM ('DRAFT','ACTIVE','ARCHIVED')`);
    await q.query(`
      CREATE TABLE catalogs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        buyer_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        supplier_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        contract_id uuid REFERENCES contracts(id) ON DELETE SET NULL,
        title text NOT NULL,
        currency char(3) NOT NULL DEFAULT 'AZN',
        status catalog_status NOT NULL DEFAULT 'DRAFT',
        valid_from date,
        valid_to date,
        created_by uuid REFERENCES organization_users(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE TABLE catalog_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        catalog_id uuid NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
        buyer_org_id uuid NOT NULL,
        supplier_org_id uuid NOT NULL,
        name text NOT NULL,
        sku text,
        uom text NOT NULL DEFAULT 'pcs',
        unit_price_minor bigint NOT NULL DEFAULT 0,
        vat_rate_bp int NOT NULL DEFAULT 1800,
        moq numeric NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_catalogs_buyer ON catalogs(buyer_org_id)`);
    await q.query(`CREATE INDEX idx_catalog_items_cat ON catalog_items(catalog_id)`);

    for (const t of ['catalogs', 'catalog_items'] as const) {
      await q.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
      await q.query(`
        CREATE POLICY ${t}_select ON ${t} FOR SELECT
          USING (buyer_org_id = app_org_id() OR supplier_org_id = app_org_id())`);
      await q.query(`
        CREATE POLICY ${t}_modify ON ${t} FOR ALL
          USING (buyer_org_id = app_org_id()) WITH CHECK (buyer_org_id = app_org_id())`);
    }
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON catalogs, catalog_items TO app_user`);
    await q.query(`INSERT INTO release_versions(version) VALUES ('2.0.0-catalogs')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS catalog_items CASCADE`);
    await q.query(`DROP TABLE IF EXISTS catalogs CASCADE`);
    await q.query(`DROP TYPE IF EXISTS catalog_status`);
  }
}
