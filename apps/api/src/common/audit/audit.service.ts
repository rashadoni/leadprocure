import { createHash } from 'crypto';
import { Global, Injectable, Module } from '@nestjs/common';
import type { AuditAction } from '@leadprocure/shared';
import { RequestContextService } from '../context/request-context.service';

// Append-only, hash-chained audit. Each org has its own chain: hash = sha256(prevHash + body).
// The DB enforces immutability (trigger blocks UPDATE/DELETE; UPDATE/DELETE revoked from app_user).
@Injectable()
export class AuditService {
  constructor(private readonly rc: RequestContextService) {}

  async record(
    action: AuditAction,
    entityType: string | null,
    entityId: string | null,
    payload: Record<string, unknown> = {},
  ): Promise<string> {
    const m = this.rc.manager;
    const orgId = this.rc.orgId ?? null;
    const actorId = this.rc.actorId ?? null;

    const prevRows: Array<{ hash: string }> = orgId
      ? await m.query(`SELECT hash FROM audit_events WHERE org_id = $1 ORDER BY seq DESC LIMIT 1`, [orgId])
      : [];
    const prevHash = prevRows[0]?.hash ?? null;

    const body = JSON.stringify({
      action,
      entityType,
      entityId,
      payload,
      orgId,
      actorId,
      at: new Date().toISOString(),
    });
    const hash = createHash('sha256')
      .update((prevHash ?? '') + body)
      .digest('hex');

    await m.query(
      `INSERT INTO audit_events(actor_id, org_id, action, entity_type, entity_id, payload, prev_hash, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [actorId, orgId, action, entityType, entityId, JSON.stringify(payload), prevHash, hash],
    );
    return hash;
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
