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
