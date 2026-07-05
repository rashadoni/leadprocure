import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AMOUNTS_VISIBLE_FROM, type AccessTokenPayload } from '@leadprocure/shared';
import { RequestContextService } from '../../common/context/request-context.service';
import { AuditService } from '../../common/audit/audit.service';
import { SealedCryptoService } from '../../common/crypto/sealed.service';
import { SignatureProvider } from '../../common/signature/signature.provider';
import { EntitlementService, QuotaService } from '../../common/license/entitlement.service';
import { AiScorer } from '../../common/ai/ai-scorer';

interface SealedBidPayload {
  items: Array<{ event_item_id: string; unit_price_minor: number }>;
  total_minor: number;
  currency: string;
  delivery_days: number | null;
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
  ) {}

  // AI recommendation — only once amounts are open (RLS + status gate both enforce this).
  async aiRecommendation(eventId: string, auth: AccessTokenPayload) {
    const ev = await this.requireEvent(eventId, ['EVALUATION', 'AWARDED']);
    void ev;
    return this.aiScorer.recommend(eventId);
  }

  // ---------- buyer: create + publish ----------

  async createFromRequest(requestId: string, dto: { title?: string; closeAt: string; visibility?: 'PUBLIC' | 'INVITED' }, auth: AccessTokenPayload) {
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

    const ev = (
      await m.query(
        `INSERT INTO sourcing_events(buyer_org_id, request_id, type, format, status, visibility, title,
           evaluation_currency, vat_mode, close_at, created_by)
         VALUES ($1,$2,'RFQ','SEALED','DRAFT',$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          auth.org_id, requestId, dto.visibility ?? 'INVITED', dto.title ?? req.title,
          req.currency, req.vat_mode, closeAt.toISOString(), auth.sub,
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

  async invite(eventId: string, supplierOrgId: string) {
    const m = this.rc.manager;
    await this.requireEvent(eventId, ['DRAFT', 'OPEN']);
    await m.query(
      `INSERT INTO event_invitations(event_id, supplier_org_id) VALUES ($1,$2)
       ON CONFLICT (event_id, supplier_org_id) DO NOTHING`,
      [eventId, supplierOrgId],
    );
    await this.audit.record('SUPPLIER_INVITED', 'sourcing_event', eventId, { supplier_org_id: supplierOrgId });
    return { ok: true };
  }

  // ---------- shared: list & detail (RLS decides visibility) ----------

  async list(auth: AccessTokenPayload) {
    const m = this.rc.manager;
    const events = await m.query(
      `SELECT e.id, e.title, e.type, e.format, e.status, e.visibility, e.evaluation_currency,
              e.open_at, e.close_at, e.awarded_at, e.created_at, o.legal_name AS buyer_name,
              (SELECT count(*)::int FROM bids b WHERE b.event_id = e.id AND b.state <> 'DRAFT') AS bid_count
       FROM sourcing_events e JOIN organizations o ON o.id = e.buyer_org_id
       ORDER BY e.created_at DESC`,
    );
    if (auth.role === 'SUPPLIER_USER') {
      // annotate with "did I bid" (bids RLS shows only own rows to suppliers)
      const mine = await m.query(`SELECT event_id, state FROM bids`);
      const byEvent = new Map(mine.map((b: any) => [b.event_id, b.state]));
      return events.map((e: any) => ({ ...e, my_bid_state: byEvent.get(e.id) ?? null }));
    }
    return events;
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
      return { ...ev, lots, items, my_bid: myBid, amounts_visible: amountsVisible };
    }

    // Buyer view: participation always; amounts only once the ceremony opened them.
    // Defense-in-depth: RLS already hides bid_items/payloads pre-opening, and we also
    // strip the total column here until then.
    const bids = await m.query(
      `SELECT b.id, b.supplier_org_id, s.legal_name AS supplier_name, b.state, b.submitted_at,
              b.currency, b.delivery_days, b.total_minor
       FROM bids b JOIN organizations s ON s.id = b.supplier_org_id
       WHERE b.event_id = $1 ORDER BY b.submitted_at NULLS LAST`,
      [eventId],
    );
    const safeBids = bids.map((b: any) => ({
      ...b,
      total_minor: amountsVisible ? b.total_minor : null,
      delivery_days: amountsVisible ? b.delivery_days : null,
    }));
    let bidItems: any[] = [];
    if (amountsVisible) {
      bidItems = await m.query(
        `SELECT bi.* FROM bid_items bi JOIN bids b ON b.id = bi.bid_id WHERE b.event_id = $1`,
        [eventId],
      );
    }
    const scores = await m.query(
      `SELECT es.bid_id, es.criterion, es.score, es.weighted FROM evaluation_scores es
       JOIN evaluations ev2 ON ev2.id = es.evaluation_id WHERE ev2.event_id = $1`,
      [eventId],
    );
    const awards = await m.query(`SELECT * FROM awards WHERE event_id = $1`, [eventId]);
    return { ...ev, lots, items, bids: safeBids, bid_items: bidItems, scores, awards, amounts_visible: amountsVisible };
  }

  // ---------- supplier: sealed bid ----------

  async submitBid(
    eventId: string,
    dto: { items: Array<{ eventItemId: string; unitPriceMinor: number }>; currency?: string; deliveryDays?: number },
    auth: AccessTokenPayload,
  ) {
    const m = this.rc.manager;
    // Visibility is enforced by RLS: invisible events simply don't exist for this supplier.
    const evRows = await m.query(`SELECT * FROM sourcing_events WHERE id = $1`, [eventId]);
    if (!evRows.length) throw new NotFoundException('Event not found');
    const ev = evRows[0];
    if (ev.status !== 'OPEN') throw new BadRequestException('Event is not open for bidding');
    if (new Date(ev.close_at).getTime() <= Date.now()) {
      throw new BadRequestException('Bidding deadline has passed'); // server-authoritative clock
    }

    const eventItems = await m.query(`SELECT id, qty FROM event_items WHERE event_id = $1`, [eventId]);
    const qtyById = new Map<string, number>(eventItems.map((i: any) => [i.id, Number(i.qty)]));
    if (!dto.items?.length) throw new BadRequestException('Bid items required');
    let total = 0;
    for (const it of dto.items) {
      const qty = qtyById.get(it.eventItemId);
      if (qty == null) throw new BadRequestException(`Unknown event item ${it.eventItemId}`);
      if (!Number.isInteger(it.unitPriceMinor) || it.unitPriceMinor < 0) {
        throw new BadRequestException('unitPriceMinor must be a non-negative integer');
      }
      total += qty * it.unitPriceMinor; // server-side total — client totals are ignored
    }

    const payload: SealedBidPayload = {
      items: dto.items.map((i) => ({ event_item_id: i.eventItemId, unit_price_minor: i.unitPriceMinor })),
      total_minor: total,
      currency: dto.currency ?? ev.evaluation_currency,
      delivery_days: dto.deliveryDays ?? null,
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
    const receipt: Array<{ bid_id: string; payload_sha256: string; total_minor: number }> = [];
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

  async evaluate(
    eventId: string,
    dto: { criteria: Array<{ key: string; weight: number }>; scores: Array<{ bidId: string; key: string; score: number }> },
    auth: AccessTokenPayload,
  ) {
    const m = this.rc.manager;
    await this.requireEvent(eventId, ['EVALUATION']);
    const weightSum = dto.criteria.reduce((s, c) => s + c.weight, 0);
    if (Math.abs(weightSum - 100) > 0.001) throw new BadRequestException('Criteria weights must sum to 100');

    const evaluation = (
      await m.query(
        `INSERT INTO evaluations(event_id, criteria, created_by) VALUES ($1,$2,$3) RETURNING id`,
        [eventId, JSON.stringify(dto.criteria), auth.sub],
      )
    )[0];
    const weightByKey = new Map(dto.criteria.map((c) => [c.key, c.weight]));
    const totals = new Map<string, number>();
    for (const s of dto.scores) {
      const weight = weightByKey.get(s.key);
      if (weight == null) throw new BadRequestException(`Unknown criterion ${s.key}`);
      const weighted = (s.score * weight) / 100;
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
    await this.audit.record('EVENT_EVALUATED', 'sourcing_event', eventId, { evaluation_id: evaluation.id, ranking });
    return { evaluation_id: evaluation.id, ranking };
  }

  async award(eventId: string, dto: { lotId: string; bidId: string }, auth: AccessTokenPayload) {
    const m = this.rc.manager;
    await m.query(`SELECT id FROM sourcing_events WHERE id=$1 FOR UPDATE`, [eventId]);
    // AWARDED is allowed so a retried award of the same lot stays idempotent
    await this.requireEvent(eventId, ['EVALUATION', 'AWARDED']);

    // Idempotency short-circuit BEFORE locking the bid: after the event is AWARDED the
    // ceremony RLS policy no longer lets the buyer lock bid rows (FOR UPDATE applies
    // UPDATE policies), so a retry must return the stored award without touching bids.
    const existing = await m.query(`SELECT * FROM awards WHERE event_id=$1 AND lot_id=$2`, [eventId, dto.lotId]);
    if (existing.length) return { award: existing[0], idempotent: true };

    const bidRows = await m.query(
      `SELECT id, state, total_minor FROM bids WHERE id=$1 AND event_id=$2 FOR UPDATE`,
      [dto.bidId, eventId],
    );
    if (!bidRows.length) throw new NotFoundException('Bid not found on this event');
    if (bidRows[0].state !== 'OPENED') throw new BadRequestException('Only OPENED bids can be awarded');

    // Unique (event_id, lot_id) makes the award idempotent under concurrency.
    const inserted = await m.query(
      `INSERT INTO awards(event_id, lot_id, winning_bid_id, awarded_by)
       VALUES ($1,$2,$3,$4) ON CONFLICT (event_id, lot_id) DO NOTHING RETURNING id`,
      [eventId, dto.lotId, dto.bidId, auth.sub],
    );
    if (!inserted.length) {
      const existing = await m.query(`SELECT * FROM awards WHERE event_id=$1 AND lot_id=$2`, [eventId, dto.lotId]);
      return { award: existing[0], idempotent: true };
    }
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
      signature: sig, signer: this.signature.kind,
    });
    this.rt(eventId, 'event.awarded', { lot_id: dto.lotId });
    return { award: inserted[0], idempotent: false };
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
