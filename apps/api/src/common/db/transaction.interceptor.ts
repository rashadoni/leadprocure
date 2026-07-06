import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Observable, firstValueFrom, of } from 'rxjs';
import type { AccessTokenPayload } from '@leadprocure/shared';
import { RequestContextService, RequestContext } from '../context/request-context.service';

// Runs every request inside a DB transaction on a dedicated connection, sets the
// request-local app.* GUCs that back RLS, and exposes the transactional EntityManager
// via AsyncLocalStorage. Commit on success, rollback on error.
@Injectable()
export class TransactionInterceptor implements NestInterceptor {
  constructor(
    private readonly ds: DataSource,
    private readonly rc: RequestContextService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest();
    const auth = req?.auth as AccessTokenPayload | undefined;

    const qr = this.ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.query(
        `select set_config('app.actor_id', $1, true),
                set_config('app.org_id',   $2, true),
                set_config('app.role',     $3, true)`,
        [auth?.sub ?? '', auth?.org_id ?? '', auth?.role ?? ''],
      );
      const ctx: RequestContext = {
        actorId: auth?.sub,
        orgId: auth?.org_id,
        role: auth?.role,
        manager: qr.manager,
      };
      const result = await this.rc.run(ctx, () => firstValueFrom(next.handle()));
      await qr.commitTransaction();
      // Post-commit side effects (email fan-out etc.): fire-and-forget so they neither
      // delay the response nor ever run for rolled-back requests (the error path above
      // never reaches this flush).
      for (const job of ctx.postCommit ?? []) {
        Promise.resolve().then(job).catch(() => {});
      }
      return of(result);
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }
}
