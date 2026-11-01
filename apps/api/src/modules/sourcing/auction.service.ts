import { lockEvent, assertSupplierAllowed, safeMoney, lineMoney, returnedRows } from '../../common/procurement/invariants';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { AccessTokenPayload } from '@leadprocure/shared';
import { RequestContextService } from '../../common/context/request-context.service';
import { AuditService } from '../../common/audit/audit.service';
import { assertVisibilityAllowed } from './visibility-rule';
import { SignatureProvider } from '../../common/signature/signature.provider';
import { SealedCryptoService } from '../../common/crypto/sealed.service';
import { EntitlementService, QuotaService } from '../../common/license/entitlement.service';

// Open-descending reverse auction. All bid validation happens INSIDE a transaction
// that holds FOR UPDATE on the event row, so two suppliers cannot both "beat the
// best by min_decrement" against the same stale best.
@Injectable()
export class AuctionService {
  constructor(
    private readonly rc: RequestContextService,
    private readonly audit: AuditService,
    private readonly signature: SignatureProvider,
    private readonly sealed: SealedCryptoService,
    private readonly entitlements: EntitlementService,
    private readonly quota: QuotaService,
    private readonly emitter: EventEmitter2,
  ) {}

  async createFromRequest(
    requestId: string,
    dto: { title?: string; closeAt: string; visibility?: 'PUBLIC' | 'INVITED';
           visibilityReason?: string;
           startPriceMinor: number; minDecrementMinor: number; qnaCutoffAt?: string },
    auth: AccessTokenPayload,
  ) {
    this.entitlements.assertCanCreateNew();
    await this.quota.consumeMonthlyEvent(auth.org_id);
    const m = this.rc.manager;
    const reqRows = await m.query(`SELECT * FROM procurement_requests WHERE id=$1`, [requestId]);
    if (!reqRows.length) throw new NotFoundException('Request not found');
    const req = reqRows[0];
    if (req.status !== 'APPROVED') throw new BadRequestException('Request must be APPROVED');
    if (req.method_resolved === 'DIRECT') throw new BadRequestException('Direct requests cannot create an auction');
    if (!Number.isInteger(dto.startPriceMinor) || dto.startPriceMinor <= 0)
      throw new BadRequestException('startPriceMinor must be a positive integer');
    if (!Number.isInteger(dto.minDecrementMinor) || dto.minDecrementMinor <= 0)
      throw new BadRequestException('minDecrementMinor must be a positive integer');
    const closeAt = new Date(dto.closeAt);
    if (!(closeAt.getTime() > Date.now())) throw new BadRequestException('closeAt must be in the future');

    const visibility = dto.visibility ?? 'INVITED';
    // Одно правило на обе процедуры — см. visibility-rule.ts. Возвращает обоснование
    // только когда отклонение было: лишняя строка в append-only журнале остаётся в нём
    // навсегда, поэтому «обоснование прислали» и «обосновывать было что» — разные вещи.
    // RLS держит выборку в своей организации
    const hasPolicies = (await m.query(`SELECT 1 FROM procurement_method_policies LIMIT 1`)).length > 0;
    const visibilityReason = assertVisibilityAllowed(
      req.method_resolved, visibility, dto.visibilityReason, hasPolicies);

    const ev = (
      await m.query(
        `INSERT INTO sourcing_events(buyer_org_id, request_id, type, format, status, visibility, title,
           evaluation_currency, vat_mode, close_at, created_by,
           auction_start_price_minor, auction_min_decrement_minor, qna_cutoff_at)
         VALUES ($1,$2,'AUCTION','REVERSE','DRAFT',$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          auth.org_id, requestId, visibility, dto.title ?? req.title,
          req.currency, req.vat_mode, closeAt.toISOString(), auth.sub,
          dto.startPriceMinor, dto.minDecrementMinor, dto.qnaCutoffAt ?? null,
        ],
      )
    )[0];
    const lot = (
      await m.query(`INSERT INTO event_lots(event_id, lot_no, title) VALUES ($1,1,$2) RETURNING id`, [
        ev.id, dto.title ?? req.title,
      ])
    )[0];
    await m.query(
      `INSERT INTO event_items(event_id, lot_id, line_no, name, description, qty, uom, est_unit_price_minor, vat_rate_bp)
       SELECT $2, $3, line_no, name, description, qty, uom, est_unit_price_minor, vat_rate_bp
       FROM request_items WHERE request_id=$1 ORDER BY line_no`,
      [requestId, ev.id, lot.id],
    );
    if (visibilityReason) {
      await this.audit.record('AUCTION_VISIBILITY_OVERRIDDEN', 'sourcing_event', ev.id, {
        request_id: requestId, method_resolved: req.method_resolved, visibility,
        reason: visibilityReason,
      });
    }
    return { id: ev.id };
  }

  // Anonymous state — safe for both sides. Aggregate comes from the SECURITY DEFINER
  // function; a supplier's own best is RLS-scoped to their rows.
  async state(eventId: string, auth: AccessTokenPayload) {
    const m = this.rc.manager;
    const evRows = await m.query(
      `SELECT id, status, format, close_at, evaluation_currency,
              auction_start_price_minor, auction_min_decrement_minor, auction_extension_count
       FROM sourcing_events WHERE id=$1`,
      [eventId],
    );
    if (!evRows.length) throw new NotFoundException('Event not found');
    const ev = evRows[0];
    if (ev.format !== 'REVERSE') throw new BadRequestException('Not an auction');
    const agg = (await m.query(`SELECT * FROM auction_state($1)`, [eventId]))[0];
    let myBest: number | null = null;
    if (auth.role === 'SUPPLIER_USER') {
      const mine = await m.query(
        `SELECT min(total_minor)::bigint AS v FROM auction_bids WHERE event_id=$1 AND accepted`,
        [eventId],
      );
      myBest = mine[0]?.v != null ? Number(mine[0].v) : null;
    }
    const best = agg?.best_total_minor != null ? Number(agg.best_total_minor) : null;
    return {
      status: ev.status,
      close_at: ev.close_at,
      currency: ev.evaluation_currency,
      start_price_minor: Number(ev.auction_start_price_minor),
      min_decrement_minor: Number(ev.auction_min_decrement_minor),
      best_total_minor: best,
      next_max_total_minor:
        best != null ? best - Number(ev.auction_min_decrement_minor) : Number(ev.auction_start_price_minor),
      accepted_count: agg?.accepted_count ?? 0,
      distinct_bidders: agg?.distinct_bidders ?? 0,
      extension_count: ev.auction_extension_count,
      my_best_total_minor: myBest,
    };
  }

  async placeBid(
    eventId: string,
    dto: { items: Array<{ eventItemId: string; unitPriceMinor: number }>; idempotencyKey?: string },
    auth: AccessTokenPayload,
  ) {
    const m = this.rc.manager;
    // Serialize all auction writes for this event. Suppliers cannot lock the event row
    // (FOR UPDATE requires UPDATE policies under RLS), so we use an advisory lock —
    // role-agnostic and transaction-scoped.
    await m.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 42))`, [eventId]);
    const locked = await m.query(
      `SELECT * FROM sourcing_events WHERE id=$1 AND format='REVERSE'`,
      [eventId],
    );
    if (!locked.length) throw new NotFoundException('Auction not found');
    const ev = locked[0];
    await assertSupplierAllowed(m, ev.buyer_org_id, auth.org_id);
    if (ev.status !== 'OPEN') throw new BadRequestException('Auction is not open');
    if (new Date(ev.close_at).getTime() <= Date.now()) throw new BadRequestException('Auction deadline has passed');

    // Idempotent retry → return the stored tick instead of re-bidding.
    if (dto.idempotencyKey) {
      const dup = await m.query(
        `SELECT id, total_minor, accepted FROM auction_bids
         WHERE event_id=$1 AND supplier_org_id=$2 AND idempotency_key=$3`,
        [eventId, auth.org_id, dto.idempotencyKey],
      );
      if (dup.length) return { ...dup[0], total_minor: Number(dup[0].total_minor), idempotent: true };
    }

    const eventItems = await m.query(`SELECT id, qty FROM event_items WHERE event_id=$1`, [eventId]);
    const qtyById = new Map<string, number>(eventItems.map((i: any) => [i.id, Number(i.qty)]));
    if (!dto.items?.length) throw new BadRequestException('Bid items required');
    let total = 0;
    const submitted = new Set<string>();
    for (const it of dto.items) {
      const qty = qtyById.get(it.eventItemId);
      if (qty == null) throw new BadRequestException(`Unknown event item ${it.eventItemId}`);
      if (!Number.isInteger(it.unitPriceMinor) || it.unitPriceMinor < 0)
        throw new BadRequestException('unitPriceMinor must be a non-negative integer');
      if (submitted.has(it.eventItemId)) throw new BadRequestException(`Duplicate line for item ${it.eventItemId}`);
      submitted.add(it.eventItemId);
      total = safeMoney(total + lineMoney(qty, it.unitPriceMinor));
    }
    // Responsiveness: an auction bid must price EVERY line item — a partial bid would post an
    // artificially low total and falsely "win" against complete bids.
    if (submitted.size !== eventItems.length) {
      throw new BadRequestException('Bid must price every line item of the auction');
    }

    const agg = (await m.query(`SELECT * FROM auction_state($1)`, [eventId]))[0];
    const best = agg?.best_total_minor != null ? Number(agg.best_total_minor) : null;
    const maxAllowed = best != null ? best - Number(ev.auction_min_decrement_minor) : Number(ev.auction_start_price_minor);

    const record = async (accepted: boolean, reason?: string) =>
      (
        await m.query(
          `INSERT INTO auction_bids(event_id, supplier_org_id, submitted_by, total_minor, currency,
             payload, accepted, rejected_reason, idempotency_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [
            eventId, auth.org_id, auth.sub, total, ev.evaluation_currency,
            JSON.stringify({ items: dto.items }), accepted, reason ?? null, dto.idempotencyKey ?? null,
          ],
        )
      )[0];

    if (total > maxAllowed) {
      // Rejected requests roll back; the accepted ledger intentionally records only committed ticks.
      throw new BadRequestException(`Bid must be at most ${maxAllowed} (best ${best ?? '—'} − decrement)`);
    }

    const tick = await record(true);
    // Current-best snapshot on the classic bids row (amounts are open in an auction).
    await m.query(
      `INSERT INTO bids(event_id, supplier_org_id, submitted_by, state, submitted_at, currency, total_minor)
       VALUES ($1,$2,$3,'OPENED', now(), $4, $5)
       ON CONFLICT (event_id, supplier_org_id)
       DO UPDATE SET total_minor=$5, submitted_at=now(), state='OPENED', updated_at=now()`,
      [eventId, auth.org_id, auth.sub, ev.evaluation_currency, total],
    );
    // Follow-up chains stop on first response (buyer-private row → DEFINER seam).
    await m.query(`SELECT followup_mark_responded($1, $2)`, [eventId, auth.org_id]);

    // Anti-sniping: late bid pushes the deadline out (bounded). Runs through the
    // SECURITY DEFINER seam because the bidder has no UPDATE rights on the event.
    const extRows = await m.query(`SELECT auction_try_extend($1) AS extended`, [eventId]);
    const extended: boolean = extRows[0]?.extended === true;
    if (extended) {
      await this.audit.record('AUCTION_EXTENDED', 'sourcing_event', eventId, {
        extension: Number(ev.auction_extension_count) + 1,
      });
    }

    const sig = await this.signature.sign(this.sealed.sha256(`${eventId}:${auth.org_id}:${total}`));
    await this.audit.record('AUCTION_BID_PLACED', 'auction_bid', tick.id, {
      event_id: eventId, total_minor: total, signature: sig, signer: this.signature.kind,
    });
    // No prices over the socket — clients refetch the REST state.
    this.emitter.emit('rt.emit', { room: `event:${eventId}`, event: 'auction.changed', data: { extended } });
    return { id: tick.id, total_minor: total, accepted: true, extended };
  }

  // Auctions skip the sealed opening ceremony — amounts were public all along.
  async finalize(eventId: string, auth: AccessTokenPayload) {
    const m = this.rc.manager;
    await lockEvent(m, eventId);
    const rows = await m.query(
      `SELECT * FROM sourcing_events WHERE id=$1 AND buyer_org_id=$2 FOR UPDATE`,
      [eventId, auth.org_id],
    );
    if (!rows.length) throw new NotFoundException('Auction not found');
    if (rows[0].format !== 'REVERSE') throw new BadRequestException('Not a reverse auction');
    if (['EVALUATION','AWARDED'].includes(rows[0].status)) return { ok:true, idempotent:true };
    if (rows[0].status !== 'CLOSED') throw new BadRequestException(`Event is ${rows[0].status}; expected CLOSED`);
    await m.query(`UPDATE sourcing_events SET status='OPENING', updated_at=now() WHERE id=$1`, [eventId]);
    await m.query(`INSERT INTO bid_items(bid_id,event_item_id,unit_price_minor,line_total_minor)
      SELECT b.id,ei.id,(item->>'unitPriceMinor')::bigint,
        ((item->>'unitPriceMinor')::numeric*ei.qty)::bigint
      FROM bids b JOIN LATERAL (SELECT payload FROM auction_bids ab WHERE ab.event_id=b.event_id
        AND ab.supplier_org_id=b.supplier_org_id AND ab.accepted ORDER BY ab.created_at DESC,ab.id DESC LIMIT 1) tick ON true
      CROSS JOIN LATERAL jsonb_array_elements(tick.payload->'items') item
      JOIN event_items ei ON ei.id=(item->>'eventItemId')::uuid AND ei.event_id=b.event_id
      WHERE b.event_id=$1 AND b.state='OPENED'`,[eventId]);
    await m.query(`UPDATE sourcing_events SET status='EVALUATION', updated_at=now() WHERE id=$1`, [eventId]);
    await this.audit.record('AUCTION_FINALIZED', 'sourcing_event', eventId, {});
    this.emitter.emit('rt.emit', { room: `event:${eventId}`, event: 'event.status', data: { status: 'EVALUATION' } });
    return { ok: true };
  }
}

@Injectable()
export class QnaService {
  constructor(
    private readonly rc: RequestContextService,
    private readonly audit: AuditService,
  ) {}

  async list(eventId: string) {
    // RLS: buyer sees all; supplier sees own + published.
    return this.rc.manager.query(
      `SELECT id, kind, question, answer, is_published, published_at, created_at,
              (asked_by_org_id = app_org_id()) AS mine
       FROM event_qna WHERE event_id=$1 ORDER BY created_at`,
      [eventId],
    );
  }

  async ask(eventId: string, question: string, auth: AccessTokenPayload) {
    const m = this.rc.manager;
    const ev = await m.query(`SELECT qna_cutoff_at, close_at, status FROM sourcing_events WHERE id=$1`, [eventId]);
    if (!ev.length) throw new NotFoundException('Event not found');
    const cutoff = ev[0].qna_cutoff_at ?? ev[0].close_at;
    if (cutoff && new Date(cutoff).getTime() <= Date.now())
      throw new BadRequestException('Q&A period is over');
    if (!['PUBLISHED', 'OPEN'].includes(ev[0].status))
      throw new BadRequestException('Event is not accepting questions');
    const row = (
      await m.query(
        `INSERT INTO event_qna(event_id, asked_by_org_id, asked_by_user_id, question)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [eventId, auth.org_id, auth.sub, question],
      )
    )[0];
    await this.audit.record('QNA_POSTED', 'event_qna', row.id, { event_id: eventId });
    return { id: row.id };
  }

  // Publishing an answer discloses it to ALL suppliers who can see the event.
  async answer(eventId: string, qnaId: string, answer: string, auth: AccessTokenPayload) {
    const rows = returnedRows(await this.rc.manager.query(
      `UPDATE event_qna SET answer=$3, answered_by_user_id=$4, answered_at=now(),
              is_published=true, published_at=now()
       WHERE id=$2 AND event_id=$1 RETURNING id`,
      [eventId, qnaId, answer, auth.sub],
    ));
    if (!rows.length) throw new NotFoundException('Question not found');
    await this.audit.record('QNA_ANSWERED', 'event_qna', qnaId, { event_id: eventId });
    return { ok: true };
  }

  async addendum(eventId: string, text: string, auth: AccessTokenPayload) {
    const row = (
      await this.rc.manager.query(
        `INSERT INTO event_qna(event_id, asked_by_org_id, asked_by_user_id, kind, question,
           is_published, published_at)
         VALUES ($1,$2,$3,'ADDENDUM',$4,true,now()) RETURNING id`,
        [eventId, auth.org_id, auth.sub, text],
      )
    )[0];
    await this.audit.record('ADDENDUM_PUBLISHED', 'event_qna', row.id, { event_id: eventId });
    return { id: row.id };
  }
}
