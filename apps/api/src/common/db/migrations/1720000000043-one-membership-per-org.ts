import { MigrationInterface, QueryRunner } from 'typeorm';

// One role per user per organization.
//
// The original key was UNIQUE (user_id, org_id, role), which makes a SECOND membership for
// the same pair perfectly legal as long as the role differs — and the whole module is
// written as though a pair has exactly one: `setRole` updates EVERY membership of the pair
// in one statement, `users()` joins them (so the person is listed twice) and login takes
// whichever row comes first. Two ordinary clicks produced a dead end: add someone, add them
// again with another role, and from then on every role change collides with that same
// constraint and answers 500, with no way back through the UI.
export class OneMembershipPerOrg1720000000043 implements MigrationInterface {
  name = 'OneMembershipPerOrg1720000000043';

  public async up(q: QueryRunner): Promise<void> {
    // Nothing can guess which of two roles was meant to survive, so refuse and name them
    // rather than drop one silently (same rule as the budget-overlap pre-check in 0030).
    const dupes: Array<{ user_id: string; org_id: string; roles: string[] }> = await q.query(`
      SELECT user_id, org_id, array_agg(role::text ORDER BY created_at) AS roles
      FROM memberships GROUP BY user_id, org_id HAVING count(*) > 1`);
    if (dupes.length) {
      const named = dupes.map((d) => `${d.user_id} in ${d.org_id} [${d.roles.join(', ')}]`).join('; ');
      throw new Error(
        `memberships holds ${dupes.length} user/organization pair(s) with more than one role. `
        + `Keep exactly one membership for each before this migration can enforce it: ${named}`,
      );
    }
    // Drop by lookup, not by the generated name: the three-column key is the only unique
    // constraint on this table with three columns, and its name is Postgres's to choose.
    await q.query(`
      DO $$
      DECLARE c text;
      BEGIN
        SELECT conname INTO c FROM pg_constraint
         WHERE conrelid = 'memberships'::regclass AND contype = 'u'
           AND array_length(conkey, 1) = 3;
        IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE memberships DROP CONSTRAINT %I', c); END IF;
      END $$`);
    await q.query(`
      ALTER TABLE memberships ADD CONSTRAINT memberships_user_org_key UNIQUE (user_id, org_id)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_user_org_key`);
    await q.query(`
      ALTER TABLE memberships ADD CONSTRAINT memberships_user_id_org_id_role_key
        UNIQUE (user_id, org_id, role)`);
  }
}
