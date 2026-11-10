import { Controller, Get, Global, Injectable, Logger, Module, Param, Post } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppConfig } from '../config/config.service';
import { MailProvider } from '../mail/mail.module';
import { RequestContextService } from '../context/request-context.service';
import { AuditService } from '../audit/audit.service';

// Human subject lines (ru · az) for outbound email; unknown types fall back to the key.
const MAIL_SUBJECTS: Record<string, string> = {
  DIRECT_ORDER_CREATED: 'Новый заказ · Yeni sifariş',
  PO_STATUS_CHANGED: 'Статус заказа изменён · Sifariş statusu dəyişdi',
  PO_AMENDMENT_PROPOSED: 'Предложено изменение заказа · Sifariş dəyişikliyi təklif olunub',
  PO_AMENDMENT_ACCEPTED: 'Изменение заказа принято · Sifariş dəyişikliyi qəbul edildi',
  PO_AMENDMENT_REJECTED: 'Изменение заказа отклонено · Sifariş dəyişikliyi rədd edildi',
  GRN_RECORDED: 'Приёмка оформлена · Qəbul rəsmiləşdirildi',
  INVOICE_SUBMITTED: 'Поступил счёт · Yeni qaimə',
  INVOICE_STATUS_CHANGED: 'Статус счёта изменён · Qaimə statusu dəyişdi',
  SUPPLIER_INVITED: 'Приглашение в тендер · Tenderə dəvət',
  BID_AWARDED: 'Вы выбраны победителем · Siz qalib seçildiniz',
  BID_NOT_AWARDED: 'Решение по тендеру принято · Tender üzrə qərar verilib',
  BID_DISQUALIFIED: 'Ставка снята с рассмотрения · Təklif baxışdan çıxarıldı',
  AWARD_STANDSTILL_WAIVED: 'Срок возражения сокращён · Etiraz müddəti qısaldılıb',
  EVENT_AWARD_CANCELLED: 'Решение по тендеру отозвано · Tender qərarı geri alındı',
  EVENT_PUBLISHED: 'Опубликован тендер · Tender dərc olunub',
  VERIFICATION_OPENED: 'Открыта верификация · Yoxlama açılıb',
  VERIFICATION_DECIDED: 'Решение по верификации · Yoxlama qərarı',
  BUDGET_THRESHOLD_CROSSED: 'Бюджет на пороге · Büdcə həddə çatdı',
  BUDGET_WEEKLY_DIGEST: 'Бюджеты под нагрузкой · Büdcələr yüklüdür',
};
// Only these payload fields may appear in an email body — a whitelist, so sealed or
// internal values can never leak into outbound mail by accident.
// `standstill_until` — срок, до которого участник может возразить против присуждения. Это
// дата, а не сумма и не чужой текст: без неё письмо «решение принято» не говорит человеку,
// есть ли ещё смысл что-то предпринимать. Причина (`reason`) в письмо не идёт — свободный
// текст один на все типы уведомлений, и пускать его в почту целым классом не стоит; её
// видно в самом продукте.
const MAIL_SAFE_KEYS = ['po_no', 'invoice_no', 'status', 'title', 'no', 'budget', 'utilization',
  'standstill_until'] as const;

// Async email fan-out to the ACTIVE users of the recipient org. Runs post-commit on its
// own connection (DataSource, no request tx). Every failure is swallowed + logged: email
// is advisory and must never affect business state.
@Injectable()
export class NotifyEmailer {
  private readonly logger = new Logger(NotifyEmailer.name);
  constructor(
    private readonly ds: DataSource,
    private readonly mail: MailProvider,
    private readonly cfg: AppConfig,
  ) {}

  // `userId` narrows the fan-out to one person. Some notices have a named owner (the
  // department answerable for a budget), and mailing the whole org instead turns a
  // targeted signal into noise everybody learns to ignore.
  async fanOut(
    orgId: string,
    type: string,
    payload: Record<string, unknown>,
    userId?: string | null,
  ): Promise<void> {
    try {
      const recipients = (addressee: string | null): Promise<Array<{ email: string; full_name: string }>> =>
        this.ds.query(
          `SELECT u.email, u.full_name FROM organization_users u
           JOIN memberships m ON m.user_id = u.id
           WHERE m.org_id = $1 AND u.status = 'ACTIVE'
             AND ($2::uuid IS NULL OR u.id = $2)
           ORDER BY u.created_at LIMIT 50`,
          [orgId, addressee],
        );
      let users = await recipients(userId ?? null);
      // An addressed fan-out that matches nobody must WIDEN, not fall silent. The two
      // filters above are ANDed, so a named recipient who has been deactivated — or who is
      // no longer a member — empties the list, and returning here meant the notice reached
      // NO ONE, while "nobody is named" reached everybody. A budget alarm went nowhere and
      // nothing said so. NotifyService resolves the recipient before calling this, and
      // records the widening in the audit trail; this guard keeps the invariant of the
      // fan-out itself, for any caller, and says so in the log.
      if (!users.length && userId) {
        this.logger.warn(
          `fan-out ${type} → org ${orgId}: addressed user ${userId} has no active mailbox here; widening to the organization`,
        );
        users = await recipients(null);
      }
      if (!users.length) return;
      const subject = `Leadprocure — ${MAIL_SUBJECTS[type] ?? type}`;
      const details = MAIL_SAFE_KEYS
        .filter((k) => payload[k] != null && payload[k] !== '')
        .map((k) => `${k}: ${payload[k]}`)
        .join('\n');
      for (const u of users) {
        const text = `Salam / Здравствуйте, ${u.full_name}!\n\n${MAIL_SUBJECTS[type] ?? type}\n${details ? `\n${details}\n` : ''}\n→ ${this.cfg.webBaseUrl}\n\n— Leadprocure`;
        await this.mail
          .send({ to: u.email, subject, html: `<pre>${text}</pre>`, text })
          .catch((e) => this.logger.warn(`mail to ${u.email} failed: ${e?.message}`));
      }
    } catch (e: any) {
      this.logger.warn(`fan-out ${type} → org ${orgId} failed: ${e?.message}`);
    }
  }
}

