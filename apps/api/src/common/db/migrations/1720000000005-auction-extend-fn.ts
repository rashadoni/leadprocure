import { MigrationInterface, QueryRunner } from 'typeorm';

// Suppliers cannot FOR UPDATE or UPDATE sourcing_events (se_modify is buyer-only, and
// under RLS a locking read must pass UPDATE policies too). The bid path therefore:
//   1) serializes per event with pg_advisory_xact_lock (role-agnostic), and
//   2) extends the deadline through this SECURITY DEFINER seam.
export class AuctionExtendFn1720000000005 implements MigrationInterface {
  name = 'AuctionExtendFn1720000000005';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE FUNCTION auction_try_extend(p_event_id uuid) RETURNS boolean
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE v_ext boolean := false;
      BEGIN
        UPDATE sourcing_events e
          SET close_at = now() + make_interval(secs => e.auction_extend_by_sec),
              auction_extension_count = e.auction_extension_count + 1,
              updated_at = now()
        WHERE e.id = p_event_id
          AND e.status = 'OPEN'
          AND e.format = 'REVERSE'
          AND e.close_at - now() < make_interval(secs => e.auction_extend_threshold_sec)
          AND e.auction_extension_count < e.auction_max_extensions;
        v_ext := FOUND;
        RETURN v_ext;
      END $$`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP FUNCTION IF EXISTS auction_try_extend(uuid)`);
  }
}
