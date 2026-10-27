import { returnedRows } from '../../common/procurement/invariants';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID,
  Max, Min, MinLength, ValidateNested,
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
import { sendEmailVia, sendWhatsappVia } from '../channels/channels.module';

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
      signal: AbortSignal.timeout(30000),
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
    const rows = returnedRows(await this.rc.manager.query(
      `UPDATE followup_enrollments SET status = 'STOPPED', next_run_at = NULL, updated_at = now()
       WHERE event_id = $1 AND supplier_org_id = $2 AND (status = 'ACTIVE' OR (status='EXHAUSTED' AND EXISTS(SELECT 1 FROM followup_outbox j WHERE j.enrollment_id=followup_enrollments.id AND j.status IN ('PENDING','SENDING')))) RETURNING id`,
      [eventId, supplierOrgId],
    ));
    if (!rows.length) throw new NotFoundException('No active follow-up for this supplier');
    await this.audit.record('FOLLOWUP_STOPPED', 'followup_enrollment', rows[0].id, { event_id: eventId, supplier_org_id: supplierOrgId });
    return { ok: true };
  }

  async reconcile(eventId: string, jobId: string, decision: string, reason: string, auth: AccessTokenPayload) {
    const row=(await this.rc.manager.query(`SELECT o.id FROM followup_outbox o JOIN followup_enrollments fe ON fe.id=o.enrollment_id WHERE o.id=$1 AND fe.event_id=$2`,[jobId,eventId]))[0];
    if (!row) throw new NotFoundException('Delivery job not found');
    await this.rc.manager.query(`SELECT followup_reconcile_outbox($1,$2,$3)`,[jobId,decision,reason]);
    await this.audit.record('FOLLOWUP_RECONCILED','followup_outbox',jobId,{decision,reason});
    return {ok:true};
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
              COALESCE((SELECT jsonb_agg(jsonb_build_object('id',j.id,'status',j.status,'recipient',j.recipient,'attempts',j.attempts)) FROM followup_outbox j WHERE j.enrollment_id=fe.id),'[]'::jsonb) AS jobs,
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
// Retries before dispatch are bounded. Ambiguous post-dispatch failures require review.
@Injectable()
export class FollowupsScheduler {
  private readonly logger = new Logger(FollowupsScheduler.name);
  constructor(
    private readonly ds: DataSource,
    private readonly mail: MailProvider,
    private readonly wa: WhatsAppProvider,
    private readonly cfg: AppConfig,
  ) {}

  private ticking = false;
  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    let count = 0;
    try {
    for (let i=0;i<50;i++) {
      const [job] = await this.ds.query(`SELECT * FROM followup_claim_outbox()`);
      if (!job) break;
      count++;
      const w=job.work;
      const finish = (status:string,detail?:string,provider?:string) => this.ds.query(
        `SELECT followup_finish_outbox($1,$2,$3,$4)`,[job.id,status,detail ?? null,provider ?? null]);
      let dispatched=false;
      try {
        const allowed=(await this.ds.query(`SELECT followup_dispatch_allowed($1) AS allowed`,[job.id]))[0]?.allowed;
        if (!allowed) {await finish('CANCELLED');continue;}
        if (job.recipient==='-') {await finish('SKIPPED','No recipient');continue;}
        const cfg=(await this.ds.query(`SELECT channel_config_get($1,$2) AS c`,[job.buyer_org_id,w.channel]))[0]?.c;
        const deadline=w.close_at ? new Date(w.close_at).toISOString() : '—';
        const text=`${w.buyer_name} · Leadprocure\n${w.event_title}\nSon təqdimetmə tarixi: ${deadline}\n${this.cfg.webBaseUrl}`;
        // Recheck immediately before handing the message to an external provider.
        if (!(await this.ds.query(`SELECT followup_dispatch_allowed($1) AS allowed`,[job.id]))[0]?.allowed) {await finish('CANCELLED');continue;}
        let provider:string|undefined;
        if (w.channel==='EMAIL') {
          if (!cfg?.host && this.mail.kind==='console') {await finish('NOT_CONFIGURED');continue;}
          dispatched=true;
          if (cfg?.host) await sendEmailVia(cfg,job.recipient,'Leadprocure · Tender xatırlatması',text);
          else await this.mail.send({to:job.recipient,subject:'Leadprocure · Tender xatırlatması',text,html:`<pre>${text.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]!))}</pre>`});
        } else {
          if (!cfg?.phoneNumberId && this.wa.kind==='console') {await finish('NOT_CONFIGURED');continue;}
          dispatched=true;
          if (cfg?.phoneNumberId) provider=await sendWhatsappVia(cfg,job.recipient,text);
          else await this.wa.send(job.recipient,text);
        }
        await finish('SENT',undefined,provider);
      } catch(e:any) {
        // A timeout after dispatch is ambiguous, not proof that delivery failed.
        // Preserve it for reconciliation rather than risking duplicate supplier messages.
        await finish(dispatched ? 'UNKNOWN':'FAILED',String(e?.message ?? 'Delivery failed').slice(0,300));
      }
    }
    if (count) this.logger.log(`follow-ups: advanced ${count} chain step(s)`);
    return count;
    } finally { this.ticking = false; }
  }
}

class ReconcileDto {
  @IsIn(['CONFIRMED_SENT','CONFIRMED_NOT_SENT']) decision!: string;
  @IsString() @MinLength(10) reason!: string;
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

  @Post('events/:id/followups/jobs/:jobId/reconcile')
  @Roles('BUYER_ADMIN','BUYER_APPROVER')
  reconcile(@Param('id') id:string,@Param('jobId') jobId:string,@Body() dto:ReconcileDto,@CurrentUser() auth:AccessTokenPayload) {
    return this.followups.reconcile(id,jobId,dto.decision,dto.reason,auth);
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
