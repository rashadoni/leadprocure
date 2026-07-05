import { MigrationInterface, QueryRunner } from 'typeorm';

// One-time password-reset tokens. No RLS: reset happens with no org context, and the
// bearer of the (hashed) token is the authorization. Tokens are single-use and expire.
export class PasswordReset1720000000009 implements MigrationInterface {
  name = 'PasswordReset1720000000009';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE password_reset_tokens (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES organization_users(id) ON DELETE CASCADE,
        token_hash text NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_prt_user ON password_reset_tokens(user_id)`);
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON password_reset_tokens TO app_user`);
    await q.query(`INSERT INTO release_versions(version) VALUES ('1.5.0-mail')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS password_reset_tokens CASCADE`);
  }
}
