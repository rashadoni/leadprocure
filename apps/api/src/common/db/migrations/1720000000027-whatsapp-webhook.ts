import { MigrationInterface, QueryRunner } from 'typeorm';

// Meta WhatsApp delivery-status webhook plumbing:
//  1) store the provider message id (wamid) on each sent follow-up message so an inbound
//     status callback can be matched back to the exact reminder;
//  2) DEFINER seams the webhook (public, no request context, no app.org_id) uses to update
//     the log status and to verify the Meta handshake token against any org's config.
export class WhatsappWebhook1720000000027 implements MigrationInterface {
  name = 'WhatsappWebhook1720000000027';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE followup_messages ADD COLUMN provider_msg_id text`);
    await q.query(`CREATE INDEX followup_messages_wamid ON followup_messages (provider_msg_id) WHERE provider_msg_id IS NOT NULL`);

    // Log-with-provider-id: same as followup_log_message but records the wamid so the
    // webhook can later flip SENT → DELIVERED → READ (or FAILED) for that row.
    await q.query(`
      CREATE FUNCTION followup_log_message_ex(p_enrollment uuid, p_step int, p_channel text,
        p_recipient text, p_status text, p_detail text, p_provider_id text)
      RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
        INSERT INTO followup_messages(enrollment_id, buyer_org_id, supplier_org_id, step_no, channel, recipient, status, detail, provider_msg_id)
        SELECT fe.id, fe.buyer_org_id, fe.supplier_org_id, p_step, p_channel, p_recipient, p_status, p_detail, p_provider_id
        FROM followup_enrollments fe WHERE fe.id = p_enrollment
      $$`);

    // Webhook status update, keyed by the globally-unique wamid (no org context needed).
    await q.query(`
      CREATE FUNCTION followup_msg_set_status(p_provider_id text, p_status text)
      RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE n int;
      BEGIN
        UPDATE followup_messages SET status = upper(p_status)
        WHERE provider_msg_id = p_provider_id;
        GET DIAGNOSTICS n = ROW_COUNT;
        RETURN n;
      END $$`);

    // Handshake check: does any org's WhatsApp config carry this verify token?
    await q.query(`
      CREATE FUNCTION whatsapp_verify_token_ok(p_token text)
      RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
        SELECT EXISTS (
          SELECT 1 FROM channel_connections
          WHERE channel = 'WHATSAPP' AND config->>'verifyToken' = p_token AND p_token <> ''
        )
      $$`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP FUNCTION IF EXISTS whatsapp_verify_token_ok(text)`);
    await q.query(`DROP FUNCTION IF EXISTS followup_msg_set_status(text, text)`);
    await q.query(`DROP FUNCTION IF EXISTS followup_log_message_ex(uuid, int, text, text, text, text, text)`);
    await q.query(`DROP INDEX IF EXISTS followup_messages_wamid`);
    await q.query(`ALTER TABLE followup_messages DROP COLUMN IF EXISTS provider_msg_id`);
  }
}
