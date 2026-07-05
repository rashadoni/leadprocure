import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 2 block D: per-buyer supplier scorecards (OTIF / quality / communication),
// optionally tied to a concrete PO. Buyer writes; the rated supplier may read its own.
export class Scorecards1720000000007 implements MigrationInterface {
  name = 'Scorecards1720000000007';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE supplier_scorecard_entries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        buyer_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        supplier_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        source_po_id uuid REFERENCES purchase_orders(id) ON DELETE SET NULL,
        metric text NOT NULL CHECK (metric IN ('OTIF','QUALITY','COMMS')),
        score int NOT NULL CHECK (score BETWEEN 0 AND 100),
        note text,
        created_by uuid REFERENCES organization_users(id),
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_scorecard_pair ON supplier_scorecard_entries(buyer_org_id, supplier_org_id)`);
    await q.query(`ALTER TABLE supplier_scorecard_entries ENABLE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY sce_select ON supplier_scorecard_entries FOR SELECT
        USING (buyer_org_id = app_org_id() OR supplier_org_id = app_org_id())`);
    await q.query(`
      CREATE POLICY sce_modify ON supplier_scorecard_entries FOR ALL
        USING (buyer_org_id = app_org_id()) WITH CHECK (buyer_org_id = app_org_id())`);
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON supplier_scorecard_entries TO app_user`);
    await q.query(`INSERT INTO release_versions(version) VALUES ('1.3.0-srm')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS supplier_scorecard_entries CASCADE`);
  }
}
