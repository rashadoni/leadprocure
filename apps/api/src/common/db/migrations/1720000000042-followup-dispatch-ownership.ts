import { MigrationInterface, QueryRunner } from 'typeorm';

// Each dispatch owns an opaque lease; manual reconciliation may reset attempts,
// so an attempt counter alone cannot fence an old worker from a new dispatch.
export class FollowupDispatchOwnership1720000000042 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE followup_outbox ADD COLUMN lease_token uuid`);
    await q.query(`CREATE OR REPLACE FUNCTION followup_claim_outbox() RETURNS SETOF followup_outbox
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE w record; recipient text; BEGIN
      -- Unknown delivery after process death must never be blindly replayed (SMTP/Meta lack universal idempotency).
      WITH stale AS (UPDATE followup_outbox SET status='UNKNOWN',lease_until=NULL,lease_token=NULL
        WHERE status='SENDING' AND lease_until<clock_timestamp() RETURNING *)
      INSERT INTO followup_messages(enrollment_id,buyer_org_id,supplier_org_id,step_no,channel,recipient,status,detail)
        SELECT s.enrollment_id,s.buyer_org_id,fe.supplier_org_id,s.step_no,s.work->>'channel',s.recipient,'UNKNOWN','Worker lease expired; reconcile before retry'
        FROM stale s JOIN followup_enrollments fe ON fe.id=s.enrollment_id;
      FOR w IN SELECT * FROM followup_advance_due(50) LOOP
        FOREACH recipient IN ARRAY (CASE WHEN w.channel='EMAIL' THEN COALESCE(w.emails,ARRAY['-']) ELSE ARRAY[COALESCE(w.phone,'-')] END) LOOP
          INSERT INTO followup_outbox(enrollment_id,buyer_org_id,step_no,recipient,work)
            VALUES(w.enrollment_id,w.buyer_org_id,w.step_no,recipient,to_jsonb(w)) ON CONFLICT DO NOTHING;
        END LOOP;
      END LOOP;
      RETURN QUERY WITH candidates AS (SELECT id FROM followup_outbox WHERE status='PENDING' AND (lease_until IS NULL OR lease_until<=clock_timestamp()) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        UPDATE followup_outbox o SET status='SENDING',attempts=attempts+1,lease_until=clock_timestamp()+interval '5 minutes',lease_token=gen_random_uuid()
        FROM candidates c WHERE o.id=c.id RETURNING o.*;
      END $$`);
    await q.query(`CREATE FUNCTION followup_job_has_confirmation(p_job uuid) RETURNS boolean
      LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
      SELECT EXISTS(SELECT 1 FROM followup_outbox o JOIN followup_messages m ON
        m.enrollment_id=o.enrollment_id AND m.step_no=o.step_no AND m.recipient=o.recipient
        WHERE o.id=p_job AND o.work->>'channel'='WHATSAPP' AND m.channel='WHATSAPP'
          AND m.provider_msg_id IS NOT NULL AND m.status IN ('SENT','DELIVERED','READ')) $$`);
    await q.query(`CREATE FUNCTION followup_dispatch_allowed(p_job uuid,p_lease uuid) RETURNS boolean
      LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
      SELECT EXISTS(SELECT 1 FROM followup_outbox o JOIN followup_enrollments fe ON fe.id=o.enrollment_id
        JOIN sourcing_events e ON e.id=fe.event_id WHERE o.id=p_job AND o.status='SENDING'
        AND p_lease IS NOT NULL AND o.lease_token=p_lease AND o.lease_until>clock_timestamp()
        AND fe.status IN ('ACTIVE','EXHAUSTED') AND e.status='OPEN' AND e.close_at>clock_timestamp()
        AND NOT followup_job_has_confirmation(o.id)
        AND NOT EXISTS(SELECT 1 FROM bids b WHERE b.event_id=e.id AND b.supplier_org_id=fe.supplier_org_id AND b.state<>'WITHDRAWN')) $$`);
    await q.query(`CREATE FUNCTION followup_finish_outbox(p_job uuid,p_status text,p_detail text,p_provider text,p_lease uuid)
      RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
      DECLARE o followup_outbox;
      BEGIN
        IF p_status IS NULL OR p_status NOT IN ('SENT','UNKNOWN','FAILED','SKIPPED','NOT_CONFIGURED','SIMULATED','CANCELLED') THEN
          RAISE EXCEPTION 'Invalid outbox state'; END IF;
        SELECT * INTO o FROM followup_outbox WHERE id=p_job FOR UPDATE;
        IF o.id IS NULL THEN RETURN false; END IF;
        IF o.status<>'SENDING' OR p_lease IS NULL OR o.lease_token IS DISTINCT FROM p_lease THEN
          -- A late known provider response is still factual history, but it must
          -- never finish another worker's lease or erase a manual decision.
          IF p_lease IS NOT NULL AND p_provider IS NOT NULL AND p_provider<>''
            AND o.work->>'channel'='WHATSAPP' AND p_status IN ('SENT','UNKNOWN') THEN
            PERFORM pg_advisory_xact_lock(hashtextextended(p_provider,86));
            IF NOT EXISTS(SELECT 1 FROM followup_messages WHERE enrollment_id=o.enrollment_id
              AND step_no=o.step_no AND recipient=o.recipient AND provider_msg_id=p_provider) THEN
              PERFORM followup_log_message_ex(o.enrollment_id,o.step_no,o.work->>'channel',o.recipient,p_status,
                'Late dispatch completion: '||COALESCE(p_detail,''),p_provider);
            END IF;
          END IF;
          RETURN false;
        END IF;
        UPDATE followup_outbox SET status=CASE WHEN p_status='FAILED' AND attempts<3 THEN 'PENDING' ELSE p_status END,
          lease_until=CASE WHEN p_status='FAILED' AND attempts<3 THEN clock_timestamp()+interval '1 minute' ELSE NULL END,
          lease_token=NULL WHERE id=p_job;
        PERFORM followup_log_message_ex(o.enrollment_id,o.step_no,o.work->>'channel',o.recipient,p_status,p_detail,p_provider);
        RETURN true;
      END $$`);
    // Unfenced legacy entrypoints must never authorize or complete a dispatch.
    await q.query(`CREATE OR REPLACE FUNCTION followup_dispatch_allowed(p_job uuid) RETURNS boolean
      LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$ SELECT false $$`);
    await q.query(`CREATE OR REPLACE FUNCTION followup_finish_outbox(p_job uuid,p_status text,p_detail text,p_provider text DEFAULT NULL)
      RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ BEGIN RETURN; END $$`);
    await q.query(`CREATE OR REPLACE FUNCTION followup_reconcile_outbox(p_id uuid,p_decision text,p_reason text) RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE o followup_outbox; BEGIN
      IF COALESCE(current_setting('app.role',true),'') NOT IN ('BUYER_ADMIN','BUYER_APPROVER')
        OR p_reason IS NULL OR length(trim(p_reason))<10 THEN RAISE EXCEPTION 'Reviewer and explanation required'; END IF;
      SELECT * INTO o FROM followup_outbox WHERE id=p_id AND buyer_org_id=app_org_id() FOR UPDATE;
      IF o.id IS NULL OR o.status NOT IN ('UNKNOWN','FAILED','NOT_CONFIGURED') THEN RAISE EXCEPTION 'Job unavailable for reconciliation'; END IF;
      IF p_decision='CONFIRMED_SENT' THEN
        UPDATE followup_outbox SET status='CONFIRMED_SENT',lease_token=NULL,lease_until=NULL WHERE id=p_id;
      ELSIF p_decision='CONFIRMED_NOT_SENT' THEN
        IF followup_job_has_confirmation(p_id) THEN RAISE EXCEPTION 'Confirmed provider delivery cannot be requeued'; END IF;
        UPDATE followup_outbox SET status='PENDING',attempts=0,lease_until=NULL,lease_token=NULL WHERE id=p_id;
      ELSE RAISE EXCEPTION 'Invalid decision'; END IF;
      PERFORM followup_log_message_ex(o.enrollment_id,o.step_no,o.work->>'channel',o.recipient,p_decision,p_reason,NULL);
      END $$`);
  }
  async down(): Promise<void> { throw new Error('Forward-only dispatch ownership and delivery evidence'); }
}
