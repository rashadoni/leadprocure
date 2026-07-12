import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID,
  Max, Min, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  BadRequestException, Body, Controller, Get, Injectable, Logger, Module,
  NotFoundException, Param, Post, Put,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import type { AccessTokenPayload, FollowupChannel, FollowupStep } from '@leadprocure/shared';
import { DEFAULT_FOLLOWUP_STEPS, FOLLOWUP_CHANNELS } from '@leadprocure/shared';
import { CurrentUser, RequiresFeature, Roles } from '../../common/auth/decorators';
import { RequestContextService } from '../../common/context/request-context.service';
import { AuditService } from '../../common/audit/audit.service';
import { AppConfig } from '../../common/config/config.service';
import { MailProvider } from '../../common/mail/mail.module';

class StepDto {
  @IsIn(FOLLOWUP_CHANNELS as unknown as string[]) channel!: FollowupChannel;
  @IsInt() @Min(1) @Max(24 * 90) afterHours!: number; // 1h … 90 days
}
class PlanDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10)
  @ValidateNested({ each: true }) @Type(() => StepDto)
  steps!: StepDto[];
}
class EnrollDto {
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) supplierOrgIds?: string[];
}

// ---- WhatsApp provider seam (same shape as MailProvider: console fallback, HTTP when
// configured). The HTTP provider posts a minimal {from,to,body} JSON — adjust the URL
// to a Twilio-compatible gateway in env; no amounts ever go into the message text.
export abstract class WhatsAppProvider {
  abstract readonly kind: string;
  abstract send(to: string, text: string): Promise<void>;
}

@Injectable()
export class ConsoleWhatsAppProvider extends WhatsAppProvider {
  readonly kind = 'console';
  private readonly logger = new Logger('WhatsApp');
  async send(to: string, text: string): Promise<void> {
    this.logger.log(`📱 to=${to}\n${text}`);
  }
}

