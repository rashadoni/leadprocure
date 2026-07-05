import { MigrationInterface, QueryRunner } from 'typeorm';

// Group 1d — multi-step approval. A buyer defines value-banded approval chains; on
// submit, a request materializes ordered steps from the matching policy and is APPROVED
// only when every step is approved. Both tables are buyer-private (RLS by owner org).
export class ApprovalWorkflow1720000000013 implements MigrationInterface {
  name = 'ApprovalWorkflow1720000000013';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE approval_policies (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        buyer_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        min_amount_minor bigint NOT NULL DEFAULT 0,
        max_amount_minor bigint,
        steps jsonb NOT NULL DEFAULT '[]',
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE TABLE approval_steps (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        request_id uuid NOT NULL REFERENCES procurement_requests(id) ON DELETE CASCADE,
        owner_org_id uuid NOT NULL,
        step_no int NOT NULL,
        approver_role membership_role NOT NULL,
        status request_status NOT NULL DEFAULT 'SUBMITTED',
        acted_by uuid REFERENCES organization_users(id),
        acted_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_appr_steps_req ON approval_steps(request_id, step_no)`);

    for (const [t, col] of [['approval_policies', 'buyer_org_id'], ['approval_steps', 'owner_org_id']] as const) {
      await q.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
      await q.query(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
      await q.query(`CREATE POLICY ${t}_rls ON ${t} USING (${col} = app_org_id()) WITH CHECK (${col} = app_org_id())`);
    }
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON approval_policies, approval_steps TO app_user`);
    await q.query(`INSERT INTO release_versions(version) VALUES ('1.8.0-approvals')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS approval_steps CASCADE`);
    await q.query(`DROP TABLE IF EXISTS approval_policies CASCADE`);
  }
}
