import { MigrationInterface, QueryRunner } from 'typeorm';

// Per-buyer-org sending channels (Email/SMTP + WhatsApp gateway) — so a buyer connects
// their own mailbox / WhatsApp number for the follow-up reminders instead of relying on
// the global env config. Buyer-private table (RLS by app_org_id). The follow-up ticker
// runs with no request context, so it reads the (secret-bearing) config through the
// owner-owned SECURITY DEFINER getter channel_config_get() — same seam pattern as
// followup_advance_due / close_due_events.
export class Channels1720000000026 implements MigrationInterface {
  name = 'Channels1720000000026';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE channel_connections (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        buyer_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        channel text NOT NULL CHECK (channel IN ('EMAIL','WHATSAPP')),
        config jsonb NOT NULL DEFAULT '{}',   -- non-secret + secret fields; secrets never returned to client
        is_active boolean NOT NULL DEFAULT true,
        last_test_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (buyer_org_id, channel)
      )`);
    await q.query(`ALTER TABLE channel_connections ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE channel_connections FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY channel_connections_rls ON channel_connections
        USING (buyer_org_id = app_org_id())
        WITH CHECK (buyer_org_id = app_org_id())`);

    // Cron seam: the follow-up ticker (no request context) fetches an org's active
    // channel config here. DEFINER → bypasses RLS; returns NULL when unconfigured so
    // the sender falls back to the global env provider.
    await q.query(`
      CREATE FUNCTION channel_config_get(p_org uuid, p_channel text)
      RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
        SELECT config FROM channel_connections
        WHERE buyer_org_id = p_org AND channel = p_channel AND is_active = true
      $$`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP FUNCTION IF EXISTS channel_config_get(uuid, text)`);
    await q.query(`DROP TABLE IF EXISTS channel_connections`);
  }
}
