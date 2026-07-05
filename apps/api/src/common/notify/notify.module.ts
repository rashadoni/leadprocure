import { Controller, Get, Global, Injectable, Module, Param, Post } from '@nestjs/common';
import { RequestContextService } from '../context/request-context.service';

// Minimal notification center: rows are delivery-proofed (delivered_at set on insert
// for in-app delivery). RLS restricts reads to the recipient org.
@Injectable()
export class NotifyService {
  constructor(private readonly rc: RequestContextService) {}

  async notifyOwnOrg(type: string, payload: Record<string, unknown>): Promise<void> {
    await this.notifyOrg(this.rc.orgId!, type, payload);
  }

  // Notify ANY org (self or counterparty) via the SECURITY DEFINER seam. Best-effort:
  // a notification failure must never break the business action that triggered it.
  async notifyOrg(orgId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.rc.manager.query(`SELECT app_notify($1, NULL, $2, $3::jsonb)`, [
        orgId,
        type,
        JSON.stringify(payload),
      ]);
    } catch {
      /* best-effort */
    }
  }
}

@Controller('notifications')
export class NotifyController {
  constructor(private readonly rc: RequestContextService) {}

  @Get()
  async list() {
    return this.rc.manager.query(
      `SELECT id, type, payload, delivered_at, read_at, created_at
       FROM notifications ORDER BY created_at DESC LIMIT 100`,
    );
  }

  @Post(':id/read')
  async read(@Param('id') id: string) {
    await this.rc.manager.query(`UPDATE notifications SET read_at = now() WHERE id = $1`, [id]);
    return { ok: true };
  }
}

@Global()
@Module({ controllers: [NotifyController], providers: [NotifyService], exports: [NotifyService] })
export class NotifyModule {}
