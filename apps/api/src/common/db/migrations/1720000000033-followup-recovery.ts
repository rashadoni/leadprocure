import {MigrationInterface,QueryRunner} from 'typeorm';
export class FollowupRecovery1720000000033 implements MigrationInterface {
 async up(q:QueryRunner){
  await q.query(`CREATE OR REPLACE FUNCTION followup_advance_due(max_rows int DEFAULT 50)
      RETURNS TABLE(
        enrollment_id uuid, event_id uuid, buyer_org_id uuid, supplier_org_id uuid,
        step_no int, channel text, event_title text, buyer_name text,
        close_at timestamptz, emails text[], phone text
      )
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE
        r record;
        step jsonb;
        nxt jsonb;
      BEGIN
        FOR r IN
          SELECT fe.id AS fe_id, fe.event_id AS fe_event, fe.buyer_org_id AS fe_buyer,
                 fe.supplier_org_id AS fe_supplier, fe.steps AS fe_steps, fe.current_step AS fe_step,
                 e.status AS ev_status, e.title AS ev_title, e.close_at AS ev_close
          FROM followup_enrollments fe
          JOIN sourcing_events e ON e.id = fe.event_id
          WHERE fe.status = 'ACTIVE' AND fe.next_run_at IS NOT NULL AND fe.next_run_at <= now()
          ORDER BY fe.next_run_at
          LIMIT max_rows
          FOR UPDATE OF fe SKIP LOCKED
        LOOP
          -- stop: supplier already responded
          IF EXISTS (SELECT 1 FROM bids b WHERE b.event_id = r.fe_event
                       AND b.supplier_org_id = r.fe_supplier AND b.state <> 'WITHDRAWN') THEN
            UPDATE followup_enrollments SET status='RESPONDED', next_run_at=NULL, updated_at=now() WHERE id = r.fe_id;
            CONTINUE;
          END IF;
          -- stop: bidding is over
          IF r.ev_status NOT IN ('PUBLISHED','OPEN') OR r.ev_close<=clock_timestamp() THEN
            UPDATE followup_enrollments SET status='EVENT_CLOSED', next_run_at=NULL, updated_at=now() WHERE id = r.fe_id;
            CONTINUE;
          END IF;
          step := r.fe_steps -> r.fe_step;
          IF step IS NULL THEN
            UPDATE followup_enrollments SET status='EXHAUSTED', next_run_at=NULL, updated_at=now() WHERE id = r.fe_id;
            CONTINUE;
          END IF;
          nxt := r.fe_steps -> (r.fe_step + 1);
          UPDATE followup_enrollments
             SET current_step = r.fe_step + 1,
                 next_run_at = CASE WHEN nxt IS NULL THEN NULL
                                    ELSE now() + make_interval(hours => (nxt->>'afterHours')::int) END,
                 status = CASE WHEN nxt IS NULL THEN 'EXHAUSTED' ELSE 'ACTIVE' END,
                 updated_at = now()
           WHERE id = r.fe_id;
          INSERT INTO audit_events(actor_id, org_id, action, entity_type, entity_id, payload, prev_hash, hash)
          VALUES (NULL, NULL, 'FOLLOWUP_STEP_SCHEDULED', 'followup_enrollment', r.fe_id,
                  jsonb_build_object('event_id', r.fe_event, 'supplier_org_id', r.fe_supplier,
                                     'step_no', r.fe_step, 'channel', step->>'channel'),
                  NULL, md5(r.fe_id::text || clock_timestamp()::text));
          enrollment_id := r.fe_id; event_id := r.fe_event; buyer_org_id := r.fe_buyer;
          supplier_org_id := r.fe_supplier; step_no := r.fe_step;
          channel := step->>'channel'; event_title := r.ev_title; close_at := r.ev_close;
          SELECT ob.legal_name INTO buyer_name FROM organizations ob WHERE ob.id = r.fe_buyer;
          SELECT array_agg(u.email) INTO emails
            FROM organization_users u JOIN memberships m ON m.user_id = u.id
           WHERE m.org_id = r.fe_supplier AND u.status = 'ACTIVE';
          SELECT o.phone INTO phone FROM organizations o WHERE o.id = r.fe_supplier;
          RETURN NEXT;
        END LOOP;
      END $$`);
  await q.query(`CREATE OR REPLACE FUNCTION followup_claim_outbox() RETURNS SETOF followup_outbox
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE w record; recipient text; BEGIN
      -- Unknown delivery after process death must never be blindly replayed (SMTP/Meta lack universal idempotency).
      WITH stale AS (UPDATE followup_outbox SET status='UNKNOWN',lease_until=NULL
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
      RETURN QUERY WITH candidates AS (SELECT id FROM followup_outbox WHERE status='PENDING' AND (lease_until IS NULL OR lease_until<=clock_timestamp()) ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED)
        UPDATE followup_outbox o SET status='SENDING',attempts=attempts+1,lease_until=clock_timestamp()+interval '5 minutes'
        FROM candidates c WHERE o.id=c.id RETURNING o.*;
      END $$`);
  await q.query(`CREATE OR REPLACE FUNCTION followup_finish_outbox(p_job uuid,p_status text,p_detail text,p_provider text DEFAULT NULL) RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE o followup_outbox; BEGIN
      IF p_status NOT IN ('SENT','UNKNOWN','FAILED','SKIPPED','NOT_CONFIGURED','SIMULATED','CANCELLED') THEN RAISE EXCEPTION 'Invalid outbox state'; END IF;
      SELECT * INTO o FROM followup_outbox WHERE id=p_job AND status='SENDING' FOR UPDATE;
      IF o.id IS NULL THEN RETURN; END IF;
      UPDATE followup_outbox SET status=CASE WHEN p_status='FAILED' AND attempts<3 THEN 'PENDING' ELSE p_status END,
        lease_until=CASE WHEN p_status='FAILED' AND attempts<3 THEN clock_timestamp()+interval '1 minute' ELSE NULL END WHERE id=p_job;
      PERFORM followup_log_message_ex(o.enrollment_id,o.step_no,o.work->>'channel',o.recipient,p_status,p_detail,p_provider);
      END $$`);
  await q.query(`CREATE FUNCTION followup_reconcile_outbox(p_id uuid,p_decision text,p_reason text) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE o followup_outbox; BEGIN
 IF current_setting('app.role',true) NOT IN ('BUYER_ADMIN','BUYER_APPROVER') OR length(trim(p_reason))<10 THEN RAISE EXCEPTION 'Reviewer and explanation required'; END IF;
 SELECT * INTO o FROM followup_outbox WHERE id=p_id AND buyer_org_id=app_org_id() FOR UPDATE;
 IF o.id IS NULL OR o.status NOT IN ('UNKNOWN','FAILED','NOT_CONFIGURED') THEN RAISE EXCEPTION 'Job unavailable for reconciliation'; END IF;
 IF p_decision='CONFIRMED_SENT' THEN
   UPDATE followup_outbox SET status='CONFIRMED_SENT' WHERE id=p_id;
 ELSIF p_decision='CONFIRMED_NOT_SENT' THEN
   UPDATE followup_outbox SET status='PENDING',attempts=0,lease_until=NULL WHERE id=p_id;
 ELSE RAISE EXCEPTION 'Invalid decision'; END IF;
 PERFORM followup_log_message_ex(o.enrollment_id,o.step_no,o.work->>'channel',o.recipient,p_decision,p_reason,NULL);
 END $$`);
 }
 async down(){throw new Error('Forward-only delivery reconciliation');}
}
