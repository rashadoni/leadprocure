import { recommendationCopy } from '../../common/ai/recommendation-copy';
import { lockEvent, assertSupplierAllowed, safeMoney, lineMoney, returnedRows } from '../../common/procurement/invariants';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AMOUNTS_VISIBLE_FROM, type AccessTokenPayload } from '@leadprocure/shared';
import { pageFrom, parsePaging, Paging } from '../../common/http/paging';
import { RequestContextService } from '../../common/context/request-context.service';
import { AuditService } from '../../common/audit/audit.service';
import { assertVisibilityAllowed } from './visibility-rule';
import { SealedCryptoService } from '../../common/crypto/sealed.service';
import { SignatureProvider } from '../../common/signature/signature.provider';
import { EntitlementService, QuotaService } from '../../common/license/entitlement.service';
import { AiScorer } from '../../common/ai/ai-scorer';
import { MailProvider } from '../../common/mail/mail.module';
import { AppConfig } from '../../common/config/config.service';
import { NotifyService } from '../../common/notify/notify.module';

interface SealedBidPayload {
  items: Array<{ event_item_id: string; unit_price_minor: number }>;
  total_minor: number | null; // null for RFI (no prices)
  currency: string;
  delivery_days: number | null;
  // RFP: technical proposal sealed WITH the prices; RFI: the response itself.
  // Never exposed to the buyer before the opening ceremony.
  proposal_text?: string | null;
}

@Injectable()
export class SourcingService {
  constructor(
    private readonly rc: RequestContextService,
    private readonly audit: AuditService,
    private readonly sealed: SealedCryptoService,
    private readonly signature: SignatureProvider,
    private readonly entitlements: EntitlementService,
    private readonly quota: QuotaService,
    private readonly emitter: EventEmitter2,
    private readonly aiScorer: AiScorer,
    private readonly mail: MailProvider,
    private readonly cfg: AppConfig,
    private readonly notify: NotifyService,
  ) {}

  // AI recommendation — only once amounts are open (RLS + status gate both enforce this).
  async aiRecommendation(eventId: string, auth: AccessTokenPayload, lotId?: string, language = 'en') {
    const ev = await this.requireEvent(eventId, ['EVALUATION', 'AWARDED']);
    if (ev.type === 'RFI') throw new BadRequestException('RFI does not support scoring');
    const lots = await this.rc.manager.query(`SELECT id FROM event_lots WHERE event_id=$1`,[eventId]);
    if ((lotId && !lots.some((l:any)=>l.id===lotId)) || (!lotId && lots.length>1)) throw new BadRequestException('Select a valid lot for comparable recommendations');
    if (!['az','ru','en'].includes(language)) throw new BadRequestException('Unsupported language');
    return recommendationCopy(await this.aiScorer.recommend(eventId, lotId ?? lots[0]?.id), language);
  }

  // ---------- buyer: create + publish ----------

  // Default weighting mirrors the built-in evaluate UX (70% price / 30% delivery).
  // Validates keys + that weights sum to exactly 100.
  private normalizeCriteria(input?: Array<{ key: string; weight: number }>): Array<{ key: string; weight: number }> {
    const criteria = input?.length ? input : [{ key: 'price', weight: 70 }, { key: 'delivery', weight: 30 }];
    const seen = new Set<string>();
    for (const c of criteria) {
      const key = String(c.key ?? '').trim();
      if (!key) throw new BadRequestException('Criterion key required');
      if (seen.has(key)) throw new BadRequestException(`Duplicate criterion ${key}`);
      seen.add(key);
      if (!Number.isFinite(c.weight) || c.weight < 0) throw new BadRequestException('Criterion weight must be ≥ 0');
    }
    const sum = criteria.reduce((s, c) => s + c.weight, 0);
    if (Math.abs(sum - 100) > 0.001) throw new BadRequestException('Criteria weights must sum to 100');
    return criteria.map((c) => ({ key: String(c.key).trim(), weight: c.weight }));
  }

  async createFromRequest(
    requestId: string,
    dto: {
      title?: string; closeAt: string; visibility?: 'PUBLIC' | 'INVITED'; visibilityReason?: string;
      type?: 'RFQ' | 'RFP' | 'RFI';
      criteria?: Array<{ key: string; weight: number }>;
    },
    auth: AccessTokenPayload,
  ) {
    // License gate: new work blocked when expired_restricted/revoked; live events keep running.
    this.entitlements.assertCanCreateNew();
    await this.quota.consumeMonthlyEvent(auth.org_id);

    const m = this.rc.manager;
    const reqRows = await m.query(`SELECT * FROM procurement_requests WHERE id = $1`, [requestId]);
    if (!reqRows.length) throw new NotFoundException('Request not found');
    const req = reqRows[0];
    if (req.status !== 'APPROVED') throw new BadRequestException('Request must be APPROVED');
    if (req.method_resolved === 'DIRECT') {
      throw new BadRequestException('Method policy resolved DIRECT — no sourcing event required');
    }
    const closeAt = new Date(dto.closeAt);
    if (!(closeAt.getTime() > Date.now())) throw new BadRequestException('closeAt must be in the future');
    // Evaluation criteria are FIXED here, before any bid is opened — they can never be
    // re-weighted after seeing prices (UNCITRAL Art. 11). RFI has no scoring.
    const type = dto.type ?? 'RFQ';
    const criteria = type === 'RFI' ? [] : this.normalizeCriteria(dto.criteria);

    const visibility = dto.visibility ?? 'INVITED';
    // Запечатанный RFQ — ОСНОВНАЯ процедура, и сужение круга здесь проходило молча, пока
    // то же правило стояло только у аукциона. Правило одно на оба пути: visibility-rule.ts.
    // RLS держит выборку в своей организации
    const hasPolicies = (await m.query(`SELECT 1 FROM procurement_method_policies LIMIT 1`)).length > 0;
    const visibilityReason = assertVisibilityAllowed(
      req.method_resolved, visibility, dto.visibilityReason, hasPolicies);

    const ev = (
      await m.query(
        `INSERT INTO sourcing_events(buyer_org_id, request_id, type, format, status, visibility, title,
           evaluation_currency, vat_mode, close_at, created_by, evaluation_criteria)
         VALUES ($1,$2,$9,'SEALED','DRAFT',$3,$4,$5,$6,$7,$8,$10::jsonb) RETURNING id`,
        [
          auth.org_id, requestId, visibility, dto.title ?? req.title,
          req.currency, req.vat_mode, closeAt.toISOString(), auth.sub,
          type, JSON.stringify(criteria),
        ],
      )
    )[0];
    // Single default lot + immutable snapshot of the request items.
    const lot = (
      await m.query(
        `INSERT INTO event_lots(event_id, lot_no, title) VALUES ($1, 1, $2) RETURNING id`,
        [ev.id, dto.title ?? req.title],
      )
    )[0];
    await m.query(
      `INSERT INTO event_items(event_id, lot_id, line_no, name, description, qty, uom, est_unit_price_minor, vat_rate_bp)
       SELECT $2, $3, line_no, name, description, qty, uom, est_unit_price_minor, vat_rate_bp
       FROM request_items WHERE request_id = $1 ORDER BY line_no`,
      [requestId, ev.id, lot.id],
    );
    if (visibilityReason) {
      await this.audit.record('AUCTION_VISIBILITY_OVERRIDDEN', 'sourcing_event', ev.id, {
        request_id: requestId, method_resolved: req.method_resolved, visibility, type,
        reason: visibilityReason,
      });
    }
    return this.detail(ev.id, auth);
  }

