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
  async aiRecommendation(eventId: string, auth: AccessTokenPayload) {
    const ev = await this.requireEvent(eventId, ['EVALUATION', 'AWARDED']);
    if (ev.type === 'RFI') throw new BadRequestException('RFI does not support scoring');
    return this.aiScorer.recommend(eventId);
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
      title?: string; closeAt: string; visibility?: 'PUBLIC' | 'INVITED'; type?: 'RFQ' | 'RFP' | 'RFI';
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

    const ev = (
      await m.query(
        `INSERT INTO sourcing_events(buyer_org_id, request_id, type, format, status, visibility, title,
           evaluation_currency, vat_mode, close_at, created_by, evaluation_criteria)
         VALUES ($1,$2,$9,'SEALED','DRAFT',$3,$4,$5,$6,$7,$8,$10::jsonb) RETURNING id`,
        [
          auth.org_id, requestId, dto.visibility ?? 'INVITED', dto.title ?? req.title,
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
    return this.detail(ev.id, auth);
  }

  async publish(eventId: string, auth: AccessTokenPayload) {
    const m = this.rc.manager;
    const ev = await this.requireEvent(eventId, ['DRAFT']);
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
    await this.requireEvent(eventId, ['DRAFT']);
    const m = this.rc.manager;
    const lot = await m.query(`SELECT id FROM event_lots WHERE id=$1 AND event_id=$2`, [lotId, eventId]);
    if (!lot.length) throw new NotFoundException('Lot not found on this event');
    const upd = await m.query(`UPDATE event_items SET lot_id=$3 WHERE id=$1 AND event_id=$2 RETURNING id`, [
      itemId, eventId, lotId,
    ]);
    if (!upd.length) throw new NotFoundException('Item not found on this event');
    return { ok: true };
  }

  async invite(eventId: string, supplierOrgId: string) {
    const m = this.rc.manager;
    await this.requireEvent(eventId, ['DRAFT', 'OPEN']);
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
      return { ...ev, lots, items: supplierItems, my_bid: myBid, amounts_visible: amountsVisible };
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
       JOIN evaluations ev2 ON ev2.id = es.evaluation_id WHERE ev2.event_id = $1`,
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
        throw new BadRequestException(
          'Incomplete lot bid is non-responsive: price every item of a lot, or omit the lot entirely',
        );
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
    const m = this.rc.manager;
    // Visibility is enforced by RLS: invisible events simply don't exist for this supplier.
    const evRows = await m.query(`SELECT * FROM sourcing_events WHERE id = $1`, [eventId]);
    if (!evRows.length) throw new NotFoundException('Event not found');
    const ev = evRows[0];
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
      if (!dto.items?.length) throw new BadRequestException('Bid items required');
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
        total += qty * it.unitPriceMinor; // server-side total — client totals are ignored
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
    this.rt(eventId, 'bid.activity', { bid_count_delta: 1 }); // no amounts over the wire
    return { id: bid.id, state: 'SUBMITTED', payload_sha256: payloadHash };
  }

  async withdrawBid(eventId: string, auth: AccessTokenPayload) {
    const m = this.rc.manager;
    const ev = await this.visibleEvent(eventId);
    if (ev.status !== 'OPEN') throw new BadRequestException('Can only withdraw while bidding is open');
    const rows = await m.query(
      `UPDATE bids SET state='WITHDRAWN', updated_at=now()
       WHERE event_id=$1 AND supplier_org_id=$2 AND state='SUBMITTED' RETURNING id`,
      [eventId, auth.org_id],
    );
    if (!rows.length) throw new NotFoundException('No submitted bid to withdraw');
    await this.audit.record('BID_WITHDRAWN', 'bid', rows[0].id, { event_id: eventId });
    return { ok: true };
  }

  // ---------- buyer: opening ceremony, evaluation, award ----------

  async openCeremony(eventId: string, auth: AccessTokenPayload) {
    const m = this.rc.manager;
    await m.query(`SELECT id FROM sourcing_events WHERE id=$1 FOR UPDATE`, [eventId]);
    const ev = await this.requireEvent(eventId, ['CLOSED']);

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
    const m = this.rc.manager;
    await m.query(`SELECT id FROM sourcing_events WHERE id=$1 FOR UPDATE`, [eventId]);
    // AWARDED is allowed so a retried award of the same lot stays idempotent
    const evRow = await this.requireEvent(eventId, ['EVALUATION', 'AWARDED']);
    if (evRow.type === 'RFI') throw new BadRequestException('RFI does not support awarding');

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
    // Otherwise the award must follow a real evaluation, and the bid must be eligible for the lot.
    const evalRows = isAuction ? [] : await m.query(
      `SELECT id FROM evaluations WHERE event_id=$1 ORDER BY created_at DESC LIMIT 1`, [eventId]);
    if (!isAuction && !evalRows.length) throw new BadRequestException('Evaluate the bids before awarding');
    const evaluationId = evalRows[0]?.id ?? null;
    const justification = dto.justification?.trim() || null;
    let isTop = true;
    let singleBid = false;
    if (!isAuction) {
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
      `SELECT id, state, total_minor FROM bids WHERE id=$1 AND event_id=$2 FOR UPDATE`,
      [dto.bidId, eventId],
    );
    if (!bidRows.length) throw new NotFoundException('Bid not found on this event');
    if (bidRows[0].state !== 'OPENED') throw new BadRequestException('Only OPENED bids can be awarded');

    // Partial unique index (awards_active_lot) makes the award idempotent under concurrency.
    const inserted = await m.query(
      `INSERT INTO awards(event_id, lot_id, winning_bid_id, awarded_by, evaluation_id, justification)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [eventId, dto.lotId, dto.bidId, auth.sub, evaluationId, justification],
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
    // Notify the winning supplier.
    const winner = await m.query(`SELECT supplier_org_id FROM bids WHERE id = $1`, [dto.bidId]);
    if (winner.length) {
      await this.notify.notifyOrg(winner[0].supplier_org_id, 'BID_AWARDED', { event_id: eventId, lot_id: dto.lotId });
    }
    this.rt(eventId, 'event.awarded', { lot_id: dto.lotId });
    return { award: inserted[0], idempotent: false };
  }

  // Buyer disqualifies an opened bid during evaluation, with a documented reason. A
  // disqualified bid drops out of ranking and can't be awarded. Can't disqualify a bid
  // that currently holds an active award (cancel the award first).
  async disqualifyBid(eventId: string, bidId: string, reason: string, auth: AccessTokenPayload) {
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
    return this.detail(eventId, auth);
  }

  // Soft-cancel a lot award (keeps the row for the audit trail) and reopen the lot for a
  // fresh award. Blocked once a contract has been created from the award. Never locks bid
  // rows while the event is AWARDED (ceremony RLS forbids it) — reverts to EVALUATION first.
  async cancelAward(eventId: string, lotId: string, reason: string, auth: AccessTokenPayload) {
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
    this.rt(eventId, 'event.status', { status: 'EVALUATION' });
    return this.detail(eventId, auth);
  }

  // ---------- OCDS export ----------

  async ocdsRelease(eventId: string, auth: AccessTokenPayload) {
    const ev = await this.detail(eventId, auth);
    const tag = ['tender'];
    if (ev.status === 'AWARDED') tag.push('award');
    return {
      uri: `urn:leadprocure:ocds:${eventId}`,
      version: '1.1',
      publishedDate: new Date().toISOString(),
      publisher: { name: 'Leadprocure' },
      releases: [
        {
          ocid: `ocds-lp-${eventId}`,
          id: `${eventId}-${ev.version ?? 1}`,
          date: new Date().toISOString(),
          language: 'az',
          tag,
          initiationType: 'tender',
          buyer: { id: ev.buyer_org_id, name: ev.buyer_name },
          tender: {
            id: eventId,
            title: ev.title,
            status: ev.status === 'AWARDED' ? 'complete' : ev.status === 'CANCELLED' ? 'cancelled' : 'active',
            procurementMethod: ev.visibility === 'PUBLIC' ? 'open' : 'selective',
            procurementMethodDetails: `${ev.format} ${ev.type}`,
            tenderPeriod: { startDate: ev.open_at, endDate: ev.close_at },
            items: (ev.items ?? []).map((i: any) => ({
              id: i.id, description: i.name, quantity: Number(i.qty), unit: { name: i.uom },
            })),
            value: undefined,
          },
          awards: (ev.awards ?? []).map((a: any) => ({
            id: a.id, status: 'active', date: a.awarded_at,
            suppliers: undefined, relatedLots: [a.lot_id],
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
