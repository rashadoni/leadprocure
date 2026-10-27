import { MigrationInterface, QueryRunner } from 'typeorm';
export class FollowupOutbox1720000000031 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`CREATE TABLE followup_outbox (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),enrollment_id uuid NOT NULL REFERENCES followup_enrollments(id),
      buyer_org_id uuid NOT NULL,step_no int NOT NULL,recipient text NOT NULL,work jsonb NOT NULL,
      status text NOT NULL DEFAULT 'PENDING',attempts int NOT NULL DEFAULT 0,lease_until timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(enrollment_id,step_no,recipient));
      ALTER TABLE followup_outbox ENABLE ROW LEVEL SECURITY;
      CREATE POLICY followup_outbox_read ON followup_outbox FOR SELECT USING(buyer_org_id=app_org_id());
      REVOKE INSERT,UPDATE,DELETE ON followup_outbox FROM app_user;
      GRANT SELECT ON followup_outbox TO app_user;`);
    await q.query(`CREATE FUNCTION followup_claim_outbox() RETURNS SETOF followup_outbox
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE w record; recipient text; BEGIN
      -- Unknown delivery after process death must never be blindly replayed (SMTP/Meta lack universal idempotency).
      UPDATE followup_outbox SET status='UNKNOWN' WHERE status='SENDING' AND lease_until<clock_timestamp();
      FOR w IN SELECT * FROM followup_advance_due(50) LOOP
        FOREACH recipient IN ARRAY (CASE WHEN w.channel='EMAIL' THEN COALESCE(w.emails,ARRAY['-']) ELSE ARRAY[COALESCE(w.phone,'-')] END) LOOP
          INSERT INTO followup_outbox(enrollment_id,buyer_org_id,step_no,recipient,work)
            VALUES(w.enrollment_id,w.buyer_org_id,w.step_no,recipient,to_jsonb(w)) ON CONFLICT DO NOTHING;
        END LOOP;
      END LOOP;
      RETURN QUERY WITH candidates AS (SELECT id FROM followup_outbox WHERE status='PENDING' ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED)
        UPDATE followup_outbox o SET status='SENDING',attempts=attempts+1,lease_until=clock_timestamp()+interval '5 minutes'
        FROM candidates c WHERE o.id=c.id RETURNING o.*;
      END $$`);
    await q.query(`CREATE FUNCTION followup_dispatch_allowed(p_job uuid) RETURNS boolean
      LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
      SELECT EXISTS(SELECT 1 FROM followup_outbox o JOIN followup_enrollments fe ON fe.id=o.enrollment_id
        JOIN sourcing_events e ON e.id=fe.event_id WHERE o.id=p_job AND o.status='SENDING'
        AND fe.status IN ('ACTIVE','EXHAUSTED') AND e.status='OPEN' AND e.close_at>clock_timestamp()
        AND NOT EXISTS(SELECT 1 FROM bids b WHERE b.event_id=e.id AND b.supplier_org_id=fe.supplier_org_id AND b.state<>'WITHDRAWN')) $$`);
    await q.query(`CREATE FUNCTION followup_finish_outbox(p_job uuid,p_status text,p_detail text,p_provider text DEFAULT NULL) RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE o followup_outbox; BEGIN
      IF p_status NOT IN ('SENT','UNKNOWN','FAILED','SKIPPED','NOT_CONFIGURED','SIMULATED','CANCELLED') THEN RAISE EXCEPTION 'Invalid outbox state'; END IF;
      SELECT * INTO o FROM followup_outbox WHERE id=p_job AND status='SENDING' FOR UPDATE;
      IF o.id IS NULL THEN RETURN; END IF;
      UPDATE followup_outbox SET status=p_status,lease_until=NULL WHERE id=p_job;
      PERFORM followup_log_message_ex(o.enrollment_id,o.step_no,o.work->>'channel',o.recipient,p_status,p_detail,p_provider);
      END $$`);
  }
  async down() { throw new Error('Forward-only delivery history'); }
}