  async publish(eventId: string, auth: AccessTokenPayload) {
    await lockEvent(this.rc.manager, eventId);
    const m = this.rc.manager;
    const ev = await this.requireEvent(eventId, ['DRAFT']);
    this.entitlements.assertCanCreateNew();
    if (new Date(ev.close_at).getTime() <= Date.now()) {
      throw new BadRequestException('closeAt already passed');
    }
    await m.query(
      `UPDATE sourcing_events SET status='OPEN', open_at=now(), updated_at=now() WHERE id=$1`,
      [eventId],
    );
    await this.audit.record('EVENT_PUBLISHED', 'sourcing_event', eventId, { close_at: ev.close_at });
    this.rt(eventId, 'event.status', { status: 'OPEN' });
    return this.detail(eventId, auth);
  }

  // ---- multi-lot: split a DRAFT event's items into lots (award is already per-lot) ----

  async addLot(eventId: string, title: string) {
    await lockEvent(this.rc.manager, eventId);
    await this.requireEvent(eventId, ['DRAFT']);
    const m = this.rc.manager;
    const lotNo = (await m.query(`SELECT COALESCE(MAX(lot_no),0)+1 AS n FROM event_lots WHERE event_id=$1`, [eventId]))[0].n;
    const lot = (
      await m.query(`INSERT INTO event_lots(event_id, lot_no, title) VALUES ($1,$2,$3) RETURNING id, lot_no, title`, [
        eventId, lotNo, title,
      ])
    )[0];
    return lot;
  }

  async assignItemToLot(eventId: string, itemId: string, lotId: string) {
    await lockEvent(this.rc.manager, eventId);
    await this.requireEvent(eventId, ['DRAFT']);
    const m = this.rc.manager;
    const lot = await m.query(`SELECT id FROM event_lots WHERE id=$1 AND event_id=$2`, [lotId, eventId]);
    if (!lot.length) throw new NotFoundException('Lot not found on this event');
    const upd = returnedRows(await m.query(`UPDATE event_items SET lot_id=$3 WHERE id=$1 AND event_id=$2 RETURNING id`, [
      itemId, eventId, lotId,
    ]));
    if (!upd.length) throw new NotFoundException('Item not found on this event');
    return { ok: true };
  }

  async invite(eventId: string, supplierOrgId: string) {
    await lockEvent(this.rc.manager, eventId);
    const m = this.rc.manager;
    const ev = await this.requireEvent(eventId, ['DRAFT', 'OPEN']);
    await assertSupplierAllowed(m, ev.buyer_org_id, supplierOrgId);
    await m.query(
      `INSERT INTO event_invitations(event_id, supplier_org_id) VALUES ($1,$2)
       ON CONFLICT (event_id, supplier_org_id) DO NOTHING`,
      [eventId, supplierOrgId],
    );
    await this.audit.record('SUPPLIER_INVITED', 'sourcing_event', eventId, { supplier_org_id: supplierOrgId });
    void this.emailInvitedSupplier(eventId, supplierOrgId); // best-effort, non-blocking
    return { ok: true };
  }

  private async emailInvitedSupplier(eventId: string, supplierOrgId: string): Promise<void> {
    try {
      const ev = (await this.rc.manager.query(`SELECT title FROM sourcing_events WHERE id=$1`, [eventId]))[0];
      const users = await this.rc.manager.query(
        `SELECT u.email FROM memberships m JOIN organization_users u ON u.id = m.user_id
         WHERE m.org_id = $1 AND m.role = 'SUPPLIER_USER'`,
        [supplierOrgId],
      );
      const link = `${this.cfg.webBaseUrl}/supplier/events/${eventId}`;
      for (const u of users) {
        await this.mail.send({
          to: u.email,
          subject: `Leadprocure — tender invitation: ${ev?.title ?? ''}`,
          html: `<p>You are invited to submit a bid for "<b>${ev?.title ?? ''}</b>".</p><p><a href="${link}">Open the tender</a></p>`,
        });
      }
    } catch {
      /* email is best-effort; never fail the invite */
    }
  }

  // ---------- shared: list & detail (RLS decides visibility) ----------

  async list(auth: AccessTokenPayload, paging: Paging = parsePaging()) {
    const m = this.rc.manager;
    const rows = await m.query(
      `SELECT e.id, e.title, e.type, e.format, e.status, e.visibility, e.evaluation_currency,
              e.open_at, e.close_at, e.awarded_at, e.created_at, o.legal_name AS buyer_name,
              count(*) OVER()::int AS total_count,
              (SELECT count(*)::int FROM bids b WHERE b.event_id = e.id AND b.state <> 'DRAFT') AS bid_count
       FROM sourcing_events e JOIN organizations o ON o.id = e.buyer_org_id
       ORDER BY e.created_at DESC LIMIT $1 OFFSET $2`,
      [paging.limit, paging.offset],
    );
    const page = pageFrom(rows, paging);
    if (auth.role === 'SUPPLIER_USER') {
      // annotate with "did I bid" (bids RLS shows only own rows to suppliers)
      const mine = await m.query(`SELECT event_id, state FROM bids`);
      const byEvent = new Map(mine.map((b: any) => [b.event_id, b.state]));
      page.items = page.items.map((e: any) => ({ ...e, my_bid_state: byEvent.get(e.id) ?? null }));
    }
    return page;
  }

