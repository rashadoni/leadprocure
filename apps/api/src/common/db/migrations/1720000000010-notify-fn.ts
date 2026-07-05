import { MigrationInterface, QueryRunner } from 'typeorm';

// Cross-org notifications: an actor must be able to notify the COUNTERPARTY org (e.g.
// buyer awards → notify the winning supplier), but notifications RLS only lets an org
// insert rows for itself. This owner-owned SECURITY DEFINER function is the sanctioned
// seam — same pattern as po_apply_status / auction_try_extend.
export class NotifyFn1720000000010 implements MigrationInterface {
  name = 'NotifyFn1720000000010';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE FUNCTION app_notify(p_org uuid, p_user uuid, p_type text, p_payload jsonb)
      RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
        INSERT INTO notifications(recipient_org_id, recipient_user_id, type, payload, delivered_at)
        VALUES (p_org, p_user, p_type, p_payload, now());
      $$`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP FUNCTION IF EXISTS app_notify(uuid, uuid, text, jsonb)`);
  }
}
