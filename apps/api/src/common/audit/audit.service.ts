import { Global, Injectable, Module } from '@nestjs/common';
import type { AuditAction } from '@leadprocure/shared';
import { RequestContextService } from '../context/request-context.service';

// Append-only, hash-chained audit. Each org has its own chain: hash = sha256(prevHash + body).
// The DB enforces immutability (trigger blocks UPDATE/DELETE; UPDATE/DELETE revoked from app_user).
//
// The digest is computed by audit_append() in SQL, not here, and that is the point: it has
// to be recomputable from the stored row or it proves nothing. Building the body in JS
// could not be — the `at` that went into it was never stored (created_at defaulted to the
// transaction's now()), and `payload` was hashed as JS wrote it while the column keeps
// jsonb's own ordering. Nothing could reproduce the hash, and nothing ever tried: the only
// check in the repository compared prev_hash to the previous row's hash, which catches a
// truncated tail and nothing else. The same function serves the deadline closer, so there
// is one scheme rather than two.
@Injectable()
export class AuditService {
  constructor(private readonly rc: RequestContextService) {}

  async record(
    action: AuditAction,
    entityType: string | null,
    entityId: string | null,
    payload: Record<string, unknown> = {},
  ): Promise<string> {
    const rows = await this.rc.manager.query(
      `SELECT audit_append($1,$2,$3,$4,$5,$6::jsonb) AS hash`,
      [
        this.rc.orgId ?? null,
        this.rc.actorId ?? null,
        action,
        entityType,
        entityId,
        JSON.stringify(payload),
      ],
    );
    return rows[0].hash as string;
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