  async detail(eventId: string, auth: AccessTokenPayload) {
    const m = this.rc.manager;
    const rows = await m.query(
      `SELECT e.*, o.legal_name AS buyer_name FROM sourcing_events e
       JOIN organizations o ON o.id = e.buyer_org_id WHERE e.id = $1`,
      [eventId],
    );
    if (!rows.length) throw new NotFoundException('Event not found');
    const ev = rows[0];
    const lots = await m.query(`SELECT * FROM event_lots WHERE event_id=$1 ORDER BY lot_no`, [eventId]);
    const items = await m.query(`SELECT * FROM event_items WHERE event_id=$1 ORDER BY line_no`, [eventId]);
    const amountsVisible = AMOUNTS_VISIBLE_FROM.includes(ev.status);

    if (auth.role === 'SUPPLIER_USER') {
      const myBid = await this.myBid(eventId);
      // The buyer's own estimate is not for bidders' eyes — publishing it anchors prices.
      const supplierItems = items.map((i: any) => ({ ...i, est_unit_price_minor: null }));
      // Итоги закупки глазами участника.
      //
      // Раньше поставщик не узнавал исхода вовсе: его ставка навсегда оставалась «подана»,
      // а кто выиграл и за сколько — не показывалось нигде. Уведомление о решении без
      // страницы, на которой это решение видно, посылает человека спрашивать по телефону.
      //
      // Политика `awards_participant_select` отдаёт присуждения только тех закупок, где у
      // организации есть своя ставка; сумму победителя читаем из снимка на самом
      // присуждении, а не из чужой ставки — доступа к чужим ставкам тут нет и не нужно.
      const results = await m.query(
        // Колонки перечислены ПОИМЕННО и это не стиль: политика `awards_participant_select`
        // отдаёт строку целиком, поэтому `SELECT *` здесь отдал бы поставщику обоснование
        // покупателя (`justification`), автора решения и ссылку на оценку. Проверка на это
        // есть в `award-standstill.e2e-spec.ts`.
        //
        // `cancelled_at` участнику показывают: ему уже сказали «решение принято, возражения
        // до такого-то числа», и молча исчезнувшая строка читается как сбой.
        //
        // А `cancel_reason` НЕ показывают, и это решение, а не список колонок. Это свободный
        // текст покупателя о том, почему он отозвал решение, и он бывает про конкретного
        // поставщика — «нашли нарушение», «не прошёл проверку». Раздать такое дословно всем
        // конкурентам хуже, чем промолчать: обоснование выбора (`justification`) мы тоже не
        // отдаём, а причину дисквалификации получает только тот, кого дисквалифицировали.
        // Участнику нужен ФАКТ отзыва, чтобы не читать исчезновение как поломку; подробности
        // он спрашивает у заказчика, как и всюду в закупке.
        //
        // `a.id` в выборке — ключ строки. Отменённые присуждения видны, и у переприсуждённого
        // лота строк несколько с одним `lot_id`: ключ по лоту давал дубль, а таблица теперь
        // перерисовывается сама по истечении срока — ровно тогда дубль и проявляется.
        `SELECT a.id, a.lot_id, l.lot_no, l.title AS lot_title, a.awarded_at,
                a.winner_org_id, o.legal_name AS winner_name,
                -- Сумма победителя — только в ОТКРЫТОЙ закупке. Там её публикуют и
                -- госпорталы: это award.value в выгрузке OCDS, и скрывать её незачем. В
                -- закрытой процедуре это коммерчески чувствительная цена поставщика, которую
                -- иначе вручили бы тем самым конкурентам, против которых он играет в
                -- следующем квартале, — а для возражения она и не нужна: оспаривают своё
                -- отклонение, а не чужую цену. Отсюда и my_scores ниже.
                CASE WHEN $3 = 'PUBLIC' THEN a.winning_total_minor END AS winning_total_minor,
                a.winning_currency,
                -- Обоснование выбора участнику показывают: оно обязательно именно тогда,
                -- когда победил не первый по рангу или ставка была единственной (0020), то
                -- есть ровно в тех случаях, которые и оспаривают. Это не «внутреннее»: это
                -- причина решения, принятого в отношении участника.
                a.justification,
                a.standstill_until, a.standstill_waived_reason,
                a.cancelled_at,
                (a.winner_org_id = $2) AS won_by_me
           FROM awards a
           LEFT JOIN event_lots l ON l.id = a.lot_id
           LEFT JOIN organizations o ON o.id = a.winner_org_id
          WHERE a.event_id = $1
          ORDER BY l.lot_no NULLS LAST, a.awarded_at`,
        [eventId, auth.org_id, ev.visibility],
      );
      // Свой разбор: баллы по закреплённым критериям за СВОЮ ставку.
      //
      // Критерии с весами участник уже получает — они на самой закупке
      // (`evaluation_criteria`), закреплены при создании и после вскрытия не переписываются.
      // Не хватало собственного балла, а без него страница отвечала «за сколько выиграл
      // сосед» и молчала о том, что единственно и оспаривается.
      //
      // Берётся ПОСЛЕДНЯЯ оценка — та, по которой присуждали; `evaluations` поставщику
      // закрыта, поэтому последняя определяется по его же строкам, а не по таблице оценок.
      // Чужих баллов здесь нет и быть не может: политика `es_participant_select` отдаёт
      // только оценки собственных ставок.
      const myScores = myBid ? await m.query(
        `SELECT criterion, score::float AS score, weighted::float AS weighted
           FROM evaluation_scores
          WHERE bid_id = $1
            AND evaluation_id = (SELECT evaluation_id FROM evaluation_scores
                                  WHERE bid_id = $1 ORDER BY created_at DESC LIMIT 1)
          ORDER BY criterion`,
        [myBid.id],
      ) : [];
      return {
        ...ev, lots, items: supplierItems, my_bid: myBid, results,
        my_scores: myScores,
        my_weighted_total: myScores.length
          ? Math.round(myScores.reduce((t: number, r: any) => t + Number(r.weighted), 0) * 100) / 100
          : null,
        amounts_visible: amountsVisible,
      };
    }

    // Buyer view: participation always; amounts only once the ceremony opened them.
    // Defense-in-depth: RLS already hides bid_items/payloads pre-opening, and we also
    // strip the total column here until then.
    const bids = await m.query(
      `SELECT b.id, b.supplier_org_id, s.legal_name AS supplier_name, b.state, b.submitted_at,
              b.currency, b.delivery_days, b.total_minor, b.disqualified_reason
       FROM bids b JOIN organizations s ON s.id = b.supplier_org_id
       WHERE b.event_id = $1 ORDER BY b.submitted_at NULLS LAST`,
      [eventId],
    );
    const safeBids = bids.map((b: any) => ({
      ...b,
      total_minor: amountsVisible ? b.total_minor : null,
      delivery_days: amountsVisible ? b.delivery_days : null,
    }));
    // RFP/RFI: the technical proposal / response text is sealed with the prices and only
    // decrypted for the buyer once the ceremony opened the bids (RLS also gates payloads).
    if (amountsVisible && (ev.type === 'RFP' || ev.type === 'RFI')) {
      const payloads = await m.query(
        `SELECT p.bid_id, p.ciphertext, p.iv, p.wrapped_key FROM bid_sealed_payloads p
         JOIN bids b ON b.id = p.bid_id WHERE b.event_id = $1`,
        [eventId],
      );
      const textByBid = new Map<string, string | null>();
      for (const row of payloads) {
        try {
          const payload = this.sealed.open<SealedBidPayload>({
            ciphertext: row.ciphertext, iv: row.iv, wrappedKey: row.wrapped_key,
          });
          textByBid.set(row.bid_id, payload.proposal_text ?? null);
        } catch { /* unreadable payload → no text */ }
      }
      for (const b of safeBids) b.proposal_text = textByBid.get(b.id) ?? null;
    }
    let bidItems: any[] = [];
    let lotBidTotals: any[] = [];
    if (amountsVisible) {
      bidItems = await m.query(
        `SELECT bi.*, ei.lot_id FROM bid_items bi
         JOIN bids b ON b.id = bi.bid_id JOIN event_items ei ON ei.id = bi.event_item_id
         WHERE b.event_id = $1`,
        [eventId],
      );
      // Per-lot total for each bid → lets the buyer award each lot to the best bid.
      lotBidTotals = await m.query(
        `SELECT ei.lot_id, bi.bid_id, SUM(bi.line_total_minor)::bigint AS total_minor
         FROM bid_items bi JOIN bids b ON b.id = bi.bid_id JOIN event_items ei ON ei.id = bi.event_item_id
         WHERE b.event_id = $1 GROUP BY ei.lot_id, bi.bid_id`,
        [eventId],
      );
    }
    const scores = await m.query(
      `SELECT es.bid_id, es.criterion, es.score, es.weighted FROM evaluation_scores es
       JOIN evaluations ev2 ON ev2.id = es.evaluation_id WHERE ev2.id = (SELECT id FROM evaluations WHERE event_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1)`,
      [eventId],
    );
    const awards = await m.query(`SELECT * FROM awards WHERE event_id = $1`, [eventId]);
    return { ...ev, lots, items, bids: safeBids, bid_items: bidItems, lot_bid_totals: lotBidTotals, scores, awards, amounts_visible: amountsVisible };
  }

  // ---------- supplier: sealed bid ----------

