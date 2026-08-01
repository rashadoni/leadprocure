import { MigrationInterface, QueryRunner } from 'typeorm';

function applicationRole(): string {
  const role = process.env.DATABASE_APP_ROLE || 'app_user';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(role)) {
    throw new Error('DATABASE_APP_ROLE must be a valid PostgreSQL role name');
  }
  return `"${role}"`;
}

// Reconcile runtime permissions added by later migrations and make the existing
// SECURITY DEFINER seams work under PostgreSQL FORCE RLS. The migration owner may
// bypass these policies; the application role is not the owner and remains scoped
// by the same RLS policies.
export class RuntimeRoleHardening1720000000028 implements MigrationInterface {
  name = 'RuntimeRoleHardening1720000000028';

  public async up(q: QueryRunner): Promise<void> {
    const appRole = applicationRole();

    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON budgets TO ${appRole}`);
    await q.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON followup_plans, followup_enrollments TO ${appRole}`,
    );
    await q.query(`GRANT SELECT ON followup_messages TO ${appRole}`);
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON channel_connections TO ${appRole}`);

    for (const table of [
      'notifications',
      'audit_events',
      'sourcing_events',
      'bids',
      'documents',
      'po_amendments',
      'channel_connections',
    ]) {
      await q.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
    }

    await q.query(`INSERT INTO release_versions(version) VALUES ('2.8.0-runtime-role-hardening')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    const appRole = applicationRole();

    await q.query(`DELETE FROM release_versions WHERE version = '2.8.0-runtime-role-hardening'`);
    for (const table of [
      'notifications',
      'audit_events',
      'sourcing_events',
      'bids',
      'documents',
      'po_amendments',
      'channel_connections',
    ]) {
      await q.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    }

    await q.query(`REVOKE SELECT, INSERT, UPDATE, DELETE ON budgets FROM ${appRole}`);
    await q.query(
      `REVOKE SELECT, INSERT, UPDATE, DELETE ON followup_plans, followup_enrollments FROM ${appRole}`,
    );
    await q.query(`REVOKE SELECT ON followup_messages FROM ${appRole}`);
    await q.query(`REVOKE SELECT, INSERT, UPDATE, DELETE ON channel_connections FROM ${appRole}`);
  }
}
