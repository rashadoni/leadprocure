import { Client } from 'pg';
import { randomUUID } from 'crypto';

/**
 * Hostile isolation tests for the RLS/ACL policies — run directly against Postgres
 * as `app_user` (the runtime role: NOSUPERUSER, NOBYPASSRLS, not table owner).
 *
 * Production sets transaction-local GUCs (set_config(..., true)); tests use
 * session-local (set_config(..., false)) — equivalent for policy evaluation.
 *
 * This suite is the regression net that must stay green while the sourcing
 * module is being built: if a policy change leaks foreign-tenant data or
 * sealed amounts before opening, these tests go red.
 */

const tag = randomUUID().slice(0, 8);

let db: Client;

// created ids
let buyerA: string; // event-owning buyer
let buyerB: string; // hostile foreign buyer
let supplierS: string; // invited supplier
let supplierS2: string; // hostile foreign supplier
let userA: string;
let userS: string;

let eventInvited: string; // INVITED visibility, PUBLISHED
let eventPublic: string; // PUBLIC visibility, PUBLISHED
let eventDraft: string; // INVITED visibility, DRAFT (never visible to suppliers)
let eventItem: string;
let bidS: string; // supplier S's sealed bid on eventPublic

async function as(orgId: string | null, role: string | null): Promise<void> {
  await db.query(`SELECT set_config('app.org_id', $1, false), set_config('app.role', $2, false)`, [
    orgId ?? '',
    role ?? '',
  ]);
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const r = await db.query(sql, params);
  return r.rowCount ?? 0;
}

beforeAll(async () => {
  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  // --- fixture orgs/users (organizations & organization_users carry no RLS) ---
  const org = async (kind: string, name: string) =>
    (
      await db.query(`INSERT INTO organizations(kind, legal_name) VALUES ($1,$2) RETURNING id`, [
        kind,
        `${name}-${tag}`,
      ])
    ).rows[0].id;
  buyerA = await org('BUYER', 'BuyerA');
  buyerB = await org('BUYER', 'BuyerB');
  supplierS = await org('SUPPLIER', 'SupplierS');
  supplierS2 = await org('SUPPLIER', 'SupplierS2');

  const user = async (email: string) =>
    (
      await db.query(
        `INSERT INTO organization_users(email, password_hash, full_name) VALUES ($1,'x','T') RETURNING id`,
        [`${email}-${tag}@t.test`],
      )
    ).rows[0].id;
  userA = await user('a');
  userS = await user('s');

  // --- buyer A creates three events (WITH CHECK requires buyer context) ---
  await as(buyerA, 'BUYER_ADMIN');
  const ev = async (visibility: string, status: string, title: string) =>
    (
      await db.query(
        `INSERT INTO sourcing_events(buyer_org_id, type, format, status, visibility, title, created_by, close_at)
         VALUES ($1,'RFQ','SEALED',$2,$3,$4,$5, now() + interval '1 day') RETURNING id`,
        [buyerA, status, visibility, `${title}-${tag}`, userA],
      )
    ).rows[0].id;
  eventInvited = await ev('INVITED', 'PUBLISHED', 'invited-published');
  eventPublic = await ev('PUBLIC', 'OPEN', 'public-open');
  eventDraft = await ev('INVITED', 'DRAFT', 'invited-draft');

  eventItem = (
    await db.query(
      `INSERT INTO event_items(event_id, line_no, name, qty, est_unit_price_minor)
       VALUES ($1, 1, 'Steel pipe', 10, 50000) RETURNING id`,
      [eventPublic],
    )
  ).rows[0].id;

  await db.query(`INSERT INTO event_invitations(event_id, supplier_org_id) VALUES ($1,$2)`, [
    eventInvited,
    supplierS,
  ]);
});

afterAll(async () => {
  await as(null, null);
  // cascade wipes fixture data; audit_events rows are append-only and stay (by design)
  await db.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [
    [buyerA, buyerB, supplierS, supplierS2],
  ]);
  await db.end();
});

