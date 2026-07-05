import { MigrationInterface, QueryRunner } from 'typeorm';

// event_qna.asked_by_org_id was the only org FK created without ON DELETE CASCADE,
// so deleting an organization (fixtures, GDPR-style erasure) was blocked by its
// questions. Align it with every other org reference.
export class QnaFkCascade1720000000006 implements MigrationInterface {
  name = 'QnaFkCascade1720000000006';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE event_qna DROP CONSTRAINT event_qna_asked_by_org_id_fkey`);
    await q.query(`
      ALTER TABLE event_qna ADD CONSTRAINT event_qna_asked_by_org_id_fkey
        FOREIGN KEY (asked_by_org_id) REFERENCES organizations(id) ON DELETE CASCADE`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE event_qna DROP CONSTRAINT event_qna_asked_by_org_id_fkey`);
    await q.query(`
      ALTER TABLE event_qna ADD CONSTRAINT event_qna_asked_by_org_id_fkey
        FOREIGN KEY (asked_by_org_id) REFERENCES organizations(id)`);
  }
}
