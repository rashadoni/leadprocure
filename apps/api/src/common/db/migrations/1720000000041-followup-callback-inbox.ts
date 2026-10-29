import { MigrationInterface, QueryRunner } from 'typeorm';

// A callback can arrive before the sender records the provider ID. Keep only the
// authenticated provider ID/status until that row exists; never retain raw payloads.
export class FollowupCallbackInbox1720000000041 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE whatsapp_delivery_receipts (
      provider_msg_id text PRIMARY KEY,
      status text NOT NULL CHECK(status IN ('SENT','DELIVERED','READ','FAILED')),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
      ALTER TABLE whatsapp_delivery_receipts ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON whatsapp_delivery_receipts FROM PUBLIC,app_user`);
    await q.query(`CREATE FUNCTION followup_delivery_merge(p_current text,p_incoming text)
      RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT CASE
        WHEN 'READ' IN (p_current,p_incoming) THEN 'READ'
        WHEN 'DELIVERED' IN (p_current,p_incoming) THEN 'DELIVERED'
        WHEN 'FAILED' IN (p_current,p_incoming) THEN 'FAILED'
        WHEN 'SENT' IN (p_current,p_incoming) THEN 'SENT'
        ELSE COALESCE(p_current,p_incoming) END $$`);
    await q.query(`CREATE OR REPLACE FUNCTION followup_msg_set_status(p_provider_id text,p_status text)
      RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
      DECLARE n int; confirmed text; next_status text := upper(p_status);
      BEGIN
        IF p_provider_id IS NULL OR p_provider_id='' OR next_status IS NULL
          OR next_status NOT IN ('SENT','DELIVERED','READ','FAILED') THEN RETURN 0; END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended(p_provider_id,86));
        INSERT INTO whatsapp_delivery_receipts(provider_msg_id,status) VALUES(p_provider_id,next_status)
          ON CONFLICT(provider_msg_id) DO UPDATE SET
            status=followup_delivery_merge(whatsapp_delivery_receipts.status,EXCLUDED.status),
            updated_at=clock_timestamp()
          RETURNING status INTO confirmed;
        UPDATE followup_messages SET status=followup_delivery_merge(status,confirmed)
          WHERE provider_msg_id=p_provider_id AND channel='WHATSAPP'
            AND status IS DISTINCT FROM followup_delivery_merge(status,confirmed);
        GET DIAGNOSTICS n = ROW_COUNT;
        RETURN n;
      END $$`);
    await q.query(`CREATE OR REPLACE FUNCTION followup_log_message_ex(p_enrollment uuid,p_step int,p_channel text,
      p_recipient text,p_status text,p_detail text,p_provider_id text)
      RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
      DECLARE confirmed text; resolved text := p_status;
      BEGIN
        IF p_channel='WHATSAPP' AND p_provider_id IS NOT NULL AND p_provider_id<>'' THEN
          PERFORM pg_advisory_xact_lock(hashtextextended(p_provider_id,86));
          SELECT status INTO confirmed FROM whatsapp_delivery_receipts WHERE provider_msg_id=p_provider_id;
          resolved := followup_delivery_merge(p_status,confirmed);
        END IF;
        INSERT INTO followup_messages(enrollment_id,buyer_org_id,supplier_org_id,step_no,channel,recipient,status,detail,provider_msg_id)
          SELECT fe.id,fe.buyer_org_id,fe.supplier_org_id,p_step,p_channel,p_recipient,resolved,p_detail,p_provider_id
          FROM followup_enrollments fe WHERE fe.id=p_enrollment;
      END $$`);
  }
  async down(): Promise<void> { throw new Error('Forward-only authenticated callback history'); }
}