@Injectable()
export class HttpWhatsAppProvider extends WhatsAppProvider {
  readonly kind = 'http';
  constructor(private readonly url: string, private readonly token: string, private readonly from: string) { super(); }
  async send(to: string, text: string): Promise<void> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ from: this.from, to, body: text }),
    });
    if (!res.ok) throw new Error(`WhatsApp gateway ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

// Buyer-facing CRUD: the org's chain plan + per-event enrollments. Request paths run on
// rc.manager (RLS-scoped); everything the ticker needs crosses org boundaries and lives
// in the SECURITY DEFINER functions from migration 0024 instead.
@Injectable()
export class FollowupsService {
  constructor(
    private readonly rc: RequestContextService,
    private readonly audit: AuditService,
  ) {}

  async plan(auth: AccessTokenPayload) {
    const rows = await this.rc.manager.query(`SELECT steps FROM followup_plans WHERE buyer_org_id = $1`, [auth.org_id]);
    return rows.length ? { steps: rows[0].steps, isDefault: false } : { steps: DEFAULT_FOLLOWUP_STEPS, isDefault: true };
  }

  async setPlan(dto: PlanDto, auth: AccessTokenPayload) {
    await this.rc.manager.query(
      `INSERT INTO followup_plans(buyer_org_id, steps) VALUES ($1, $2)
       ON CONFLICT (buyer_org_id) DO UPDATE SET steps = $2, updated_at = now()`,
      [auth.org_id, JSON.stringify(dto.steps)],
    );
    await this.audit.record('FOLLOWUP_PLAN_UPDATED', 'followup_plan', auth.org_id, { steps: dto.steps.length });
    return this.plan(auth);
  }

  // Enroll invited suppliers of the event into the chain. Suppliers that already
  // responded are skipped; re-enrolling is a no-op (unique pair).
  async enroll(eventId: string, dto: EnrollDto, auth: AccessTokenPayload) {
    const m = this.rc.manager;
    const ev = (await m.query(
      `SELECT id, status, title FROM sourcing_events WHERE id = $1 AND buyer_org_id = $2`,
      [eventId, auth.org_id],
    ))[0];
    if (!ev) throw new NotFoundException('Event not found');
    if (!['PUBLISHED', 'OPEN'].includes(ev.status)) {
      throw new BadRequestException('Follow-ups only run while bidding is open');
    }

    const invited: Array<{ supplier_org_id: string }> = await m.query(
      `SELECT supplier_org_id FROM event_invitations WHERE event_id = $1`, [eventId],
    );
    const wanted = dto.supplierOrgIds?.length
      ? invited.filter((i) => dto.supplierOrgIds!.includes(i.supplier_org_id))
      : invited;
    if (!wanted.length) throw new BadRequestException('No invited suppliers to enroll');

    const { steps } = await this.plan(auth);
    const firstDelay = Number((steps as FollowupStep[])[0].afterHours);
    let enrolled = 0;
    for (const w of wanted) {
      // Already responded → nothing to chase.
      const hasBid = (await m.query(
        `SELECT 1 FROM bids WHERE event_id = $1 AND supplier_org_id = $2 AND state <> 'WITHDRAWN' LIMIT 1`,
        [eventId, w.supplier_org_id],
      )).length > 0;
      if (hasBid) continue;
      const ins = await m.query(
        `INSERT INTO followup_enrollments(event_id, buyer_org_id, supplier_org_id, steps, next_run_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5::int))
         ON CONFLICT (event_id, supplier_org_id) DO NOTHING RETURNING id`,
        [eventId, auth.org_id, w.supplier_org_id, JSON.stringify(steps), firstDelay],
      );
      enrolled += ins.length;
    }
    await this.audit.record('FOLLOWUP_ENROLLED', 'sourcing_event', eventId, { enrolled });
    return this.list(eventId, auth);
  }

  async stop(eventId: string, supplierOrgId: string, auth: AccessTokenPayload) {
    const rows = await this.rc.manager.query(
      `UPDATE followup_enrollments SET status = 'STOPPED', next_run_at = NULL, updated_at = now()
       WHERE event_id = $1 AND supplier_org_id = $2 AND status = 'ACTIVE' RETURNING id`,
      [eventId, supplierOrgId],
    );
    if (!rows.length) throw new NotFoundException('No active follow-up for this supplier');
    await this.audit.record('FOLLOWUP_STOPPED', 'followup_enrollment', rows[0].id, { event_id: eventId, supplier_org_id: supplierOrgId });
    return { ok: true };
  }

  // Every INVITED supplier is a row (not only enrolled ones), so the UI can show the
  // whole picture at once: already responded / not in a chain yet / chain progress.
  // Per-row `messages` carries the send history for an expandable timeline.
  async list(eventId: string, _auth: AccessTokenPayload) {
    return this.rc.manager.query(
      `SELECT ei.supplier_org_id, o.legal_name AS supplier_name,
              (fe.id IS NOT NULL) AS enrolled,
              EXISTS(SELECT 1 FROM bids b WHERE b.event_id = ei.event_id
                       AND b.supplier_org_id = ei.supplier_org_id AND b.state <> 'WITHDRAWN') AS has_bid,
              fe.status, fe.current_step,
              COALESCE(jsonb_array_length(fe.steps), 0) AS total_steps,
              fe.steps, fe.next_run_at,
              COALESCE((SELECT count(*)::int FROM followup_messages fm WHERE fm.enrollment_id = fe.id), 0) AS sent_count,
              COALESCE((SELECT jsonb_agg(jsonb_build_object(
                          'step_no', fm.step_no, 'channel', fm.channel, 'recipient', fm.recipient,
                          'status', fm.status, 'at', fm.created_at) ORDER BY fm.created_at)
                        FROM followup_messages fm WHERE fm.enrollment_id = fe.id), '[]'::jsonb) AS messages
       FROM event_invitations ei
       JOIN organizations o ON o.id = ei.supplier_org_id
       LEFT JOIN followup_enrollments fe
         ON fe.event_id = ei.event_id AND fe.supplier_org_id = ei.supplier_org_id
       WHERE ei.event_id = $1
       ORDER BY o.legal_name`,
      [eventId],
    );
  }
}

// Ticker. No request context — all reads/writes go through followup_advance_due()
// (SECURITY DEFINER); the Node side only delivers messages and logs each attempt.
// Delivery failures are logged, never retried within the same step (the next step of
// the chain is the retry), and never affect business state.
@Injectable()
export class FollowupsScheduler {
  private readonly logger = new Logger(FollowupsScheduler.name);
  constructor(
    private readonly ds: DataSource,
    private readonly mail: MailProvider,
    private readonly wa: WhatsAppProvider,
    private readonly cfg: AppConfig,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<number> {
    const due: Array<{
      enrollment_id: string; step_no: number; channel: string; event_title: string;
      buyer_name: string; close_at: string | null; emails: string[] | null; phone: string | null;
    }> = await this.ds.query(`SELECT * FROM followup_advance_due(50)`);

    for (const w of due) {
      const deadline = w.close_at ? new Date(w.close_at).toISOString().slice(0, 16).replace('T', ' ') : '—';
      // Whitelisted fields only: title, buyer, deadline, link. Never amounts.
      const text = `${w.buyer_name} · Leadprocure\n\nNapominaniye / Xatırlatma: tender "${w.event_title}" hələ açıqdır — приглашение ещё открыто.\nDeadline / Son tarix: ${deadline} (UTC)\n\n→ ${this.cfg.webBaseUrl}`;
      const log = (recipient: string, status: 'SENT' | 'FAILED' | 'SKIPPED', detail?: string) =>
        this.ds.query(`SELECT followup_log_message($1, $2, $3, $4, $5, $6)`, [
          w.enrollment_id, w.step_no, w.channel, recipient, status, detail ?? null,
        ]).catch((e) => this.logger.warn(`log_message failed: ${e?.message}`));

      if (w.channel === 'EMAIL') {
        for (const to of w.emails ?? []) {
          try {
            await this.mail.send({
              to,
              subject: `Leadprocure — Напоминание о тендере · Tender xatırlatması`,
              html: `<pre>${text}</pre>`,
              text,
            });
            await log(to, 'SENT');
          } catch (e: any) {
            await log(to, 'FAILED', e?.message?.slice(0, 300));
          }
        }
        if (!w.emails?.length) await log('-', 'SKIPPED', 'no active users');
      } else if (w.channel === 'WHATSAPP') {
        if (!w.phone) {
          await log('-', 'SKIPPED', 'no phone on supplier org');
        } else {
          try {
            await this.wa.send(w.phone, text);
            await log(w.phone, 'SENT');
          } catch (e: any) {
            await log(w.phone, 'FAILED', e?.message?.slice(0, 300));
          }
        }
      }
    }
    if (due.length) this.logger.log(`follow-ups: advanced ${due.length} chain step(s)`);
    return due.length;
  }
}

@Controller()
@RequiresFeature('outreach.followups')
export class FollowupsController {
  constructor(private readonly followups: FollowupsService) {}

  @Get('settings/followup-plan')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER')
  plan(@CurrentUser() auth: AccessTokenPayload) {
    return this.followups.plan(auth);
  }

  @Put('settings/followup-plan')
  @Roles('BUYER_ADMIN')
  setPlan(@Body() dto: PlanDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.followups.setPlan(dto, auth);
  }

  @Get('events/:id/followups')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER')
  list(@Param('id') id: string, @CurrentUser() auth: AccessTokenPayload) {
    return this.followups.list(id, auth);
  }

  @Post('events/:id/followups')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  enroll(@Param('id') id: string, @Body() dto: EnrollDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.followups.enroll(id, dto, auth);
  }

  @Post('events/:id/followups/:supplierOrgId/stop')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  stop(
    @Param('id') id: string,
    @Param('supplierOrgId') supplierOrgId: string,
    @CurrentUser() auth: AccessTokenPayload,
  ) {
    return this.followups.stop(id, supplierOrgId, auth);
  }
}

@Module({
  providers: [
    FollowupsService,
    FollowupsScheduler,
    {
      provide: WhatsAppProvider,
      useFactory: () =>
        process.env.WHATSAPP_API_URL
          ? new HttpWhatsAppProvider(
              process.env.WHATSAPP_API_URL,
              process.env.WHATSAPP_TOKEN ?? '',
              process.env.WHATSAPP_FROM ?? 'leadprocure',
            )
          : new ConsoleWhatsAppProvider(),
    },
  ],
  controllers: [FollowupsController],
  exports: [FollowupsService],
})
export class FollowupsModule {}
