import { MigrationInterface, QueryRunner } from 'typeorm';

// Rotating-refresh hardening: record WHEN a session's refresh token was rotated out so
// refresh() can distinguish a benign replay (same token presented twice within a few
// seconds — SPA reload, StrictMode double-mount, concurrent 401 retries) from genuine
// token theft (a long-revoked token resurfacing). Benign replays get fresh creds; only
// stale reuse trips the "revoke every session for this user" breach response.
export class SessionReuseLeeway1720000000017 implements MigrationInterface {
  name = 'SessionReuseLeeway1720000000017';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE sessions ADD COLUMN revoked_at timestamptz`);
    // Backfill existing revoked rows so they read as "revoked long ago" (never benign).
    await q.query(`UPDATE sessions SET revoked_at = created_at WHERE revoked = true`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE sessions DROP COLUMN revoked_at`);
  }
}
