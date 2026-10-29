import { MigrationInterface, QueryRunner } from 'typeorm';

// Delivery confirmations outrank older progress/failure notifications. Applied
// migrations and existing logs stay intact; historical lost statuses cannot be inferred.
export class FollowupDeliveryProgress1720000000040 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE OR REPLACE FUNCTION followup_msg_set_status(p_provider_id text, p_status text)
      RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
      DECLARE n int; next_status text := upper(p_status);
      BEGIN
        IF p_provider_id IS NULL OR p_provider_id = '' OR next_status IS NULL
          OR next_status NOT IN ('SENT','DELIVERED','READ','FAILED') THEN RETURN 0; END IF;
        UPDATE followup_messages SET status=next_status
        WHERE provider_msg_id=p_provider_id AND channel='WHATSAPP'
          AND ((next_status='DELIVERED' AND status IN ('SENT','FAILED'))
            OR (next_status='READ' AND status IN ('SENT','DELIVERED','FAILED'))
            OR (next_status='FAILED' AND status='SENT'));
        GET DIAGNOSTICS n = ROW_COUNT;
        RETURN n;
      END $$`);
  }
  async down(): Promise<void> { throw new Error('Forward-only delivery progress protection'); }
}
