import { MigrationInterface, QueryRunner } from 'typeorm';

// A hash chain you cannot recompute is not a hash chain.
//
// Two things were wrong with the one we had. The application built the hashed body in
// JavaScript over `{action, entityType, entityId, payload, orgId, actorId, at}` where `at`
// was `new Date()` — a value that is never stored, while `created_at` defaults to the
// transaction's `now()`. And `payload` went through jsonb, which reorders keys. So nothing
// holding the stored row could reproduce the digest, and in fact nothing in the repository
// ever tried: the only check anywhere compares `prev_hash` to the previous row's `hash`,
// which detects a truncated tail and nothing else.
//
// Meanwhile the deadline closer — the one state transition no person performs, and so the
// one whose record matters most — wrote `org_id NULL` (it runs with no request context,
// and the INSERT policy admits only the acting org or NULL) with
// `hash = md5(id || clock_timestamp())`: not a link in any chain, and shaped like one.
// A per-organization query for a tender's history did not contain its own closing.
//
// audit_append() is now the single place a row is appended. It reads the previous hash for
// that organization, hashes a canonical body built from exactly the columns it stores —
// including the timestamp it writes to created_at, rendered in UTC so the digest does not
// depend on the reader's TimeZone — and returns the hash. Both callers use it: the request
// path through AuditService, and the closer after borrowing the owning org for that row.
export class VerifiableAuditChain1720000000044 implements MigrationInterface {
  name = 'VerifiableAuditChain1720000000044';

  public async up(q: QueryRunner): Promise<void> {
    // Not SECURITY DEFINER on purpose: the caller must already be allowed to write this
    // organization's audit row, exactly as before. RLS stays the gate.
    await q.query(`
      CREATE OR REPLACE FUNCTION audit_body(p_org uuid, p_actor uuid, p_action text,
                                            p_entity_type text, p_entity_id uuid,
                                            p_payload jsonb, p_at timestamptz)
      RETURNS text LANGUAGE sql IMMUTABLE AS $$
        SELECT jsonb_build_object(
          'action', p_action, 'entityType', p_entity_type, 'entityId', p_entity_id,
          'orgId', p_org, 'actorId', p_actor, 'payload', coalesce(p_payload, '{}'::jsonb),
          'at', to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        )::text $$`);

    await q.query(`
      CREATE OR REPLACE FUNCTION audit_append(p_org uuid, p_actor uuid, p_action text,
                                              p_entity_type text, p_entity_id uuid,
                                              p_payload jsonb)
      RETURNS text LANGUAGE plpgsql AS $$
      DECLARE v_prev text; v_at timestamptz := now(); v_hash text;
      BEGIN
        SELECT a.hash INTO v_prev FROM audit_events a
          WHERE a.org_id IS NOT DISTINCT FROM p_org ORDER BY a.seq DESC LIMIT 1;
        v_hash := encode(sha256(convert_to(
          coalesce(v_prev, '') || audit_body(p_org, p_actor, p_action, p_entity_type,
                                             p_entity_id, p_payload, v_at), 'UTF8')), 'hex');
        INSERT INTO audit_events(actor_id, org_id, action, entity_type, entity_id,
                                 payload, prev_hash, hash, created_at)
          VALUES (p_actor, p_org, p_action, p_entity_type, p_entity_id,
                  coalesce(p_payload, '{}'::jsonb), v_prev, v_hash, v_at);
        RETURN v_hash;
      END $$`);

    // The closer: attribute the row to the organization whose tender it is, and chain it.
    // set_config(..., true) is transaction-local; the previous value is restored so a
    // caller that already had a context keeps it.
    await q.query(`
      CREATE OR REPLACE FUNCTION close_due_events() RETURNS TABLE(event_id uuid, buyer_org_id uuid)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
      DECLARE e record; v_caller_org text;
      BEGIN
        v_caller_org := coalesce(current_setting('app.org_id', true), '');
        FOR e IN SELECT id FROM sourcing_events WHERE status='OPEN' AND close_at<=clock_timestamp() LOOP
          IF pg_try_advisory_xact_lock(hashtextextended(e.id::text,42)) THEN
            UPDATE sourcing_events SET status='CLOSED',updated_at=clock_timestamp()
              WHERE id=e.id AND status='OPEN' AND close_at<=clock_timestamp()
              RETURNING id,sourcing_events.buyer_org_id INTO event_id,buyer_org_id;
            IF FOUND THEN
              PERFORM set_config('app.org_id', buyer_org_id::text, true);
              PERFORM audit_append(buyer_org_id, NULL, 'EVENT_CLOSED', 'sourcing_event', event_id,
                                   jsonb_build_object('buyer_org_id', buyer_org_id, 'by', 'deadline'));
              RETURN NEXT;
            END IF;
          END IF;
        END LOOP;
        PERFORM set_config('app.org_id', v_caller_org, true);
      END $$`);
  }

  // Forward-only, like every migration since 0028: going back would reinstate a chain
  // whose digests cannot be recomputed, over rows that were written as verifiable ones.
  public async down(): Promise<void> {
    throw new Error('Forward-only audit chain correction');
  }
}
