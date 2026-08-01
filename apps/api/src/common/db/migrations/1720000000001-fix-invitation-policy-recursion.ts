import { MigrationInterface, QueryRunner } from 'typeorm';

// Fixes "infinite recursion detected in policy for relation sourcing_events".
//
// The cycle: sourcing_events.se_select had EXISTS(event_invitations …), while
// event_invitations' own policies have EXISTS(sourcing_events …) — Postgres cannot
// plan either table without recursing into the other.
//
// Break the cycle with a SECURITY DEFINER helper owned by the migration owner:
// it reads event_invitations WITHOUT that table's RLS (owner + no FORCE), so
// planning sourcing_events no longer touches event_invitations' policies.
// app_user itself remains fully RLS-constrained on both tables.
//
// Also tightens supplier visibility: invited suppliers must not see DRAFT/CANCELLED
// events — the status filter now applies to BOTH the public and invited branches.
export class FixInvitationPolicyRecursion1720000000001 implements MigrationInterface {
  name = 'FixInvitationPolicyRecursion1720000000001';

  public async up(q: QueryRunner): Promise<void> {
    // PostgreSQL validates the SQL function body when CREATE FUNCTION runs. If FORCE
    // is still enabled at that point, even the owner must traverse the recursive
    // event_invitations policy and fresh-database migrations fail before the helper
    // exists. This change is transactional, so a later failure restores FORCE.
    await q.query(`ALTER TABLE event_invitations NO FORCE ROW LEVEL SECURITY`);

    await q.query(`
      CREATE FUNCTION is_invited_supplier(p_event_id uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
      $$ SELECT EXISTS (
           SELECT 1 FROM event_invitations ei
           WHERE ei.event_id = p_event_id AND ei.supplier_org_id = app_org_id()
         ) $$`);

    await q.query(`DROP POLICY se_select ON sourcing_events`);
    await q.query(`
      CREATE POLICY se_select ON sourcing_events FOR SELECT USING (
        buyer_org_id = app_org_id()
        OR (
          app_role() = 'SUPPLIER_USER'
          AND status IN ('PUBLISHED','OPEN','CLOSED','OPENING','EVALUATION','AWARDED')
          AND (visibility = 'PUBLIC' OR is_invited_supplier(sourcing_events.id))
        )
      )`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP POLICY se_select ON sourcing_events`);
    await q.query(`
      CREATE POLICY se_select ON sourcing_events FOR SELECT USING (
        buyer_org_id = app_org_id()
        OR (
          app_role() = 'SUPPLIER_USER' AND (
            (visibility = 'PUBLIC' AND status IN ('PUBLISHED','OPEN','CLOSED','OPENING','EVALUATION','AWARDED'))
            OR EXISTS (SELECT 1 FROM event_invitations ei
                       WHERE ei.event_id = sourcing_events.id AND ei.supplier_org_id = app_org_id())
          )
        )
      )`);
    await q.query(`ALTER TABLE event_invitations FORCE ROW LEVEL SECURITY`);
    await q.query(`DROP FUNCTION is_invited_supplier(uuid)`);
  }
}