  // Non-responsive-bid guard: for every lot the bidder priced at least one item of, ALL of that
  // lot's items must be present. Shared by sealed bids and (single-lot) reverse auctions.
  assertLotsFullyCovered(eventItems: Array<{ id: string; lot_id: string | null }>, submitted: Set<string>) {
    const itemsByLot = new Map<string, string[]>();
    for (const it of eventItems) {
      const key = String(it.lot_id ?? '_');
      const list = itemsByLot.get(key) ?? [];
      list.push(it.id);
      itemsByLot.set(key, list);
    }
    for (const itemIds of itemsByLot.values()) {
      const touched = itemIds.some((id) => submitted.has(id));
      if (touched && !itemIds.every((id) => submitted.has(id))) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'BID_LOT_INCOMPLETE',
          message: 'Incomplete lot bid is non-responsive: price every item of a lot, or omit the lot entirely',
        });
      }
    }
  }

  async submitBid(
    eventId: string,
    dto: {
      items?: Array<{ eventItemId: string; unitPriceMinor: number }>;
      currency?: string;
      deliveryDays?: number;
      proposalText?: string;
    },
    auth: AccessTokenPayload,
  ) {
    await lockEvent(this.rc.manager, eventId);
    const m = this.rc.manager;
    // Visibility is enforced by RLS: invisible events simply don't exist for this supplier.
    const evRows = await m.query(`SELECT * FROM sourcing_events WHERE id = $1`, [eventId]);
    if (!evRows.length) throw new NotFoundException('Event not found');
    const ev = evRows[0];
    await assertSupplierAllowed(m, ev.buyer_org_id, auth.org_id);
    if (dto.currency && dto.currency !== ev.evaluation_currency) throw new BadRequestException('Bid currency must match event currency');
    if (ev.type === 'AUCTION') throw new BadRequestException('Use the auction endpoint for this event');
    if (ev.status !== 'OPEN') throw new BadRequestException('Event is not open for bidding');
    if (new Date(ev.close_at).getTime() <= Date.now()) {
      throw new BadRequestException('Bidding deadline has passed'); // server-authoritative clock
    }

    // Per-type shape: RFQ = prices; RFP = prices + technical proposal; RFI = response only.
    const proposalText = dto.proposalText?.trim() || null;
    if (ev.type === 'RFI') {
      if (dto.items?.length) throw new BadRequestException('RFI does not accept priced items');
      if (!proposalText) throw new BadRequestException('RFI requires a response text');
    } else {
      // `code` beside the message, as budgets and the self-approval guard already do: the
      // client translates by code and falls back to the message, so a supplier stops being
      // answered in English on an Azerbaijani screen. The English text is left exactly as
      // it was — it is what the API's own tests read.
      if (!dto.items?.length) {
        throw new BadRequestException({ statusCode: 400, error: 'Bad Request', code: 'BID_ITEMS_REQUIRED', message: 'Bid items required' });
      }
      if (ev.type === 'RFP' && !proposalText) throw new BadRequestException('RFP requires a technical proposal');
    }

    const eventItems = await m.query(`SELECT id, qty, lot_id FROM event_items WHERE event_id = $1`, [eventId]);
    const qtyById = new Map<string, number>(eventItems.map((i: any) => [i.id, Number(i.qty)]));
    let total: number | null = null;
    if (ev.type !== 'RFI') {
      total = 0;
      const submitted = new Set<string>();
      for (const it of dto.items!) {
        const qty = qtyById.get(it.eventItemId);
        if (qty == null) throw new BadRequestException(`Unknown event item ${it.eventItemId}`);
        if (!Number.isInteger(it.unitPriceMinor) || it.unitPriceMinor < 0) {
          throw new BadRequestException('unitPriceMinor must be a non-negative integer');
        }
        if (submitted.has(it.eventItemId)) throw new BadRequestException(`Duplicate line for item ${it.eventItemId}`);
        submitted.add(it.eventItemId);
        total = safeMoney(total + lineMoney(qty, it.unitPriceMinor)); // server-side total — client totals are ignored
      }
      // Responsiveness (UNCITRAL Art. 43): a bid that touches a lot must price EVERY item of
      // that lot. Multi-lot — a supplier may omit whole lots, but a partially-priced lot is
      // non-responsive (its artificially low total would otherwise out-rank complete bids).
      this.assertLotsFullyCovered(eventItems, submitted);
    }

    const payload: SealedBidPayload = {
      items: (dto.items ?? []).map((i) => ({ event_item_id: i.eventItemId, unit_price_minor: i.unitPriceMinor })),
      total_minor: total,
      currency: dto.currency ?? ev.evaluation_currency,
      delivery_days: dto.deliveryDays ?? null,
      proposal_text: proposalText,
    };
    const blob = this.sealed.seal(payload);
    const payloadHash = this.sealed.sha256(JSON.stringify(payload));
    const sig = await this.signature.sign(payloadHash);

    // Natural idempotency: one active bid per (event, supplier); resubmission replaces it.
    const bid = (
      await m.query(
        `INSERT INTO bids(event_id, supplier_org_id, submitted_by, state, submitted_at, currency)
         VALUES ($1,$2,$3,'SUBMITTED', now(), $4)
         ON CONFLICT (event_id, supplier_org_id)
         DO UPDATE SET state='SUBMITTED', submitted_at=now(), submitted_by=$3, currency=$4,
                       total_minor=NULL, delivery_days=NULL, updated_at=now()
         RETURNING id`,
        [eventId, auth.org_id, auth.sub, payload.currency],
      )
    )[0];
    await m.query(
      `INSERT INTO bid_sealed_payloads(bid_id, ciphertext, iv, wrapped_key)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (bid_id) DO UPDATE SET ciphertext=$2, iv=$3, wrapped_key=$4, created_at=now()`,
      [bid.id, blob.ciphertext, blob.iv, blob.wrappedKey],
    );
    await this.audit.record('BID_SUBMITTED', 'bid', bid.id, {
      event_id: eventId, payload_sha256: payloadHash, signature: sig, signer: this.signature.kind,
    });
    // Follow-up chains stop the moment the supplier responds. The enrollment is a
    // buyer-private row the supplier can't touch under RLS → DEFINER seam, same tx.
    await m.query(`SELECT followup_mark_responded($1, $2)`, [eventId, auth.org_id]);
    this.rt(eventId, 'bid.activity', { bid_count_delta: 1 }); // no amounts over the wire
    return { id: bid.id, state: 'SUBMITTED', payload_sha256: payloadHash };
  }

  async withdrawBid(eventId: string, auth: AccessTokenPayload) {
    await lockEvent(this.rc.manager, eventId);
    const m = this.rc.manager;
    const ev = await this.visibleEvent(eventId);
    if (ev.status !== 'OPEN' || new Date(ev.close_at).getTime() <= Date.now()) throw new BadRequestException('Withdrawal deadline has passed');
    const rows = returnedRows(await m.query(
      `UPDATE bids SET state='WITHDRAWN', updated_at=now()
       WHERE event_id=$1 AND supplier_org_id=$2 AND state='SUBMITTED' RETURNING id`,
      [eventId, auth.org_id],
    ));
    if (!rows.length) throw new NotFoundException('No submitted bid to withdraw');
    await this.audit.record('BID_WITHDRAWN', 'bid', rows[0].id, { event_id: eventId });
    return { ok: true };
  }

  // ---------- buyer: opening ceremony, evaluation, award ----------

  async openCeremony(eventId: string, auth: AccessTokenPayload) {
    await lockEvent(this.rc.manager, eventId);
    const m = this.rc.manager;
    await m.query(`SELECT id FROM sourcing_events WHERE id=$1 FOR UPDATE`, [eventId]);
    const ev = await this.requireEvent(eventId, ['CLOSED']);
    // Церемония вскрытия — не для аукциона, и это запрет, а не придирка.
    //
    // У аукциона вскрывать нечего: ставки видны по ходу и лежат `OPENED`, а итог приводит в
    // порядок `auction/finalize` — он же создаёт `bid_items` и переводит закупку в
    // EVALUATION. Церемония формат не проверяла, находила ноль запечатанных ставок и молча
    // считала дело сделанным, оставляя закупку БЕЗ `bid_items` вовсе. Дальше присуждение
    // брало сумму лота из итога всей ставки, и на многолотовом аукционе контракт получался
    // на цену всего аукциона за один лот — ровно та выдуманная цифра, которую этот круг
    // правок и взялся прекратить.
    //
    // Запрет убирает состояние, а не компенсирует его: про этот путь пришлось рассуждать в
    // трёх коммитах подряд, и это был сигнал его закрыть, а не описывать снова.
    if (ev.format === 'REVERSE') {
      throw new BadRequestException(
        'A reverse auction has nothing to unseal — finalize it with POST /events/:id/auction/finalize');
    }

    await m.query(`UPDATE sourcing_events SET status='OPENING', updated_at=now() WHERE id=$1`, [eventId]);

    // Decrypt every submitted bid and materialize amounts (RLS ceremony policies allow
    // buyer writes only while the event is in OPENING).
    const sealedRows = await m.query(
      `SELECT b.id AS bid_id, p.ciphertext, p.iv, p.wrapped_key
       FROM bids b JOIN bid_sealed_payloads p ON p.bid_id = b.id
       WHERE b.event_id = $1 AND b.state = 'SUBMITTED'`,
      [eventId],
    );
    const receipt: Array<{ bid_id: string; payload_sha256: string; total_minor: number | null }> = [];
    for (const row of sealedRows) {
      const payload = this.sealed.open<SealedBidPayload>({
        ciphertext: row.ciphertext, iv: row.iv, wrappedKey: row.wrapped_key,
      });
      for (const it of payload.items) {
        await m.query(
          `INSERT INTO bid_items(bid_id, event_item_id, unit_price_minor, line_total_minor)
           SELECT $1, $2, $3, ($3::bigint * ei.qty)::bigint FROM event_items ei WHERE ei.id = $2`,
          [row.bid_id, it.event_item_id, it.unit_price_minor],
        );
      }
      await m.query(
        `UPDATE bids SET state='OPENED', total_minor=$2, delivery_days=$3, updated_at=now() WHERE id=$1`,
        [row.bid_id, payload.total_minor, payload.delivery_days],
      );
      receipt.push({
        bid_id: row.bid_id,
        payload_sha256: this.sealed.sha256(JSON.stringify(payload)),
        total_minor: payload.total_minor,
      });
    }

    const receiptJson = JSON.stringify({ event_id: eventId, opened_by: auth.sub, bids: receipt });
    const sig = await this.signature.sign(this.sealed.sha256(receiptJson));
    await this.audit.record('EVENT_OPENED', 'sourcing_event', eventId, {
      receipt: JSON.parse(receiptJson), signature: sig, signer: this.signature.kind,
    });
    await m.query(`UPDATE sourcing_events SET status='EVALUATION', updated_at=now() WHERE id=$1`, [eventId]);
    this.rt(eventId, 'event.status', { status: 'EVALUATION', opened_bids: receipt.length });
    return this.detail(eventId, auth);
  }

  // Scores only — the criteria and weights are the ones LOCKED on the event before opening,
  // never supplied (or changed) here. Re-evaluation is blocked while an award stands.
  async evaluate(
    eventId: string,
    dto: { scores: Array<{ bidId: string; key: string; score: number }> },
    auth: AccessTokenPayload,
  ) {
    await lockEvent(this.rc.manager, eventId);
    const m = this.rc.manager;
    const evRow = await this.requireEvent(eventId, ['EVALUATION']);
    if (evRow.type === 'RFI') throw new BadRequestException('RFI does not support evaluation');
    if ((await m.query(`SELECT 1 FROM awards WHERE event_id=$1 AND cancelled_at IS NULL LIMIT 1`, [eventId])).length) {
      throw new BadRequestException('Cancel the existing award before re-evaluating');
    }
    const criteria: Array<{ key: string; weight: number }> = evRow.evaluation_criteria ?? [];
    if (!criteria.length) throw new BadRequestException('No locked evaluation criteria on this event');
    const weightByKey = new Map(criteria.map((c) => [c.key, c.weight]));

    // scores may only reference OPENED, non-disqualified bids of THIS event
    const eligible = new Set<string>(
      (await m.query(`SELECT id FROM bids WHERE event_id=$1 AND state='OPENED'`, [eventId])).map((b: any) => b.id),
    );
    for (const s of dto.scores) {
      if (!eligible.has(s.bidId)) throw new BadRequestException(`Bid ${s.bidId} is not an opened bid on this event`);
      if (!weightByKey.has(s.key)) throw new BadRequestException(`Unknown criterion ${s.key}`);
      if (!(s.score >= 0 && s.score <= 100)) throw new BadRequestException('Score must be 0..100');
    }

    if (!eligible.size || dto.scores.length !== eligible.size * criteria.length)
      throw new BadRequestException('Every eligible bid requires every locked criterion');
    const pairs = new Set(dto.scores.map(s => `${s.bidId}:${s.key}`));
    if (pairs.size !== dto.scores.length) throw new BadRequestException('Duplicate bid criterion');

    const evaluation = (
      await m.query(
        `INSERT INTO evaluations(event_id, criteria, created_by) VALUES ($1,$2,$3) RETURNING id`,
        [eventId, JSON.stringify(criteria), auth.sub],
      )
    )[0];
    const totals = new Map<string, number>();
    for (const s of dto.scores) {
      const weighted = (s.score * weightByKey.get(s.key)!) / 100;
      totals.set(s.bidId, (totals.get(s.bidId) ?? 0) + weighted);
      await m.query(
        `INSERT INTO evaluation_scores(evaluation_id, bid_id, criterion, score, weighted)
         VALUES ($1,$2,$3,$4,$5)`,
        [evaluation.id, s.bidId, s.key, s.score, weighted],
      );
    }
    const ranking = [...totals.entries()]
      .map(([bidId, total]) => ({ bid_id: bidId, weighted_total: Math.round(total * 100) / 100 }))
      .sort((a, b) => b.weighted_total - a.weighted_total);
    await this.audit.record('EVENT_EVALUATED', 'sourcing_event', eventId, { evaluation_id: evaluation.id, criteria, ranking });
    return { evaluation_id: evaluation.id, criteria, ranking };
  }

  async award(eventId: string, dto: { lotId: string; bidId: string; justification?: string }, auth: AccessTokenPayload) {
    await lockEvent(this.rc.manager, eventId);
    const m = this.rc.manager;
    await m.query(`SELECT id FROM sourcing_events WHERE id=$1 FOR UPDATE`, [eventId]);
    // AWARDED is allowed so a retried award of the same lot stays idempotent
    const evRow = await this.requireEvent(eventId, ['EVALUATION', 'AWARDED']);
    if (evRow.type === 'RFI') throw new BadRequestException('RFI does not support awarding');

    if (!(await m.query(`SELECT id FROM event_lots WHERE id=$1 AND event_id=$2`, [dto.lotId,eventId])).length)
      throw new BadRequestException('Lot does not belong to this event');
    const supplier = (await m.query(`SELECT supplier_org_id FROM bids WHERE id=$1 AND event_id=$2`,[dto.bidId,eventId]))[0];
    if (!supplier) throw new NotFoundException('Bid not found');
    await assertSupplierAllowed(m, auth.org_id, supplier.supplier_org_id);

    // Idempotency: an ACTIVE award for the lot with the SAME bid replays; with a DIFFERENT
    // bid it's a conflict (cancel the standing award first). Runs before FOR UPDATE on bids
    // because after AWARDED the ceremony RLS no longer lets the buyer lock bid rows.
    const active = await m.query(
      `SELECT * FROM awards WHERE event_id=$1 AND lot_id=$2 AND cancelled_at IS NULL`, [eventId, dto.lotId]);
    if (active.length) {
      if (active[0].winning_bid_id === dto.bidId) return { award: active[0], idempotent: true };
      throw new BadRequestException('Lot already awarded to another bid — cancel that award first');
    }

    // A reverse auction IS the evaluation — real-time price competition ranks the bids, so
    // it awards the auction's best bid without a separate weighted scoring step.
    const isAuction = evRow.type === 'AUCTION' || evRow.format === 'REVERSE';
    if (!isAuction && (!Array.isArray(evRow.evaluation_criteria) || !evRow.evaluation_criteria.length))
      throw new BadRequestException('Legacy event has no locked evaluation criteria');
    // Otherwise the award must follow a real evaluation, and the bid must be eligible for the lot.
    const evalRows = isAuction ? [] : await m.query(
      `SELECT id FROM evaluations WHERE event_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1`, [eventId]);
    if (!isAuction && !evalRows.length) throw new BadRequestException('Evaluate the bids before awarding');
    const evaluationId = evalRows[0]?.id ?? null;
    const justification = dto.justification?.trim() || null;
    let isTop = true;
    let singleBid = false;
    if (isAuction) {
      const best = (await m.query(`SELECT b.id FROM bids b WHERE b.event_id=$1 AND b.state='OPENED'
        AND NOT supplier_is_blocked($2,b.supplier_org_id)
        ORDER BY b.total_minor ASC, b.submitted_at ASC, b.id ASC LIMIT 1`,[eventId,auth.org_id]))[0];
      if (best?.id !== dto.bidId) throw new BadRequestException('Only the best eligible auction bid may be awarded');
    }
    if (!isAuction) {
      const incomplete = await m.query(`SELECT b.id FROM bids b WHERE b.event_id=$1 AND b.state='OPENED'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements($3::jsonb) c(value) WHERE NOT EXISTS
          (SELECT 1 FROM evaluation_scores es WHERE es.evaluation_id=$2 AND es.bid_id=b.id AND es.criterion=(c.value->>'key')))`,
        [eventId,evaluationId,JSON.stringify(evRow.evaluation_criteria)]);
      if (incomplete.length) throw new BadRequestException('Evaluation is incomplete');
      const scoreRows = await m.query(
        `SELECT bid_id, sum(weighted)::float AS total FROM evaluation_scores WHERE evaluation_id=$1 GROUP BY bid_id`,
        [evaluationId]);
      const totalByBid = new Map<string, number>(scoreRows.map((r: any) => [r.bid_id, Number(r.total)]));
      // eligible = OPENED (not disqualified) bids that actually bid on this lot
      const eligibleRows = await m.query(
        `SELECT DISTINCT b.id FROM bids b
           JOIN bid_items bi ON bi.bid_id = b.id
           JOIN event_items ei ON ei.id = bi.event_item_id
         WHERE b.event_id=$1 AND ei.lot_id=$2 AND b.state='OPENED'`, [eventId, dto.lotId]);
      const eligible = eligibleRows.map((r: any) => r.id);
      if (!eligible.includes(dto.bidId)) {
        throw new BadRequestException('Bid is not an eligible (opened, non-disqualified) bid for this lot');
      }
      const topBid = eligible
        .map((id: string) => ({ id, total: totalByBid.get(id) ?? -1 }))
        .sort((a: any, b: any) => b.total - a.total)[0]?.id;
      isTop = topBid === dto.bidId;
      singleBid = eligible.length <= 1;
      if ((!isTop || singleBid) && (!justification || justification.length < 3)) {
        throw new BadRequestException(
          singleBid
            ? 'Only one eligible bid — a single-source justification is required to award'
            : 'Awarding a bid that is not the top-ranked one requires a justification',
        );
      }
    }

    const bidRows = await m.query(
      `SELECT id, state, total_minor, currency FROM bids WHERE id=$1 AND event_id=$2 FOR UPDATE`,
      [dto.bidId, eventId],
    );
    if (!bidRows.length) throw new NotFoundException('Bid not found on this event');
    if (bidRows[0].state !== 'OPENED') throw new BadRequestException('Only OPENED bids can be awarded');

    // Сумма присуждения по ЛОТУ — и только по лоту.
    //
    // Здесь стоял `COALESCE(…, bids.total_minor)` «для аукциона, где позиций по лоту может
    // не быть». Условия «лот один» в нём не было, и на многолотовом аукционе он давал
    // контракт на сумму всего аукциона за один лот. Тот же изъян, что убран из бэкфилла
    // миграции 0047, одной функцией левее.
    //
    // Запасной вариант больше не нужен: единственный путь, на котором `bid_items` по лоту
    // отсутствовали, — вскрытие аукциона церемонией вместо `auction/finalize`, и он теперь
    // запрещён (см. `openCeremony`). Остальные пути строки гарантируют: в обычной закупке
    // их требует отбор допустимых ставок, в аукционе их создаёт `finalize`. Если сумма
    // всё-таки окажется пустой, снимок останется NULL и контракт откажет — честнее, чем
    // подставить цифру, которой никто не считал.
    const lotTotal = (await m.query(
      `SELECT sum(bi.line_total_minor)::bigint AS total_minor
         FROM bid_items bi JOIN event_items ei ON ei.id = bi.event_item_id
        WHERE bi.bid_id = $1 AND ei.lot_id = $2`,
      [dto.bidId, dto.lotId],
    ))[0];

    // Partial unique index (awards_active_lot) makes the award idempotent under concurrency.
    const inserted = await m.query(
      `INSERT INTO awards(event_id, lot_id, winning_bid_id, awarded_by, evaluation_id, justification,
                           standstill_until, winner_org_id, winning_total_minor, winning_currency)
       VALUES ($1,$2,$3,$4,$5,$6,
               CASE WHEN $7::int > 0 THEN now() + ($7::int * interval '1 hour') ELSE NULL END,
               $8,$9,$10)
       RETURNING id, standstill_until`,
      [eventId, dto.lotId, dto.bidId, auth.sub, evaluationId, justification,
       this.cfg.awardStandstillHours,
       supplier.supplier_org_id, lotTotal?.total_minor ?? null, bidRows[0].currency],
    );
    await m.query(`UPDATE event_lots SET awarded_bid_id=$2 WHERE id=$1`, [dto.lotId, dto.bidId]);

    const lots = await m.query(
      `SELECT count(*)::int AS remaining FROM event_lots WHERE event_id=$1 AND awarded_bid_id IS NULL`,
      [eventId],
    );
    if (lots[0].remaining === 0) {
      await m.query(
        `UPDATE sourcing_events SET status='AWARDED', awarded_at=now(), updated_at=now() WHERE id=$1`,
        [eventId],
      );
    }
    const sig = await this.signature.sign(this.sealed.sha256(`${eventId}:${dto.lotId}:${dto.bidId}`));
    await this.audit.record('EVENT_AWARDED', 'sourcing_event', eventId, {
      lot_id: dto.lotId, winning_bid_id: dto.bidId, total_minor: bidRows[0].total_minor,
      evaluation_id: evaluationId, top_ranked: isTop, single_bid: singleBid, justification,
      signature: sig, signer: this.signature.kind,
    });
      // Участников уведомляют ВСЕХ, а не одного победителя.
      //
      // Раньше здесь стоял один `notifyOrg` победителю, и проигравший не узнавал о решении
      // вовсе: его ставка навсегда оставалась «подана». Человек, готовивший предложение,
      // имеет право узнать, что решение принято, — и узнать ДО того, как присуждение станет
      // неотменяемым, иначе письмо сообщает о свершившемся. Отсюда и пауза выше: сообщение
      // без времени на ответ не лучше молчания.
      //
      // Организации берутся по лоту; дисквалифицированные исключены — им сказали отдельно
      // и со своей причиной (`disqualifyBid`).
      const participants = await this.lotParticipants(eventId, dto.lotId);
      const winnerOrg = supplier.supplier_org_id;
      const standstillUntil = inserted[0].standstill_until;
      for (const orgId of participants) {
        await this.notify.notifyOrg(
          orgId,
          orgId === winnerOrg ? 'BID_AWARDED' : 'BID_NOT_AWARDED',
          {
            event_id: eventId,
            lot_id: dto.lotId,
            // Срок возражения — часть сообщения, а не справка: без него «вы не выбраны» не
            // говорит человеку, есть ли ещё смысл что-то предпринимать.
            ...(standstillUntil ? { standstill_until: standstillUntil } : {}),
          },
        );
      }
    this.rt(eventId, 'event.awarded', { lot_id: dto.lotId });
    return { award: inserted[0], idempotent: false };
  }

  // Кто участвовал в ЛОТЕ. У `bids` нет колонки лота — участие в лоте выражено строками
  // `bid_items` по позициям этого лота, ровно так же, как в отборе допустимых ставок при
  // присуждении.
  //
  // Запасная ветка (нет ни одной строки `bid_items` по лоту → участниками считаются все
  // недисквалифицированные участники закупки) сегодня НЕ достигается ни одним путём:
  // `finalize` вставляет `bid_items` каждой аукционной ставке, обычная закупка требует их
  // в отборе допустимых, а вскрытие аукциона церемонией теперь запрещено (`openCeremony`).
  //
  // И всё-таки она оставлена — в отличие от недостижимой проверки в `waiveStandstill`,
  // которую я убрал. Разница в том, что та БРОСАЛА на невозможном состоянии, а эта лишь
  // выбирает получателей: если такое состояние когда-нибудь возникнет, молчание будет ровно
  // той поломкой, которую весь этот круг правок и закрывает, а лишнее письмо — нет.
  private async lotParticipants(eventId: string, lotId: string): Promise<string[]> {
    const m = this.rc.manager;
    const scoped = await m.query(
      `SELECT DISTINCT b.supplier_org_id FROM bids b
         JOIN bid_items bi ON bi.bid_id = b.id
         JOIN event_items ei ON ei.id = bi.event_item_id
        WHERE b.event_id = $1 AND ei.lot_id = $2 AND b.state <> 'DISQUALIFIED'`,
      [eventId, lotId],
    );
    if (scoped.length) return scoped.map((r: any) => r.supplier_org_id);
    const all = await m.query(
      `SELECT DISTINCT supplier_org_id FROM bids WHERE event_id = $1 AND state <> 'DISQUALIFIED'`,
      [eventId],
    );
    return all.map((r: any) => r.supplier_org_id);
  }

  // Buyer disqualifies an opened bid during evaluation, with a documented reason. A
  // disqualified bid drops out of ranking and can't be awarded. Can't disqualify a bid
  // that currently holds an active award (cancel the award first).
  async disqualifyBid(eventId: string, bidId: string, reason: string, auth: AccessTokenPayload) {
    await lockEvent(this.rc.manager, eventId);
    const m = this.rc.manager;
    await this.requireEvent(eventId, ['EVALUATION']);
    if (!reason || reason.trim().length < 3) throw new BadRequestException('A disqualification reason is required');
    const bid = (await m.query(`SELECT id, state FROM bids WHERE id=$1 AND event_id=$2 FOR UPDATE`, [bidId, eventId]))[0];
    if (!bid) throw new NotFoundException('Bid not found on this event');
    if (bid.state !== 'OPENED') throw new BadRequestException('Only an OPENED bid can be disqualified');
    if ((await m.query(`SELECT 1 FROM awards WHERE winning_bid_id=$1 AND cancelled_at IS NULL LIMIT 1`, [bidId])).length) {
      throw new BadRequestException('Bid holds an active award — cancel the award first');
    }
    await m.query(`UPDATE bids SET state='DISQUALIFIED', disqualified_reason=$2, updated_at=now() WHERE id=$1`,
      [bidId, reason.trim()]);
    await this.audit.record('BID_DISQUALIFIED', 'bid', bidId, { event_id: eventId, reason: reason.trim() });
    // Дисквалифицированному говорят отдельно и со своей причиной: при присуждении его уже
    // не уведомляют (он выбыл), и без этого письма он узнавал бы о снятии ставки ниоткуда.
    const dq = (await m.query(`SELECT supplier_org_id FROM bids WHERE id=$1`, [bidId]))[0];
    if (dq) {
      await this.notify.notifyOrg(dq.supplier_org_id, 'BID_DISQUALIFIED', {
        event_id: eventId, bid_id: bidId, reason: reason.trim(),
      });
    }
    return this.detail(eventId, auth);
  }

  // Письменный отказ от паузы на возражение.
  //
  // Пауза не может быть непреодолимой: закупка бывает срочной, и система, которая не
  // оставляет человеку выхода, получает выход в обход себя. Продукт уже решает это так же
  // с блокировкой по бюджету (`BUDGET_BLOCK_OVERRIDDEN`): пройти можно, но под своей
  // подписью и с написанной причиной. Короткая отписка не принимается — ограничение в БД
  // требует не меньше десяти знаков, и то же проверяется здесь, чтобы ответ был внятным,
  // а не 500-й от нарушения CHECK.
  //
  // Право на это — только у BUYER_ADMIN: отказ от паузы снимает защиту второй стороны, и
  // это решение уровня организации, а не того, кто ведёт конкретный лот.
  async waiveStandstill(eventId: string, lotId: string, reason: string, auth: AccessTokenPayload) {
    const m = this.rc.manager;
    const text = (reason ?? '').trim();
    if (text.length < 10) {
      throw new BadRequestException('A written reason (at least 10 characters) is required to waive the standstill');
    }
    const award = (await m.query(
      `SELECT * FROM awards WHERE event_id=$1 AND lot_id=$2 AND cancelled_at IS NULL FOR UPDATE`,
      [eventId, lotId]))[0];
    if (!award) throw new NotFoundException('No active award for this lot');
    if (!award.standstill_until) throw new BadRequestException('This award has no standstill period');
    if (award.standstill_waived_reason) return { award, idempotent: true };
    // Истёкший срок закрывать нечем: он кончился сам. Без этой проверки запись в журнале и
    // письмо участникам говорили «срок закрыт досрочно» о решении, которого не было, —
    // журнал получал событие, а участник на странице вместо «срок истёк» видел «закрыт
    // досрочно: <причина>». Кнопки на этом состоянии в интерфейсе нет, но ручка была открыта.
    if (new Date(award.standstill_until).getTime() <= Date.now()) {
      throw new BadRequestException('The standstill period has already expired — there is nothing to waive');
    }
    // Проверки «нет ли уже контракта» здесь НЕТ, и это разобрано, а не забыто. Контракт по
    // присуждению возможен только тремя путями, и каждый отвечает раньше: паузы не было
    // (NULL — первый отказ выше), паузу уже сняли (идемпотентный возврат выше, без письма и
    // без записи в журнал) или срок истёк (отказ строкой выше). Состояния «живая пауза и
    // контракт» не существует, потому что контракт эту паузу и не прошёл бы. Добавлять
    // недостижимую проверку — писать код, который нельзя ни проверить, ни опровергнуть.
    // Если когда-нибудь появится ручка, двигающая `standstill_until` вперёд, это
    // рассуждение рушится — и тогда проверка нужна.
    await m.query(
      `UPDATE awards SET standstill_waived_reason=$2, standstill_waived_by=$3, standstill_waived_at=now()
        WHERE id=$1`,
      [award.id, text, auth.sub]);
    // Причина — в журнале, а не только в колонке: по колонке видно текущее состояние, а по
    // журналу — что решение принимал человек и когда.
    await this.audit.record('AWARD_STANDSTILL_WAIVED', 'sourcing_event', eventId, {
      lot_id: lotId, award_id: award.id, standstill_until: award.standstill_until, reason: text,
    });
    // Участникам говорят и об этом: срок, о котором им написали при присуждении, закончился
    // раньше объявленного, и молчать об этом — значит сделать первое письмо неправдой.
    const participants = await this.lotParticipants(eventId, lotId);
    for (const orgId of participants) {
      await this.notify.notifyOrg(orgId, 'AWARD_STANDSTILL_WAIVED', {
        event_id: eventId, lot_id: lotId, reason: text,
      });
    }
    const fresh = (await m.query(`SELECT * FROM awards WHERE id=$1`, [award.id]))[0];
    return { award: fresh, idempotent: false };
  }

  // Soft-cancel a lot award (keeps the row for the audit trail) and reopen the lot for a
  // fresh award. Blocked once a contract has been created from the award. Never locks bid
  // rows while the event is AWARDED (ceremony RLS forbids it) — reverts to EVALUATION first.
  async cancelAward(eventId: string, lotId: string, reason: string, auth: AccessTokenPayload) {
    await lockEvent(this.rc.manager, eventId);
    const m = this.rc.manager;
    await m.query(`SELECT id FROM sourcing_events WHERE id=$1 FOR UPDATE`, [eventId]);
    await this.requireEvent(eventId, ['EVALUATION', 'AWARDED']);
    if (!reason || reason.trim().length < 3) throw new BadRequestException('A cancellation reason is required');
    const award = (await m.query(
      `SELECT * FROM awards WHERE event_id=$1 AND lot_id=$2 AND cancelled_at IS NULL FOR UPDATE`, [eventId, lotId]))[0];
    if (!award) throw new NotFoundException('No active award for this lot');
    if ((await m.query(`SELECT 1 FROM contracts WHERE award_id=$1 LIMIT 1`, [award.id])).length) {
      throw new BadRequestException('A contract was already created from this award — cannot cancel');
    }
    await m.query(
      `UPDATE awards SET cancelled_at=now(), cancelled_by=$2, cancel_reason=$3 WHERE id=$1`,
      [award.id, auth.sub, reason.trim()]);
    await m.query(`UPDATE event_lots SET awarded_bid_id=NULL WHERE id=$1`, [lotId]);
    // reopening a lot moves a fully-awarded event back to EVALUATION
    await m.query(`UPDATE sourcing_events SET status='EVALUATION', awarded_at=NULL, updated_at=now() WHERE id=$1 AND status='AWARDED'`, [eventId]);
    await this.audit.record('EVENT_AWARD_CANCELLED', 'sourcing_event', eventId, { lot_id: lotId, award_id: award.id, reason: reason.trim() });
    // Отмена — тот же случай, что досрочное закрытие срока, только резче: участник получил
    // «решение принято, возражения до такого-то числа», а потом строка итогов у него
    // помечается отозванной. Молча это читается как сбой продукта, а не как отозванное
    // решение. Поэтому говорят всем участникам лота и с причиной.
    for (const orgId of await this.lotParticipants(eventId, lotId)) {
      // Без причины: см. выборку итогов в `detail()` — свободный текст покупателя об
      // отзыве решения всем участникам дословно не раздают.
      await this.notify.notifyOrg(orgId, 'EVENT_AWARD_CANCELLED', {
        event_id: eventId, lot_id: lotId,
      });
    }
    this.rt(eventId, 'event.status', { status: 'EVALUATION' });
    return this.detail(eventId, auth);
  }

  // ---------- OCDS export ----------

  async ocdsRelease(eventId: string, auth: AccessTokenPayload) {
    const ev = await this.detail(eventId, auth);
    const awardDetails = ev.amounts_visible ? await this.rc.manager.query(`
      SELECT a.*, b.supplier_org_id, o.legal_name AS supplier_name, a.winning_currency AS currency,
             a.winning_total_minor AS lot_total
      FROM awards a JOIN bids b ON b.id=a.winning_bid_id JOIN organizations o ON o.id=b.supplier_org_id
      WHERE a.event_id=$1`,[eventId]) : [];
    const tag = ['tender'];
    if (awardDetails.length) tag.push('award');
    const revision = this.sealed.sha256(JSON.stringify({status:ev.status,updatedAt:ev.updated_at,awards:awardDetails,items:ev.items})).slice(0,16);
    const dates=[ev.updated_at,...awardDetails.flatMap((a:any)=>[a.awarded_at,a.cancelled_at])].filter(Boolean).map((d:any)=>new Date(d).getTime());
    const releaseDate = new Date(Math.max(...dates)).toISOString();
    return {
      uri: `urn:leadprocure:ocds:${eventId}`,
      version: '1.1',
      publishedDate: new Date().toISOString(),
      publisher: { name: 'Leadprocure' },
      releases: [
        {
          ocid: `ocds-lp-${eventId}`,
          id: `${eventId}-${revision}`,
          date: releaseDate,
          language: 'az',
          tag,
          initiationType: 'tender',
          buyer: { id: ev.buyer_org_id, name: ev.buyer_name },
          tender: {
            id: eventId,
            title: ev.title,
            status: ev.status === 'CANCELLED' ? 'cancelled' : ev.status === 'DRAFT' ? 'planned' : ['CLOSED','OPENING','EVALUATION','AWARDED'].includes(ev.status) ? 'complete' : 'active',
            procurementMethod: ev.visibility === 'PUBLIC' ? 'open' : 'selective',
            procurementMethodDetails: `${ev.format} ${ev.type}`,
            tenderPeriod: { ...(ev.open_at ? {startDate:ev.open_at} : {}), ...(ev.close_at ? {endDate:ev.close_at} : {}) },
            items: (ev.items ?? []).map((i: any) => ({
              id: i.id, description: i.name, quantity: Number(i.qty), unit: { name: i.uom },
            })),
            value: undefined,
          },
          awards: awardDetails.map((a: any) => ({
            id: a.id, status: a.cancelled_at ? 'cancelled' : 'active', date: a.awarded_at,
            suppliers: [{id:a.supplier_org_id,name:a.supplier_name}],
            // Нет снимка суммы — не публикуем ноль: контракт по такой строке отказывает, и
            // выгрузка не должна утверждать, что присудили на нулевую сумму.
            value: a.lot_total == null ? undefined : {amount:Number(a.lot_total)/100,currency:a.currency},
          })),
        },
      ],
    };
  }

  // ---------- helpers ----------

  private async requireEvent(eventId: string, allowed: string[]) {
    const rows = await this.rc.manager.query(`SELECT * FROM sourcing_events WHERE id = $1`, [eventId]);
    if (!rows.length) throw new NotFoundException('Event not found');
    if (rows[0].buyer_org_id !== this.rc.orgId) throw new ForbiddenException('Not your event');
    if (!allowed.includes(rows[0].status)) {
      throw new BadRequestException(`Event is ${rows[0].status}; expected ${allowed.join('/')}`);
    }
    return rows[0];
  }

  private async visibleEvent(eventId: string) {
    const rows = await this.rc.manager.query(`SELECT * FROM sourcing_events WHERE id = $1`, [eventId]);
    if (!rows.length) throw new NotFoundException('Event not found');
    return rows[0];
  }

  private async myBid(eventId: string) {
    const m = this.rc.manager;
    const rows = await m.query(`SELECT * FROM bids WHERE event_id = $1`, [eventId]); // RLS → own only
    if (!rows.length) return null;
    const bid = rows[0];
    const payloadRows = await m.query(`SELECT * FROM bid_sealed_payloads WHERE bid_id = $1`, [bid.id]);
    let payload: SealedBidPayload | null = null;
    if (payloadRows.length) {
      payload = this.sealed.open<SealedBidPayload>({
        ciphertext: payloadRows[0].ciphertext, iv: payloadRows[0].iv, wrappedKey: payloadRows[0].wrapped_key,
      });
    }
    return { id: bid.id, state: bid.state, submitted_at: bid.submitted_at, payload };
  }

  private rt(eventId: string, event: string, data: Record<string, unknown>): void {
    this.emitter.emit('rt.emit', { room: `event:${eventId}`, event, data });
  }
}
