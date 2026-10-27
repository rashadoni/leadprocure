import { MigrationInterface, QueryRunner } from 'typeorm';

// Outreach follow-up chains: after publishing an event the buyer enrolls invited
// suppliers into a reminder sequence (email → email → WhatsApp …) that advances on a
// cron ticker and stops the moment the supplier responds (submits a bid) or the event
// leaves the bidding stage. The ticker runs with no request context, so every state
// transition goes through owner-owned SECURITY DEFINER functions (established seam:
// close_due_events). followup_enrollments / followup_messages are therefore NOT
// FORCE-RLS: the owner-run seam must be able to touch them, while app_user stays
// fully policy-scoped.
export class Followups1720000000024 implements MigrationInterface {
  name = 'Followups1720000000024';

  public async up(q: QueryRunner): Promise<void> {
    // WhatsApp needs a phone number; organizations never had one. Optional E.164.
    await q.query(`ALTER TABLE organizations ADD COLUMN phone text`);

    // Per-org chain definition (v1: one plan per buyer org; absent = code default).
    await q.query(`
      CREATE TABLE followup_plans (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        buyer_org_id uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
        steps jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`ALTER TABLE followup_plans ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE followup_plans FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY followup_plans_rls ON followup_plans
        USING (buyer_org_id = app_org_id())
        WITH CHECK (buyer_org_id = app_org_id())`);

    // One chain instance per (event, supplier). Steps are SNAPSHOTTED at enrollment so
    // later plan edits never mutate in-flight chains.
    await q.query(`
      CREATE TABLE followup_enrollments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id uuid NOT NULL REFERENCES sourcing_events(id) ON DELETE CASCADE,
        buyer_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        supplier_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        status text NOT NULL DEFAULT 'ACTIVE'
          CHECK (status IN ('ACTIVE','RESPONDED','STOPPED','EXHAUSTED','EVENT_CLOSED')),
        steps jsonb NOT NULL,
        current_step int NOT NULL DEFAULT 0,
        next_run_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (event_id, supplier_org_id)
      )`);
    await q.query(`CREATE INDEX followup_due ON followup_enrollments (next_run_at) WHERE status = 'ACTIVE'`);
    await q.query(`ALTER TABLE followup_enrollments ENABLE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY followup_enrollments_rls ON followup_enrollments
        USING (buyer_org_id = app_org_id())
        WITH CHECK (buyer_org_id = app_org_id())`);

    // Append-only send log (inserted by the DEFINER seam; buyer reads own rows).
    await q.query(`
      CREATE TABLE followup_messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        enrollment_id uuid NOT NULL REFERENCES followup_enrollments(id) ON DELETE CASCADE,
        buyer_org_id uuid NOT NULL,
        supplier_org_id uuid NOT NULL,
        step_no int NOT NULL,
        channel text NOT NULL,
        recipient text NOT NULL,
        status text NOT NULL,
        detail text,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`ALTER TABLE followup_messages ENABLE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY followup_messages_read ON followup_messages FOR SELECT
        USING (buyer_org_id = app_org_id())`);

    // Ticker seam: claim + advance due chains atomically and return the work items
    // (who to message on which channel) for the Node side to deliver. Row locks +
    // SKIP LOCKED make concurrent ticks safe; stop conditions are re-checked under
    // the lock so a bid that landed a second ago wins over a due reminder.
    await q.query(`
      CREATE FUNCTION followup_advance_due(max_rows int DEFAULT 50)
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
          IF r.ev_status NOT IN ('PUBLISHED','OPEN') THEN
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
          VALUES (NULL, NULL, 'FOLLOWUP_STEP_SENT', 'followup_enrollment', r.fe_id,
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

    // Send-log insert (the ticker has no request context → RLS would block a direct insert).
    await q.query(`
      CREATE FUNCTION followup_log_message(p_enrollment uuid, p_step int, p_channel text,
                                           p_recipient text, p_status text, p_detail text)
      RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
        INSERT INTO followup_messages(enrollment_id, buyer_org_id, supplier_org_id, step_no, channel, recipient, status, detail)
        SELECT fe.id, fe.buyer_org_id, fe.supplier_org_id, p_step, p_channel, p_recipient, p_status, p_detail
        FROM followup_enrollments fe WHERE fe.id = p_enrollment
      $$`);

    // Instant stop on response: called inside the supplier's bid-submit transaction —
    // the enrollment is a buyer-private row the supplier cannot touch under RLS.
    await q.query(`
      CREATE FUNCTION followup_mark_responded(p_event uuid, p_supplier uuid)
      RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
        UPDATE followup_enrollments SET status='RESPONDED', next_run_at=NULL, updated_at=now()
        WHERE event_id = p_event AND supplier_org_id = p_supplier AND status = 'ACTIVE'
      $$`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP FUNCTION IF EXISTS followup_mark_responded(uuid, uuid)`);
    await q.query(`DROP FUNCTION IF EXISTS followup_log_message(uuid, int, text, text, text, text)`);
    await q.query(`DROP FUNCTION IF EXISTS followup_advance_due(int)`);
    await q.query(`DROP TABLE IF EXISTS followup_messages`);
    await q.query(`DROP TABLE IF EXISTS followup_enrollments`);
    await q.query(`DROP TABLE IF EXISTS followup_plans`);
    await q.query(`ALTER TABLE organizations DROP COLUMN IF EXISTS phone`);
  }
}
