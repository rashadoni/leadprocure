import { Controller, Get, Global, Injectable, Module, Param, Post } from '@nestjs/common';
import { RequestContextService } from '../context/request-context.service';

// Minimal notification center: rows are delivery-proofed (delivered_at set on insert
// for in-app delivery). RLS restricts reads to the recipient org.
@Injectable()
export class NotifyService {
  constructor(private readonly rc: RequestContextService) {}

  // NOTE: inserting for ANOTHER org would fail RLS WITH CHECK — notifications to a
  // counterparty must be inserted via their org context or a future SECURITY DEFINER
  // seam. For MVP we notify within the acting org and broadcast cross-org via realtime.
  async notifyOwnOrg(type: string, payload: Record<string, unknown>): Promise<void> {
    await this.rc.manager.query(
      `INSERT INTO notifications(recipient_org_id, type, payload, delivered_at)
       VALUES ($1,$2,$3, now())`,
      [this.rc.orgId, type, JSON.stringify(payload)],
    );
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
