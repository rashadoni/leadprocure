import {MigrationInterface, QueryRunner} from 'typeorm';
export class AuditLifecycleConstraints1720000000032 implements MigrationInterface {
 async up(q:QueryRunner) {
   await q.query(`ALTER TABLE upload_grants DROP CONSTRAINT upload_grants_owner_org_id_fkey;
     ALTER TABLE upload_grants ADD FOREIGN KEY(owner_org_id) REFERENCES organizations(id) ON DELETE CASCADE;
     ALTER TABLE followup_outbox DROP CONSTRAINT followup_outbox_enrollment_id_fkey;
     ALTER TABLE followup_outbox ADD FOREIGN KEY(enrollment_id) REFERENCES followup_enrollments(id) ON DELETE CASCADE;`);
 }
 async down() {throw new Error('Forward-only lifecycle constraints');}
}