describe('private buyer tables (RLS by owner org)', () => {
  let requestId: string;

  it('owner org sees its request', async () => {
    await as(buyerA, 'BUYER_ADMIN');
    requestId = (
      await db.query(
        `INSERT INTO procurement_requests(owner_org_id, request_no, title, created_by)
         VALUES ($1, $2, 'Test request', $3) RETURNING id`,
        [buyerA, `R-${tag}`, userA],
      )
    ).rows[0].id;
    expect(await count(`SELECT 1 FROM procurement_requests WHERE id=$1`, [requestId])).toBe(1);
  });

  it('foreign buyer sees nothing', async () => {
    await as(buyerB, 'BUYER_ADMIN');
    expect(await count(`SELECT 1 FROM procurement_requests WHERE id=$1`, [requestId])).toBe(0);
  });

  it('no context = default deny', async () => {
    await as(null, null);
    expect(await count(`SELECT 1 FROM procurement_requests WHERE id=$1`, [requestId])).toBe(0);
  });

  it('foreign buyer cannot forge a row for another org (WITH CHECK)', async () => {
    await as(buyerB, 'BUYER_ADMIN');
    await expect(
      db.query(
        `INSERT INTO procurement_requests(owner_org_id, request_no, title, created_by)
         VALUES ($1, $2, 'Forged', $3)`,
        [buyerA, `R-forged-${tag}`, userA],
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('shared sourcing events (ACL-delegating policies)', () => {
  it('invited supplier sees the invited event and the public one, not the draft', async () => {
    await as(supplierS, 'SUPPLIER_USER');
    expect(await count(`SELECT 1 FROM sourcing_events WHERE id=$1`, [eventInvited])).toBe(1);
    expect(await count(`SELECT 1 FROM sourcing_events WHERE id=$1`, [eventPublic])).toBe(1);
    expect(await count(`SELECT 1 FROM sourcing_events WHERE id=$1`, [eventDraft])).toBe(0);
  });

  it('non-invited supplier sees only the public event', async () => {
    await as(supplierS2, 'SUPPLIER_USER');
    expect(await count(`SELECT 1 FROM sourcing_events WHERE id=$1`, [eventInvited])).toBe(0);
    expect(await count(`SELECT 1 FROM sourcing_events WHERE id=$1`, [eventPublic])).toBe(1);
  });

  it('a different buyer sees none of them (not even PUBLIC — marketplace is for suppliers)', async () => {
    await as(buyerB, 'BUYER_ADMIN');
    expect(
      await count(`SELECT 1 FROM sourcing_events WHERE id = ANY($1::uuid[])`, [
        [eventInvited, eventPublic, eventDraft],
      ]),
    ).toBe(0);
  });

  it('supplier cannot modify a buyer event', async () => {
    await as(supplierS, 'SUPPLIER_USER');
    const r = await db.query(`UPDATE sourcing_events SET title='hacked' WHERE id=$1`, [
      eventPublic,
    ]);
    expect(r.rowCount).toBe(0);
  });
});

describe('sealed bids: amounts hidden until opening', () => {
  beforeAll(async () => {
    // supplier S submits a sealed bid on the public event
    await as(supplierS, 'SUPPLIER_USER');
    bidS = (
      await db.query(
        `INSERT INTO bids(event_id, supplier_org_id, submitted_by, state, submitted_at)
         VALUES ($1,$2,$3,'SUBMITTED', now()) RETURNING id`,
        [eventPublic, supplierS, userS],
      )
    ).rows[0].id;
    await db.query(
      `INSERT INTO bid_sealed_payloads(bid_id, ciphertext, iv, wrapped_key) VALUES ($1,$2,$3,$4)`,
      [bidS, Buffer.from('ciphertext'), Buffer.from('iv..........'), Buffer.from('wrapped')],
    );
    await db.query(
      `INSERT INTO bid_items(bid_id, event_item_id, unit_price_minor, line_total_minor)
       VALUES ($1,$2, 42000, 420000)`,
      [bidS, eventItem],
    );
  });

  it('buyer sees bid participation before opening (fact of bid, not amounts)', async () => {
    await as(buyerA, 'BUYER_ADMIN');
    expect(await count(`SELECT 1 FROM bids WHERE id=$1`, [bidS])).toBe(1);
  });

  it('buyer CANNOT read sealed payload or bid items before opening', async () => {
    await as(buyerA, 'BUYER_ADMIN');
    expect(await count(`SELECT 1 FROM bid_sealed_payloads WHERE bid_id=$1`, [bidS])).toBe(0);
    expect(await count(`SELECT 1 FROM bid_items WHERE bid_id=$1`, [bidS])).toBe(0);
  });

  it('after the event moves to OPENING, buyer can read payload and items', async () => {
    await as(buyerA, 'BUYER_ADMIN');
    await db.query(`UPDATE sourcing_events SET status='OPENING' WHERE id=$1`, [eventPublic]);
    expect(await count(`SELECT 1 FROM bid_sealed_payloads WHERE bid_id=$1`, [bidS])).toBe(1);
    expect(await count(`SELECT 1 FROM bid_items WHERE bid_id=$1`, [bidS])).toBe(1);
  });

  it('foreign supplier never sees another supplier bid', async () => {
    await as(supplierS2, 'SUPPLIER_USER');
    expect(await count(`SELECT 1 FROM bids WHERE id=$1`, [bidS])).toBe(0);
    expect(await count(`SELECT 1 FROM bid_sealed_payloads WHERE bid_id=$1`, [bidS])).toBe(0);
    expect(await count(`SELECT 1 FROM bid_items WHERE bid_id=$1`, [bidS])).toBe(0);
  });

  it('foreign supplier cannot forge a bid on behalf of another supplier', async () => {
    await as(supplierS2, 'SUPPLIER_USER');
    await expect(
      db.query(
        `INSERT INTO bids(event_id, supplier_org_id, state) VALUES ($1,$2,'SUBMITTED')`,
        [eventInvited, supplierS],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('buyer cannot modify a supplier bid', async () => {
    await as(buyerA, 'BUYER_ADMIN');
    const r = await db.query(`UPDATE bids SET state='DISQUALIFIED' WHERE id=$1`, [bidS]);
    expect(r.rowCount).toBe(0);
  });
});

describe('audit log is append-only for the app role', () => {
  let seq: number;

  it('insert is allowed within own org context', async () => {
    await as(buyerA, 'BUYER_ADMIN');
    // pg returns bigserial as a string — normalize before asserting
    seq = Number(
      (
        await db.query(
          `INSERT INTO audit_events(org_id, action, payload, hash) VALUES ($1,'TEST','{}','h1') RETURNING seq`,
          [buyerA],
        )
      ).rows[0].seq,
    );
    expect(seq).toBeGreaterThan(0);
  });

  it('UPDATE is rejected', async () => {
    await as(buyerA, 'BUYER_ADMIN');
    await expect(db.query(`UPDATE audit_events SET hash='tampered' WHERE seq=$1`, [seq])).rejects.toThrow(
      /permission denied|append-only/i,
    );
  });

  it('DELETE is rejected', async () => {
    await as(buyerA, 'BUYER_ADMIN');
    await expect(db.query(`DELETE FROM audit_events WHERE seq=$1`, [seq])).rejects.toThrow(
      /permission denied|append-only/i,
    );
  });

  it('foreign org cannot read the audit row', async () => {
    await as(buyerB, 'BUYER_ADMIN');
    expect(await count(`SELECT 1 FROM audit_events WHERE seq=$1`, [seq])).toBe(0);
  });
});
