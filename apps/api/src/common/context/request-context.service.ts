import { AsyncLocalStorage } from 'async_hooks';
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

// Per-request context stored in AsyncLocalStorage. `manager` is the request's
// transactional EntityManager (from the QueryRunner opened by TransactionInterceptor),
// and the app.* GUCs backing PostgreSQL RLS are set on that same connection/transaction.
export interface RequestContext {
  actorId?: string;
  orgId?: string;
  role?: string;
  manager: EntityManager;
  // Jobs to run AFTER the request transaction commits (e.g. outbound email fan-out).
  // Never run on rollback — side effects must not fire for actions that didn't happen.
  postCommit?: Array<() => void | Promise<void>>;
}

@Injectable()
export class RequestContextService {
  private readonly als = new AsyncLocalStorage<RequestContext>();

  run<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
    return this.als.run(ctx, fn);
  }

  optional(): RequestContext | undefined {
    return this.als.getStore();
  }

  get(): RequestContext {
    const ctx = this.als.getStore();
    if (!ctx) throw new Error('No request context: not running inside a transaction');
    return ctx;
  }

  get manager(): EntityManager {
    return this.get().manager;
  }

  get orgId(): string | undefined {
    return this.optional()?.orgId;
  }

  get actorId(): string | undefined {
    return this.optional()?.actorId;
  }

  // Queue a side effect for after the transaction commits. Outside a request context
  // (background jobs run without one) the job fires immediately, fire-and-forget.
  onCommit(fn: () => void | Promise<void>): void {
    const ctx = this.optional();
    if (!ctx) {
      Promise.resolve().then(fn).catch(() => {});
      return;
    }
    (ctx.postCommit ??= []).push(fn);
  }

  // The acting person, for the paths that authenticate inside the request instead of
  // arriving with a token: register and login. Without it their own audit rows name no
  // actor, which on a login is the entire content of the record. What attributes the row
  // is ctx.actorId — AuditService reads it and passes it to audit_append as a parameter.
  // The GUC is set for a different reader: the SECURITY DEFINER seams (po_apply_status,
  // po_amendment_decide) take app.actor_id to stamp who decided something, so the two
  // ways of knowing the actor cannot drift apart.
  async setActor(actorId: string): Promise<void> {
    const ctx = this.get();
    ctx.actorId = actorId;
    await ctx.manager.query(`select set_config('app.actor_id', $1, true)`, [actorId]);
  }

  // Used during registration: once the owning org exists we elevate the request's
  // RLS context so RLS WITH CHECK passes for rows owned by the new org.
  async setOrg(orgId: string, role?: string): Promise<void> {
    const ctx = this.get();
    ctx.orgId = orgId;
    if (role) ctx.role = role;
    await ctx.manager.query(
      `select set_config('app.org_id', $1, true), set_config('app.role', $2, true)`,
      [orgId, ctx.role ?? ''],
    );
  }
}
