import { MigrationInterface, QueryRunner } from 'typeorm';

// Full first-release schema: identity, suppliers, requests, sourcing (sealed RFQ),
// append-only audit, licensing/entitlements, plus RLS (private) + ACL-delegating RLS (shared).
export class Init1720000000000 implements MigrationInterface {
  name = 'Init1720000000000';

  public async up(q: QueryRunner): Promise<void> {
    // ---------- enums ----------
    await q.query(`CREATE TYPE org_kind AS ENUM ('BUYER','SUPPLIER','BOTH')`);
    await q.query(`CREATE TYPE identity_origin AS ENUM ('SAAS','ON_PREM_LOCAL','FEDERATED')`);
    await q.query(`CREATE TYPE org_status AS ENUM ('ACTIVE','SUSPENDED','CLOSED')`);
    await q.query(
      `CREATE TYPE membership_role AS ENUM ('BUYER_ADMIN','BUYER_APPROVER','BUYER_USER','SUPPLIER_USER')`,
    );
    await q.query(`CREATE TYPE supplier_rel_status AS ENUM ('INVITED','APPROVED','BLOCKED')`);
    await q.query(`CREATE TYPE request_status AS ENUM ('DRAFT','SUBMITTED','APPROVED','REJECTED')`);
    await q.query(`CREATE TYPE procurement_method AS ENUM ('DIRECT','RFQ','OPEN_TENDER')`);
    await q.query(`CREATE TYPE vat_mode AS ENUM ('INCLUSIVE','EXCLUSIVE')`);
    await q.query(`CREATE TYPE event_type AS ENUM ('RFI','RFP','RFQ','AUCTION')`);
    await q.query(`CREATE TYPE event_format AS ENUM ('SEALED','OPEN','REVERSE','DUTCH')`);
    await q.query(
      `CREATE TYPE event_status AS ENUM ('DRAFT','PUBLISHED','OPEN','CLOSED','OPENING','EVALUATION','AWARDED','CANCELLED')`,
    );
    await q.query(`CREATE TYPE event_visibility AS ENUM ('PUBLIC','INVITED')`);
    await q.query(
      `CREATE TYPE bid_state AS ENUM ('DRAFT','SUBMITTED','WITHDRAWN','SUPERSEDED','LATE','OPENED','DISQUALIFIED')`,
    );
    await q.query(
      `CREATE TYPE license_status AS ENUM ('valid','renewal_due','grace','expired_restricted','revoked')`,
    );

    // ---------- helper functions (read request-local context) ----------
    await q.query(`
      CREATE FUNCTION app_org_id() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$`);
    await q.query(`
      CREATE FUNCTION app_role() RETURNS text LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('app.role', true), '') $$`);

    // ---------- identity (global / network) ----------
    await q.query(`
      CREATE TABLE organizations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        kind org_kind NOT NULL,
        identity_origin identity_origin NOT NULL DEFAULT 'SAAS',
        legal_name text NOT NULL,
        voen text,
        country char(2) NOT NULL DEFAULT 'AZ',
        status org_status NOT NULL DEFAULT 'ACTIVE',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE TABLE organization_users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text NOT NULL UNIQUE,
        password_hash text NOT NULL,
        full_name text NOT NULL,
        status text NOT NULL DEFAULT 'ACTIVE',
        token_version int NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE TABLE memberships (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES organization_users(id) ON DELETE CASCADE,
        org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        role membership_role NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (user_id, org_id, role)
      )`);
    await q.query(`
      CREATE TABLE sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES organization_users(id) ON DELETE CASCADE,
        org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        refresh_hash text NOT NULL,
        expires_at timestamptz NOT NULL,
        revoked boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);

    // ---------- suppliers ----------
    await q.query(`
      CREATE TABLE supplier_profiles (
        org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
        categories text[] NOT NULL DEFAULT '{}',
        details jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE TABLE buyer_profiles (
        org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
        default_currency char(3) NOT NULL DEFAULT 'AZN',
        settings jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE TABLE supplier_relationships (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        buyer_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        supplier_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        status supplier_rel_status NOT NULL DEFAULT 'INVITED',
        score jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (buyer_org_id, supplier_org_id)
      )`);

    // ---------- requests (private to buyer) ----------
    await q.query(`
      CREATE TABLE procurement_method_policies (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        buyer_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        category text NOT NULL DEFAULT '*',
        min_amount_minor bigint NOT NULL DEFAULT 0,
        max_amount_minor bigint,
        method procurement_method NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE TABLE procurement_requests (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        request_no text NOT NULL,
        title text NOT NULL,
        status request_status NOT NULL DEFAULT 'DRAFT',
        estimated_total_minor bigint NOT NULL DEFAULT 0,
        currency char(3) NOT NULL DEFAULT 'AZN',
        vat_mode vat_mode NOT NULL DEFAULT 'EXCLUSIVE',
        category text NOT NULL DEFAULT '*',
        created_by uuid NOT NULL REFERENCES organization_users(id),
        approved_by uuid REFERENCES organization_users(id),
        rejected_by uuid REFERENCES organization_users(id),
        method_resolved procurement_method,
        version int NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (owner_org_id, request_no)
      )`);
    await q.query(`
      CREATE TABLE request_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        request_id uuid NOT NULL REFERENCES procurement_requests(id) ON DELETE CASCADE,
        line_no int NOT NULL,
        name text NOT NULL,
        description text,
        qty numeric NOT NULL DEFAULT 1,
        uom text NOT NULL DEFAULT 'pcs',
        est_unit_price_minor bigint NOT NULL DEFAULT 0,
        vat_rate_bp int NOT NULL DEFAULT 1800,
        est_total_minor bigint NOT NULL DEFAULT 0
      )`);

    // ---------- sourcing (shared marketplace) ----------
    await q.query(`
      CREATE TABLE sourcing_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        buyer_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        request_id uuid REFERENCES procurement_requests(id) ON DELETE SET NULL,
        type event_type NOT NULL DEFAULT 'RFQ',
        format event_format NOT NULL DEFAULT 'SEALED',
        status event_status NOT NULL DEFAULT 'DRAFT',
        visibility event_visibility NOT NULL DEFAULT 'INVITED',
        title text NOT NULL,
        evaluation_currency char(3) NOT NULL DEFAULT 'AZN',
        vat_mode vat_mode NOT NULL DEFAULT 'EXCLUSIVE',
        open_at timestamptz,
        close_at timestamptz,
        awarded_at timestamptz,
        version int NOT NULL DEFAULT 1,
        created_by uuid NOT NULL REFERENCES organization_users(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE TABLE event_lots (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id uuid NOT NULL REFERENCES sourcing_events(id) ON DELETE CASCADE,
        lot_no int NOT NULL,
        title text NOT NULL,
        awarded_bid_id uuid,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE TABLE event_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id uuid NOT NULL REFERENCES sourcing_events(id) ON DELETE CASCADE,
        lot_id uuid REFERENCES event_lots(id) ON DELETE CASCADE,
        line_no int NOT NULL,
        name text NOT NULL,
        description text,
        qty numeric NOT NULL DEFAULT 1,
        uom text NOT NULL DEFAULT 'pcs',
        est_unit_price_minor bigint NOT NULL DEFAULT 0,
        vat_rate_bp int NOT NULL DEFAULT 1800
      )`);
    await q.query(`
      CREATE TABLE event_invitations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id uuid NOT NULL REFERENCES sourcing_events(id) ON DELETE CASCADE,
        supplier_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        invited_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (event_id, supplier_org_id)
      )`);
    await q.query(`
      CREATE TABLE event_qna (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id uuid NOT NULL REFERENCES sourcing_events(id) ON DELETE CASCADE,
        asked_by_org_id uuid NOT NULL REFERENCES organizations(id),
        question text NOT NULL,
        answer text,
        answered_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE TABLE bids (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id uuid NOT NULL REFERENCES sourcing_events(id) ON DELETE CASCADE,
        supplier_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        submitted_by uuid REFERENCES organization_users(id),
        state bid_state NOT NULL DEFAULT 'DRAFT',
        submitted_at timestamptz,
        currency char(3) NOT NULL DEFAULT 'AZN',
        fx_rate numeric NOT NULL DEFAULT 1,
        fx_date date,
        total_minor bigint,
        delivery_days int,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (event_id, supplier_org_id)
      )`);
    await q.query(`
      CREATE TABLE bid_sealed_payloads (
        bid_id uuid PRIMARY KEY REFERENCES bids(id) ON DELETE CASCADE,
        ciphertext bytea NOT NULL,
        iv bytea NOT NULL,
        wrapped_key bytea NOT NULL,
        alg text NOT NULL DEFAULT 'AES-256-GCM',
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE TABLE bid_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        bid_id uuid NOT NULL REFERENCES bids(id) ON DELETE CASCADE,
        event_item_id uuid NOT NULL REFERENCES event_items(id) ON DELETE CASCADE,
        unit_price_minor bigint NOT NULL DEFAULT 0,
        line_total_minor bigint NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE TABLE evaluations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id uuid NOT NULL REFERENCES sourcing_events(id) ON DELETE CASCADE,
        criteria jsonb NOT NULL DEFAULT '[]',
        created_by uuid NOT NULL REFERENCES organization_users(id),
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE TABLE evaluation_scores (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        evaluation_id uuid NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
        bid_id uuid NOT NULL REFERENCES bids(id) ON DELETE CASCADE,
        criterion text NOT NULL,
        score numeric NOT NULL DEFAULT 0,
        weighted numeric NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE TABLE awards (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id uuid NOT NULL REFERENCES sourcing_events(id) ON DELETE CASCADE,
        lot_id uuid REFERENCES event_lots(id) ON DELETE CASCADE,
        winning_bid_id uuid NOT NULL REFERENCES bids(id),
        awarded_by uuid NOT NULL REFERENCES organization_users(id),
        awarded_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (event_id, lot_id)
      )`);

    // ---------- cross-cutting ----------
    await q.query(`
      CREATE TABLE documents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        entity_type text NOT NULL,
        entity_id uuid,
        storage_key text NOT NULL,
        filename text NOT NULL,
        mime text NOT NULL,
        size_bytes bigint NOT NULL DEFAULT 0,
        sha256 text NOT NULL,
        av_status text NOT NULL DEFAULT 'PENDING',
        version int NOT NULL DEFAULT 1,
        created_by uuid REFERENCES organization_users(id),
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE TABLE notifications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        recipient_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        recipient_user_id uuid REFERENCES organization_users(id) ON DELETE CASCADE,
        type text NOT NULL,
        payload jsonb NOT NULL DEFAULT '{}',
        delivered_at timestamptz,
        read_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE TABLE audit_events (
        seq bigserial PRIMARY KEY,
        id uuid NOT NULL DEFAULT gen_random_uuid(),
        actor_id uuid,
        org_id uuid,
        action text NOT NULL,
        entity_type text,
        entity_id uuid,
        payload jsonb NOT NULL DEFAULT '{}',
        prev_hash text,
        hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE TABLE fx_rates (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        base char(3) NOT NULL,
        quote char(3) NOT NULL,
        rate numeric NOT NULL,
        as_of date NOT NULL DEFAULT current_date,
        UNIQUE (base, quote, as_of)
      )`);
    await q.query(`
      CREATE TABLE idempotency_keys (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        scope text NOT NULL,
        key text NOT NULL,
        org_id uuid,
        result jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (scope, key)
      )`);

    // ---------- licensing / entitlements ----------
    await q.query(`
      CREATE TABLE licenses (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        license_id text NOT NULL,
        customer_id text NOT NULL,
        deployment_type text NOT NULL,
        license_type text NOT NULL,
        edition text NOT NULL,
        features text[] NOT NULL DEFAULT '{}',
        limits jsonb NOT NULL DEFAULT '{}',
        valid_from timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        grace_until timestamptz NOT NULL,
        status license_status NOT NULL DEFAULT 'valid',
        last_seen_valid_time timestamptz NOT NULL DEFAULT now(),
        raw_token text NOT NULL,
        installed_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE TABLE entitlement_usage (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid,
        metric text NOT NULL,
        period text NOT NULL DEFAULT '*',
        count int NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (org_id, metric, period)
      )`);
    await q.query(`
      CREATE TABLE release_versions (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    // ---------- indexes ----------
    await q.query(`CREATE INDEX idx_request_items_request ON request_items(request_id)`);
    await q.query(`CREATE INDEX idx_events_buyer ON sourcing_events(buyer_org_id)`);
    await q.query(`CREATE INDEX idx_events_status_close ON sourcing_events(status, close_at)`);
    await q.query(`CREATE INDEX idx_event_items_event ON event_items(event_id)`);
    await q.query(`CREATE INDEX idx_invitations_supplier ON event_invitations(supplier_org_id)`);
    await q.query(`CREATE INDEX idx_bids_event ON bids(event_id)`);
    await q.query(`CREATE INDEX idx_bids_supplier ON bids(supplier_org_id)`);
    await q.query(`CREATE INDEX idx_audit_org ON audit_events(org_id, seq)`);
    await q.query(`CREATE INDEX idx_docs_entity ON documents(entity_type, entity_id)`);

    // ---------- append-only audit ----------
    await q.query(`
      CREATE FUNCTION audit_events_no_mutate() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'audit_events is append-only'; END; $$`);
    await q.query(`
      CREATE TRIGGER audit_events_block_mutate BEFORE UPDATE OR DELETE ON audit_events
        FOR EACH ROW EXECUTE FUNCTION audit_events_no_mutate()`);

    // ---------- RLS: private tables (owner_org / buyer_org == app.org_id) ----------
    for (const [table, col] of [
      ['buyer_profiles', 'org_id'],
      ['supplier_relationships', 'buyer_org_id'],
      ['procurement_method_policies', 'buyer_org_id'],
      ['procurement_requests', 'owner_org_id'],
      ['request_items', 'owner_org_id'],
      ['documents', 'owner_org_id'],
    ] as const) {
      await q.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await q.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await q.query(`
        CREATE POLICY ${table}_rls ON ${table}
          USING (${col} = app_org_id())
          WITH CHECK (${col} = app_org_id())`);
    }

    // notifications: recipient org
    await q.query(`ALTER TABLE notifications ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE notifications FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY notifications_rls ON notifications
        USING (recipient_org_id = app_org_id())
        WITH CHECK (recipient_org_id = app_org_id())`);

    // audit: read own org; append only (insert), no update/delete (trigger + revoke)
    await q.query(`ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE audit_events FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY audit_select ON audit_events FOR SELECT
        USING (org_id = app_org_id())`);
    await q.query(`
      CREATE POLICY audit_insert ON audit_events FOR INSERT
        WITH CHECK (org_id = app_org_id() OR org_id IS NULL)`);

    // ---------- RLS: shared sourcing tables (ACL-delegating) ----------
    // sourcing_events: buyer manages own; supplier reads invited or public+published
    await q.query(`ALTER TABLE sourcing_events ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE sourcing_events FORCE ROW LEVEL SECURITY`);
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
    await q.query(`
      CREATE POLICY se_modify ON sourcing_events FOR ALL
        USING (buyer_org_id = app_org_id())
        WITH CHECK (buyer_org_id = app_org_id())`);

    // child tables delegate visibility to the parent event's own RLS via EXISTS
    for (const table of ['event_lots', 'event_items', 'event_invitations', 'event_qna'] as const) {
      await q.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await q.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await q.query(`
        CREATE POLICY ${table}_select ON ${table} FOR SELECT USING (
          EXISTS (SELECT 1 FROM sourcing_events e WHERE e.id = ${table}.event_id))`);
      await q.query(`
        CREATE POLICY ${table}_modify ON ${table} FOR ALL USING (
          EXISTS (SELECT 1 FROM sourcing_events e
                  WHERE e.id = ${table}.event_id AND e.buyer_org_id = app_org_id())
        ) WITH CHECK (
          EXISTS (SELECT 1 FROM sourcing_events e
                  WHERE e.id = ${table}.event_id AND e.buyer_org_id = app_org_id()))`);
    }

    // bids: supplier owns own; buyer sees bids of own events (participation; amounts stay sealed)
    await q.query(`ALTER TABLE bids ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE bids FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY bids_select ON bids FOR SELECT USING (
        supplier_org_id = app_org_id()
        OR EXISTS (SELECT 1 FROM sourcing_events e WHERE e.id = bids.event_id AND e.buyer_org_id = app_org_id())
      )`);
    await q.query(`
      CREATE POLICY bids_modify ON bids FOR ALL
        USING (supplier_org_id = app_org_id())
        WITH CHECK (supplier_org_id = app_org_id())`);

    // sealed payloads: supplier owner always; buyer only once event has reached opening
    await q.query(`ALTER TABLE bid_sealed_payloads ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE bid_sealed_payloads FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY bsp_select ON bid_sealed_payloads FOR SELECT USING (
        EXISTS (SELECT 1 FROM bids b WHERE b.id = bid_sealed_payloads.bid_id AND b.supplier_org_id = app_org_id())
        OR EXISTS (SELECT 1 FROM bids b JOIN sourcing_events e ON e.id = b.event_id
                   WHERE b.id = bid_sealed_payloads.bid_id AND e.buyer_org_id = app_org_id()
                     AND e.status IN ('OPENING','EVALUATION','AWARDED'))
      )`);
    await q.query(`
      CREATE POLICY bsp_modify ON bid_sealed_payloads FOR ALL USING (
        EXISTS (SELECT 1 FROM bids b WHERE b.id = bid_sealed_payloads.bid_id AND b.supplier_org_id = app_org_id())
      ) WITH CHECK (
        EXISTS (SELECT 1 FROM bids b WHERE b.id = bid_sealed_payloads.bid_id AND b.supplier_org_id = app_org_id()))`);

    // bid_items (revealed amounts): supplier owner always; buyer only after opening
    await q.query(`ALTER TABLE bid_items ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE bid_items FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY bi_select ON bid_items FOR SELECT USING (
        EXISTS (SELECT 1 FROM bids b WHERE b.id = bid_items.bid_id AND b.supplier_org_id = app_org_id())
        OR EXISTS (SELECT 1 FROM bids b JOIN sourcing_events e ON e.id = b.event_id
                   WHERE b.id = bid_items.bid_id AND e.buyer_org_id = app_org_id()
                     AND e.status IN ('OPENING','EVALUATION','AWARDED'))
      )`);
    await q.query(`
      CREATE POLICY bi_modify ON bid_items FOR ALL USING (
        EXISTS (SELECT 1 FROM bids b WHERE b.id = bid_items.bid_id AND b.supplier_org_id = app_org_id())
      ) WITH CHECK (
        EXISTS (SELECT 1 FROM bids b WHERE b.id = bid_items.bid_id AND b.supplier_org_id = app_org_id()))`);

    // evaluations / scores / awards: buyer of the event only
    for (const table of ['evaluations', 'awards'] as const) {
      await q.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await q.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await q.query(`
        CREATE POLICY ${table}_rls ON ${table} FOR ALL USING (
          EXISTS (SELECT 1 FROM sourcing_events e WHERE e.id = ${table}.event_id AND e.buyer_org_id = app_org_id())
        ) WITH CHECK (
          EXISTS (SELECT 1 FROM sourcing_events e WHERE e.id = ${table}.event_id AND e.buyer_org_id = app_org_id()))`);
    }
    await q.query(`ALTER TABLE evaluation_scores ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE evaluation_scores FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY es_rls ON evaluation_scores FOR ALL USING (
        EXISTS (SELECT 1 FROM evaluations ev JOIN sourcing_events e ON e.id = ev.event_id
                WHERE ev.id = evaluation_scores.evaluation_id AND e.buyer_org_id = app_org_id())
      ) WITH CHECK (
        EXISTS (SELECT 1 FROM evaluations ev JOIN sourcing_events e ON e.id = ev.event_id
                WHERE ev.id = evaluation_scores.evaluation_id AND e.buyer_org_id = app_org_id()))`);

    // ---------- grants for the application role ----------
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user`);
    await q.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user`);
    await q.query(`REVOKE UPDATE, DELETE ON audit_events FROM app_user`);

    await q.query(`INSERT INTO release_versions(version) VALUES ('1.0.0')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    // Dev convenience only; on-prem uses forward-only migrations.
    const tables = [
      'release_versions', 'entitlement_usage', 'licenses', 'idempotency_keys', 'fx_rates',
      'audit_events', 'notifications', 'documents', 'awards', 'evaluation_scores', 'evaluations',
      'bid_items', 'bid_sealed_payloads', 'bids', 'event_qna', 'event_invitations', 'event_items',
      'event_lots', 'sourcing_events', 'request_items', 'procurement_requests',
      'procurement_method_policies', 'supplier_relationships', 'buyer_profiles', 'supplier_profiles',
      'sessions', 'memberships', 'organization_users', 'organizations',
    ];
    for (const t of tables) await q.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
    await q.query(`DROP FUNCTION IF EXISTS audit_events_no_mutate() CASCADE`);
    await q.query(`DROP FUNCTION IF EXISTS app_org_id() CASCADE`);
    await q.query(`DROP FUNCTION IF EXISTS app_role() CASCADE`);
    for (const t of [
      'license_status', 'bid_state', 'event_visibility', 'event_status', 'event_format',
      'event_type', 'vat_mode', 'procurement_method', 'request_status', 'supplier_rel_status',
      'membership_role', 'org_status', 'identity_origin', 'org_kind',
    ]) {
      await q.query(`DROP TYPE IF EXISTS ${t}`);
    }
  }
}
