import { MigrationInterface, QueryRunner } from 'typeorm';

// The breach response said «family» and meant «everything».
//
// Rotating refresh issues a NEW session row on every use, and nothing joined the new row to
// the one it replaced — so when a rotated token came back, the only scope the code could
// name was `WHERE user_id = $1`: every session of that person, on every device, hard
// revoked. The comment above it had always claimed the family; the family simply did not
// exist in the schema.
//
// That is harsher than the reason for the rule. Reuse of a rotated token means two holders
// of one chain and no way to tell which is the thief, so the chain must die — that part is
// not in question. The person's phone, which shares nothing with that chain but a user id,
// is not implicated by it.
//
// And it is reachable without any thief at all. A page bootstraps through `/auth/refresh`,
// which rotates the cookie; a click before the response lands leaves the browser holding
// the old one; presented again later than `JWT_REFRESH_REUSE_LEEWAY_MS` (15s) it reads as
// reuse. Measured in the browser suite, where it emptied the supplier's session repeatedly
// over a day. A person doing the same thing gets signed out of everywhere they are signed
// in — for clicking too early.
//
// `family_id` is the chain: a login starts one, every rotation inherits it. Existing rows
// become their own family, which is the safe reading — an old token presented after this
// migration revokes itself and nothing else.
export class SessionFamily1720000000046 implements MigrationInterface {
  name = 'SessionFamily1720000000046';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE sessions ADD COLUMN family_id uuid`);
    await q.query(`UPDATE sessions SET family_id = id WHERE family_id IS NULL`);
    await q.query(`ALTER TABLE sessions ALTER COLUMN family_id SET NOT NULL`);
    // A row written by anything that forgets the column still gets a family of its own,
    // rather than a NULL that would group every such row together.
    await q.query(`ALTER TABLE sessions ALTER COLUMN family_id SET DEFAULT gen_random_uuid()`);
    await q.query(`CREATE INDEX idx_sessions_family ON sessions(family_id)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX idx_sessions_family`);
    await q.query(`ALTER TABLE sessions DROP COLUMN family_id`);
  }
}