// Minimal notification center: rows are delivery-proofed (delivered_at set on insert
// for in-app delivery). RLS restricts reads to the recipient org.
@Injectable()
export class NotifyService {
  private readonly logger = new Logger(NotifyService.name);
  constructor(
    private readonly rc: RequestContextService,
    private readonly emailer: NotifyEmailer,
    private readonly audit: AuditService,
  ) {}

  async notifyOwnOrg(type: string, payload: Record<string, unknown>): Promise<void> {
    await this.notifyOrg(this.rc.orgId!, type, payload);
  }

  // Notify ANY org (self or counterparty) via the SECURITY DEFINER seam. Best-effort:
  // a notification failure must never break the business action that triggered it.
  // Email fan-out is queued for AFTER the transaction commits, so rolled-back actions
  // never send mail.
  async notifyOrg(orgId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    return this.deliver(orgId, null, type, payload);
  }

  // Same seam, addressed to ONE recipient: the in-app row carries recipient_user_id and
  // only that person is mailed. Pass a null userId to fall back to the whole org.
  async notifyUser(
    orgId: string,
    userId: string | null,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    return this.deliver(orgId, userId, type, payload);
  }

  private async deliver(
    orgId: string,
    userId: string | null,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      const recipient = await this.reachableRecipient(orgId, userId, type);
      await this.rc.manager.query(`SELECT app_notify($1, $2, $3, $4::jsonb)`, [
        orgId,
        recipient,
        type,
        JSON.stringify(payload),
      ]);
      this.rc.onCommit(() => this.emailer.fanOut(orgId, type, payload, recipient));
    } catch {
      /* best-effort */
    }
  }

  // An addressed notice is NARROWER than an unaddressed one, so a named recipient who
  // cannot receive it has to widen back to the whole organisation — the same fallback as
  // "nobody is named" — instead of silencing it. Two ways that happens: the person is
  // deactivated (they cannot sign in, so the in-app row would never be read, and the mail
  // fan-out skips them), or the id is stale because they are no longer a member at all.
  // Nothing kept the department column in step with either event.
  //
  // The widening is AUDITED, in the transaction that caused it, because afterwards
  // "everybody was told" and "nobody was told" are the same silence. A log line alone would
  // not do: whoever asks why forty people received a budget alarm — or why the one person
  // answerable for it did not — should find the answer beside the approval that raised it.
  private async reachableRecipient(
    orgId: string,
    userId: string | null,
    type: string,
  ): Promise<string | null> {
    if (!userId) return null;
    const live = await this.rc.manager.query(
      `SELECT 1 FROM memberships m JOIN organization_users u ON u.id = m.user_id
        WHERE m.org_id = $1 AND m.user_id = $2 AND u.status = 'ACTIVE'`,
      [orgId, userId],
    );
    if (live.length) return userId;
    const reason = 'addressed recipient is not an active member of the recipient organization';
    this.logger.warn(`${type} → org ${orgId}: ${reason} (user ${userId}); notifying the organization instead`);
    await this.audit.record('NOTIFICATION_WIDENED_TO_ORG', 'notification', null, {
      type,
      recipient_org_id: orgId,
      intended_user_id: userId,
      reason,
    });
    return null;
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

  // A PO walking its own lifecycle emits one notification per step, so a handful of orders
  // puts dozens on the page and clearing them one at a time is not a real option.
  // RLS scopes the UPDATE to the reader's own organisation.
  @Post('read-all')
  async readAll() {
    await this.rc.manager.query(`UPDATE notifications SET read_at = now() WHERE read_at IS NULL`);
    return { ok: true };
  }

  @Post(':id/read')
  async read(@Param('id') id: string) {
    await this.rc.manager.query(`UPDATE notifications SET read_at = now() WHERE id = $1`, [id]);
    return { ok: true };
  }
}

@Global()
@Module({
  controllers: [NotifyController],
  providers: [NotifyService, NotifyEmailer],
  exports: [NotifyService],
})
export class NotifyModule {}
