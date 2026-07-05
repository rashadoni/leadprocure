import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 3 (start): shipment tracking on a purchase order. Cross-org like POs —
// denormalized party columns, both sides read, the SUPPLIER owns write (they ship).
// Carrier API integrations (real tracking webhooks) are a later phase; the model and
// the manual timeline are the seam they plug into.
export class Logistics1720000000008 implements MigrationInterface {
  name = 'Logistics1720000000008';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TYPE shipment_status AS ENUM ('CREATED','PICKED_UP','IN_TRANSIT','CUSTOMS','ARRIVED','DELIVERED','EXCEPTION')`,
    );
    await q.query(`
      CREATE TABLE shipments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        po_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        buyer_org_id uuid NOT NULL,
        supplier_org_id uuid NOT NULL,
        carrier text,
        tracking_no text,
        status shipment_status NOT NULL DEFAULT 'CREATED',
        origin text,
        destination text,
        eta date,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (po_id)
      )`);
    await q.query(`
      CREATE TABLE shipment_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shipment_id uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
        buyer_org_id uuid NOT NULL,
        supplier_org_id uuid NOT NULL,
        status shipment_status NOT NULL,
        location text,
        note text,
        occurred_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_shipments_buyer ON shipments(buyer_org_id)`);
    await q.query(`CREATE INDEX idx_shipments_supplier ON shipments(supplier_org_id)`);
    await q.query(`CREATE INDEX idx_shipment_events_ship ON shipment_events(shipment_id)`);

    for (const t of ['shipments', 'shipment_events'] as const) {
      await q.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
      await q.query(`
        CREATE POLICY ${t}_select ON ${t} FOR SELECT
          USING (buyer_org_id = app_org_id() OR supplier_org_id = app_org_id())`);
      await q.query(`
        CREATE POLICY ${t}_modify ON ${t} FOR ALL
          USING (supplier_org_id = app_org_id())
          WITH CHECK (supplier_org_id = app_org_id())`);
    }
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON shipments, shipment_events TO app_user`);
    await q.query(`INSERT INTO release_versions(version) VALUES ('1.4.0-logistics')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS shipment_events CASCADE`);
    await q.query(`DROP TABLE IF EXISTS shipments CASCADE`);
    await q.query(`DROP TYPE IF EXISTS shipment_status`);
  }
}
