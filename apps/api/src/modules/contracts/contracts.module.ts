import { lockOrder, lockEvent, assertSupplierAllowed, uniqueIds, safeMoney, returnedRows } from '../../common/procurement/invariants';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type { AccessTokenPayload, PoStatus } from '@leadprocure/shared';
import { PO_STATUSES } from '@leadprocure/shared';
import { pageFrom, parsePaging, Paging } from '../../common/http/paging';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { RequestContextService } from '../../common/context/request-context.service';
import { AuditService } from '../../common/audit/audit.service';
import { NotifyService } from '../../common/notify/notify.module';

@Injectable()
export class ContractsService {
  constructor(
    private readonly rc: RequestContextService,
    private readonly audit: AuditService,
    private readonly notify: NotifyService,
  ) {}

  // DIRECT purchase: a below-threshold approved request goes straight to a PO — no
  // tender, no contract. Items are snapshotted at their estimated prices.
  async createDirectOrder(requestId: string, supplierOrgId: string, auth: AccessTokenPayload) {
    const m = this.rc.manager;
    const reqRows = await m.query(`SELECT * FROM procurement_requests WHERE id = $1`, [requestId]);
    if (!reqRows.length) throw new NotFoundException('Request not found');
    const req = reqRows[0];
    if (req.status !== 'APPROVED') throw new BadRequestException('Request must be APPROVED');
    if (req.method_resolved && req.method_resolved !== 'DIRECT') {
      throw new BadRequestException(`Method is ${req.method_resolved}; use a sourcing event, not a direct order`);
    }
    await assertSupplierAllowed(m, auth.org_id, supplierOrgId);
    const sup = await m.query(
      `SELECT status FROM supplier_relationships WHERE buyer_org_id = $1 AND supplier_org_id = $2`,
      [auth.org_id, supplierOrgId],
    );
    if (!sup.length || sup[0].status !== 'APPROVED') {
      throw new BadRequestException('Supplier must be APPROVED in your registry for a direct order');
    }

    const items = await m.query(
      `SELECT id, line_no, name, qty, uom, est_unit_price_minor, vat_rate_bp FROM request_items
       WHERE request_id = $1 ORDER BY line_no`,
      [requestId],
    );
    const total = items.reduce((s: number, it: any) => s + Number(it.qty) * Number(it.est_unit_price_minor), 0);
    safeMoney(total);
    const n = await m.query(`SELECT next_document_no($1,'PO') AS n`, [auth.org_id]);
    const poNo = `PO-${new Date().getFullYear()}-${String(Number(n[0].n)).padStart(4, '0')}`;
    const po = (
      await m.query(
        `INSERT INTO purchase_orders(contract_id, buyer_org_id, supplier_org_id, po_no, status, total_minor, currency, created_by)
         VALUES (NULL,$1,$2,$3,'DRAFT',$4,$5,$6) RETURNING id`,
        [auth.org_id, supplierOrgId, poNo, total, req.currency, auth.sub],
      )
    )[0];
    await m.query(`UPDATE purchase_orders SET vat_mode=$2 WHERE id=$1`,[po.id, req.vat_mode]);
    for (const it of items) {
      await m.query(
        `INSERT INTO purchase_order_items(po_id, buyer_org_id, supplier_org_id, event_item_id, line_no, name, qty, uom, unit_price_minor, line_total_minor, vat_rate_bp)
         VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10)`,
        [po.id, auth.org_id, supplierOrgId, it.line_no, it.name, it.qty, it.uom,
         it.est_unit_price_minor, Number(it.qty) * Number(it.est_unit_price_minor), it.vat_rate_bp],
      );
    }
    await this.audit.record('PO_CREATED', 'purchase_order', po.id, { request_id: requestId, direct: true, total_minor: total });
    await this.notify.notifyOrg(supplierOrgId, 'DIRECT_ORDER_CREATED', { po_no: poNo, po_id: po.id });
    return this.getOrder(po.id);
  }

  // Award → contract. Snapshot of the winning bid becomes the contract header;
  // items are copied per-PO later (a contract can cover many partial orders).
  async createFromAward(awardId: string, auth: AccessTokenPayload) {
    const m = this.rc.manager;
    const event = (await m.query(`SELECT event_id FROM awards WHERE id=$1`,[awardId]))[0];
    if (!event) throw new NotFoundException('Award not found');
    await lockEvent(m, event.event_id);
    const rows = await m.query(
      `SELECT a.id AS award_id, a.event_id, a.winning_bid_id, e.title, e.buyer_org_id,
              e.evaluation_currency, e.vat_mode, b.currency AS bid_currency, b.supplier_org_id,
              (SELECT sum(bi.line_total_minor) FROM bid_items bi JOIN event_items ei ON ei.id=bi.event_item_id
               WHERE bi.bid_id=a.winning_bid_id AND ei.lot_id=a.lot_id) AS total_minor
       FROM awards a
       JOIN sourcing_events e ON e.id = a.event_id
       JOIN bids b ON b.id = a.winning_bid_id
       WHERE a.id = $1 AND a.cancelled_at IS NULL`,
      [awardId],
    );
    if (!rows.length) throw new NotFoundException('Award not found');
    const a = rows[0];
    if (a.buyer_org_id !== auth.org_id) throw new NotFoundException('Award not found');
    if (a.bid_currency !== a.evaluation_currency) throw new BadRequestException('Award requires an explicit currency conversion');
    if (a.total_minor == null) throw new BadRequestException('Award has no priced lot snapshot');

    const dup = await m.query(`SELECT id FROM contracts WHERE award_id = $1`, [awardId]);
    if (dup.length) return this.get(dup[0].id); // idempotent
    await assertSupplierAllowed(m, auth.org_id, a.supplier_org_id);

    safeMoney(Number(a.total_minor ?? 0));
    const n = await m.query(`SELECT next_document_no($1,'CTR') AS n`, [auth.org_id]);
    const contractNo = `CTR-${new Date().getFullYear()}-${String(Number(n[0].n)).padStart(4, '0')}`;
    const c = (
      await m.query(
        `INSERT INTO contracts(buyer_org_id, supplier_org_id, event_id, award_id, contract_no,
           title, total_minor, currency, vat_mode, status, valid_from, valid_to, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'DRAFT', current_date, current_date + interval '1 year', $10)
         RETURNING id`,
        [
          auth.org_id, a.supplier_org_id, a.event_id, awardId, contractNo, a.title,
          a.total_minor ?? 0, a.evaluation_currency, a.vat_mode, auth.sub,
        ],
      )
    )[0];
    await this.audit.record('CONTRACT_CREATED', 'contract', c.id, { award_id: awardId, contract_no: contractNo });
    return this.get(c.id);
  }

  async activate(id: string) {
    const rows = returnedRows(await this.rc.manager.query(
      `UPDATE contracts SET status='ACTIVE', updated_at=now() WHERE id=$1 AND status='DRAFT' RETURNING id`,
      [id],
    ));
    if (!rows.length) throw new BadRequestException('Contract not found or not DRAFT');
    await this.audit.record('CONTRACT_ACTIVATED', 'contract', id, {});
    return this.get(id);
  }

  async list(paging: Paging = parsePaging()) {
    const rows = await this.rc.manager.query(
      `SELECT c.*, ob.legal_name AS buyer_name, os.legal_name AS supplier_name,
              count(*) OVER()::int AS total_count,
              (SELECT count(*)::int FROM purchase_orders p WHERE p.contract_id = c.id) AS po_count,
              (SELECT COALESCE(SUM(p.total_minor),0)::bigint FROM purchase_orders p
               WHERE p.contract_id = c.id AND p.status NOT IN ('CANCELLED','REJECTED')) AS drawn_minor
       FROM contracts c
       JOIN organizations ob ON ob.id = c.buyer_org_id
       JOIN organizations os ON os.id = c.supplier_org_id
       ORDER BY c.created_at DESC LIMIT $1 OFFSET $2`,
      [paging.limit, paging.offset],
    );
    return pageFrom(rows, paging);
  }

  async get(id: string) {
    const rows = await this.rc.manager.query(
      `SELECT c.*, ob.legal_name AS buyer_name, os.legal_name AS supplier_name
       FROM contracts c
       JOIN organizations ob ON ob.id = c.buyer_org_id
       JOIN organizations os ON os.id = c.supplier_org_id
       WHERE c.id = $1`,
      [id],
    );
    if (!rows.length) throw new NotFoundException('Contract not found');
    const orders = await this.rc.manager.query(
      `SELECT * FROM purchase_orders WHERE contract_id = $1 ORDER BY created_at DESC`,
      [id],
    );
    return { ...rows[0], orders };
  }

  // Contract → PO with items snapshotted from the winning bid's opened line prices.
  async createOrder(contractId: string, auth: AccessTokenPayload) {
    const m = this.rc.manager;
    const cRows = await m.query(`SELECT * FROM contracts WHERE id = $1`, [contractId]);
    if (!cRows.length) throw new NotFoundException('Contract not found');
    const c = cRows[0];
    if (c.buyer_org_id !== auth.org_id) throw new BadRequestException('Only the buyer creates orders');
    if (c.status !== 'ACTIVE') throw new BadRequestException('Contract must be ACTIVE');
    await assertSupplierAllowed(m, auth.org_id, c.supplier_org_id);

    const items = await m.query(
      `SELECT ei.id AS event_item_id, ei.line_no, ei.name, ei.qty, ei.uom, ei.vat_rate_bp,
              bi.unit_price_minor, bi.line_total_minor
       FROM contracts c
       JOIN awards a ON a.id = c.award_id
       JOIN bid_items bi ON bi.bid_id = a.winning_bid_id
       JOIN event_items ei ON ei.id = bi.event_item_id
       WHERE c.id = $1 AND ei.lot_id=a.lot_id AND a.cancelled_at IS NULL ORDER BY ei.line_no`,
      [contractId],
    );
    if (!items.length) throw new BadRequestException('No priced items on the awarded bid');
    const total = items.reduce((s: number, it: any) => s + Number(it.line_total_minor), 0);

    // Contract value = ceiling for cumulative live call-off orders. Framework contracts legitimately
    // spawn many call-offs, so — consistent with the budget-commitment control — this is a soft,
    // audited warning rather than a hard block; cancelled/rejected POs free the ceiling again.
    const drawn = Number(
      (await m.query(
        `SELECT COALESCE(SUM(total_minor),0) AS s FROM purchase_orders
         WHERE contract_id=$1 AND status NOT IN ('CANCELLED','REJECTED')`,
        [contractId],
      ))[0].s,
    );
    const overByMinor = drawn + total - Number(c.total_minor);

    safeMoney(total);
    const n = await m.query(`SELECT next_document_no($1,'PO') AS n`, [auth.org_id]);
    const poNo = `PO-${new Date().getFullYear()}-${String(Number(n[0].n)).padStart(4, '0')}`;
    const po = (
      await m.query(
        `INSERT INTO purchase_orders(contract_id, buyer_org_id, supplier_org_id, po_no, status,
           total_minor, currency, created_by)
         VALUES ($1,$2,$3,$4,'DRAFT',$5,$6,$7) RETURNING id`,
        [contractId, c.buyer_org_id, c.supplier_org_id, poNo, total, c.currency, auth.sub],
      )
    )[0];
    await m.query(`UPDATE purchase_orders SET vat_mode=$2 WHERE id=$1`,[po.id,c.vat_mode]);
    for (const it of items) {
      await m.query(
        `INSERT INTO purchase_order_items(po_id, buyer_org_id, supplier_org_id, event_item_id,
           line_no, name, qty, uom, unit_price_minor, line_total_minor, vat_rate_bp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          po.id, c.buyer_org_id, c.supplier_org_id, it.event_item_id, it.line_no, it.name,
          it.qty, it.uom, it.unit_price_minor, it.line_total_minor, it.vat_rate_bp,
        ],
      );
    }
    await this.audit.record('PO_CREATED', 'purchase_order', po.id, {
      contract_id: contractId, po_no: poNo, total_minor: total,
      over_ceiling_minor: overByMinor > 0 ? overByMinor : undefined,
    });
    const order = await this.getOrder(po.id);
    return overByMinor > 0
      ? { ...order, ceilingWarning: { ceilingMinor: Number(c.total_minor), drawnBeforeMinor: drawn, thisOrderMinor: total, overByMinor } }
      : order;
  }

  async listOrders(paging: Paging = parsePaging()) {
    const rows = await this.rc.manager.query(
      `SELECT p.*, ob.legal_name AS buyer_name, os.legal_name AS supplier_name,
              count(*) OVER()::int AS total_count
       FROM purchase_orders p
       JOIN organizations ob ON ob.id = p.buyer_org_id
       JOIN organizations os ON os.id = p.supplier_org_id
       ORDER BY p.created_at DESC LIMIT $1 OFFSET $2`,
      [paging.limit, paging.offset],
    );
    return pageFrom(rows, paging);
  }

  async getOrder(id: string) {
    const m = this.rc.manager;
    const rows = await m.query(
      `SELECT p.*, ob.legal_name AS buyer_name, os.legal_name AS supplier_name
       FROM purchase_orders p
       JOIN organizations ob ON ob.id = p.buyer_org_id
       JOIN organizations os ON os.id = p.supplier_org_id
       WHERE p.id = $1`,
      [id],
    );
    if (!rows.length) throw new NotFoundException('Order not found');
    const items = await m.query(`SELECT * FROM purchase_order_items WHERE po_id=$1 ORDER BY line_no`, [id]);
    const history = await m.query(`SELECT * FROM po_status_history WHERE po_id=$1 ORDER BY created_at`, [id]);
    return { ...rows[0], items, history };
  }

  // ---- Goods receipt (GRN) — buyer records what arrived; partial receipts allowed ----

  async createReceipt(
    poId: string,
    dto: { items: Array<{ poItemId: string; qty: number }>; note?: string },
    auth: AccessTokenPayload,
  ) {
    const m = this.rc.manager;
    await lockOrder(m, poId);
    const po = (await m.query(`SELECT id, buyer_org_id, supplier_org_id FROM purchase_orders WHERE id = $1`, [poId]))[0];
    if (!po) throw new NotFoundException('Order not found');
    if (po.buyer_org_id !== auth.org_id) throw new BadRequestException('Only the buyer records receipts');
    if (!dto.items?.length) throw new BadRequestException('At least one line is required');

    // Ordered vs already-received per line — you can't receive more than was ordered
    // (an inflated receipt would otherwise authorise over-billing in the 3-way match).
    const poLines = await m.query(
      `SELECT poi.id, poi.name, poi.qty AS ordered, COALESCE(SUM(gri.qty_received),0) AS received
       FROM purchase_order_items poi
       LEFT JOIN goods_receipt_items gri ON gri.po_item_id = poi.id
       WHERE poi.po_id = $1 GROUP BY poi.id, poi.name, poi.qty`,
      [poId],
    );
    const ordered = new Map<string, { name: string; remaining: number }>(
      poLines.map((r: any) => [r.id, { name: r.name, remaining: Number(r.ordered) - Number(r.received) }]),
    );

    const gr = (
      await m.query(
        `INSERT INTO goods_receipts(po_id, buyer_org_id, supplier_org_id, received_by, note)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [poId, po.buyer_org_id, po.supplier_org_id, auth.sub, dto.note ?? null],
      )
    )[0];
    for (const it of dto.items) {
      if (!(Number(it.qty) > 0)) throw new BadRequestException('qty must be positive');
      const line = ordered.get(it.poItemId);
      if (!line) throw new BadRequestException(`Item ${it.poItemId} is not on this order`);
      if (Number(it.qty) > line.remaining) {
        throw new BadRequestException(`Cannot receive ${it.qty} of "${line.name}" — only ${line.remaining} remain on the order`);
      }
      line.remaining -= Number(it.qty); // guard duplicate lines within one receipt
      await m.query(
        `INSERT INTO goods_receipt_items(gr_id, po_item_id, buyer_org_id, supplier_org_id, qty_received)
         VALUES ($1,$2,$3,$4,$5)`,
        [gr.id, it.poItemId, po.buyer_org_id, po.supplier_org_id, it.qty],
      );
    }
    await this.audit.record('GRN_RECORDED', 'goods_receipt', gr.id, { po_id: poId, lines: dto.items.length });

    // If every PO line is now fully received, best-effort advance the PO to ACCEPTED
    // (legal only from DELIVERED; a SAVEPOINT keeps an inapplicable step a no-op).
    const summary = await this.receiptSummary(poId);
    if (summary.every((s: any) => Number(s.received) >= Number(s.ordered))) {
      await m.query(`SAVEPOINT accept`);
      try {
        await m.query(`SELECT po_apply_status($1, 'ACCEPTED'::po_status, 'fully received')`, [poId]);
        await m.query(`RELEASE SAVEPOINT accept`);
      } catch {
        await m.query(`ROLLBACK TO SAVEPOINT accept`);
      }
    }
    await this.notify.notifyOrg(po.supplier_org_id, 'GRN_RECORDED', { po_id: poId });

    // The receipt changes what is billable → re-run the 3-way match of every still-open
    // invoice on this PO (DEFINER seam: invoices are supplier-owned rows). An invoice
    // submitted before the goods arrived flips DISPUTED → MATCHED here instead of
    // staying disputed forever.
    const rematched: Array<{ invoice_id: string; invoice_no: string; supplier_org_id: string; old_status: string; new_status: string }> =
      await m.query(`SELECT * FROM invoice_rematch($1)`, [poId]);
    for (const r of rematched) {
      await this.audit.record('INVOICE_STATUS_CHANGED', 'invoice', r.invoice_id, {
        status: r.new_status, from: r.old_status, via: 'rematch_on_receipt',
      });
      await this.notify.notifyOrg(r.supplier_org_id, 'INVOICE_STATUS_CHANGED', {
        invoice_no: r.invoice_no, status: r.new_status,
      });
    }
    return this.getReceipts(poId);
  }

  private async receiptSummary(poId: string) {
    return this.rc.manager.query(
      `SELECT poi.id AS po_item_id, poi.name, poi.qty AS ordered,
              COALESCE(SUM(gri.qty_received),0) AS received
       FROM purchase_order_items poi
       LEFT JOIN goods_receipt_items gri ON gri.po_item_id = poi.id
       WHERE poi.po_id = $1 GROUP BY poi.id, poi.name, poi.qty ORDER BY poi.line_no`,
      [poId],
    );
  }

  async getReceipts(poId: string) {
    const receipts = await this.rc.manager.query(
      `SELECT id, note, created_at FROM goods_receipts WHERE po_id = $1 ORDER BY created_at`,
      [poId],
    );
    return { summary: await this.receiptSummary(poId), receipts };
  }

  // All transitions run through the SECURITY DEFINER seam — it enforces which side
  // may perform which transition; we just relay and audit.
  // ---- PO amendments (change orders) ----
  // Buyer proposes per-line qty/price changes to an ISSUED/CONFIRMED order; the snapshot
  // of old→new values lives on the amendment row so history survives PO mutation.
  async listAmendments(poId: string) {
    return this.rc.manager.query(
      `SELECT * FROM po_amendments WHERE po_id = $1 ORDER BY amendment_no DESC`,
      [poId],
    );
  }

  async proposeAmendment(
    poId: string,
    dto: { reason: string; items: Array<{ poItemId: string; qty?: number; unitPriceMinor?: number }> },
    auth: AccessTokenPayload,
  ) {
    const m = this.rc.manager;
    await lockOrder(m, poId);
    const po = (await m.query(`SELECT * FROM purchase_orders WHERE id = $1`, [poId]))[0];
    if (!po) throw new NotFoundException('Order not found');
    if (po.buyer_org_id !== auth.org_id) throw new BadRequestException('Only the buyer proposes amendments');
    if (!['ISSUED', 'CONFIRMED'].includes(po.status)) {
      throw new BadRequestException(`PO is ${po.status} — amendments only apply before fulfilment starts`);
    }
    if ((await m.query(`SELECT 1 FROM goods_receipts WHERE po_id = $1 LIMIT 1`, [poId])).length) {
      throw new BadRequestException('Goods already received against this PO');
    }
    if ((await m.query(`SELECT 1 FROM po_amendments WHERE po_id = $1 AND status = 'PROPOSED'`, [poId])).length) {
      throw new BadRequestException('An amendment is already pending on this PO');
    }
    if (!dto.items?.length) throw new BadRequestException('At least one line change is required');

    const items = await m.query(
      `SELECT id, name, qty, unit_price_minor FROM purchase_order_items WHERE po_id = $1`,
      [poId],
    );
    const byId = new Map<string, any>(items.map((i: any) => [i.id, i]));
    uniqueIds(dto.items, 'poItemId');
    const changes = dto.items.map((ch) => {
      const cur = byId.get(ch.poItemId);
      if (!cur) throw new BadRequestException(`Item ${ch.poItemId} is not on this order`);
      const newQty = ch.qty ?? Number(cur.qty);
      safeMoney(newQty);
      const newPrice = ch.unitPriceMinor ?? Number(cur.unit_price_minor);
      safeMoney(newPrice);
      if (newQty === Number(cur.qty) && newPrice === Number(cur.unit_price_minor)) {
        throw new BadRequestException(`Line "${cur.name}" has no actual change`);
      }
      return {
        poItemId: ch.poItemId, name: cur.name,
        oldQty: Number(cur.qty), newQty,
        oldUnitPriceMinor: Number(cur.unit_price_minor), newUnitPriceMinor: newPrice,
      };
    });
    const changed = new Map(changes.map((c) => [c.poItemId, c]));
    const newTotal = items.reduce((sum: number, it: any) => {
      const c = changed.get(it.id);
      return sum + (c ? c.newQty * c.newUnitPriceMinor : Number(it.qty) * Number(it.unit_price_minor));
    }, 0);

    const no = Number(
      (await m.query(`SELECT COALESCE(max(amendment_no), 0) + 1 AS n FROM po_amendments WHERE po_id = $1`, [poId]))[0].n,
    );
    const row = (
      await m.query(
        `INSERT INTO po_amendments(po_id, buyer_org_id, supplier_org_id, amendment_no, reason,
                                   changes, old_total_minor, new_total_minor, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [poId, po.buyer_org_id, po.supplier_org_id, no, dto.reason,
         JSON.stringify(changes), po.total_minor, newTotal, auth.sub],
      )
    )[0];
    await this.audit.record('PO_AMENDMENT_PROPOSED', 'po_amendment', row.id, { po_id: poId, no, new_total_minor: newTotal });
    await this.notify.notifyOrg(po.supplier_org_id, 'PO_AMENDMENT_PROPOSED', { po_no: po.po_no, po_id: poId, amendment_id: row.id });
    return row;
  }

  async decideAmendment(poId: string, amendmentId: string, dto: { accept: boolean; note?: string }, auth: AccessTokenPayload) {
    const m = this.rc.manager;
    await lockOrder(m, poId);
    const am = (await m.query(`SELECT * FROM po_amendments WHERE id = $1 AND po_id = $2`, [amendmentId, poId]))[0];
    if (!am) throw new NotFoundException('Amendment not found');
    try {
      // counterparty write: validates the actor, applies line changes + total atomically
      const decided = (await m.query(`SELECT * FROM po_amendment_decide($1,$2,$3)`, [amendmentId, dto.accept, dto.note ?? null]))[0];
      await this.audit.record(
        dto.accept ? 'PO_AMENDMENT_ACCEPTED' : 'PO_AMENDMENT_REJECTED',
        'po_amendment', amendmentId, { po_id: poId, by: auth.org_id },
      );
      await this.notify.notifyOrg(am.buyer_org_id, dto.accept ? 'PO_AMENDMENT_ACCEPTED' : 'PO_AMENDMENT_REJECTED',
        { po_id: poId, amendment_id: amendmentId });
      return decided;
    } catch (e: any) {
      throw new BadRequestException(e.message?.replace(/^.*ERROR:\s*/, '') ?? 'Decision failed');
    }
  }

  async setOrderStatus(id: string, status: PoStatus, note: string | undefined, auth: AccessTokenPayload) {
    await lockOrder(this.rc.manager, id);
    try {
      const rows = await this.rc.manager.query(`SELECT * FROM po_apply_status($1, $2, $3)`, [
        id, status, note ?? null,
      ]);
      await this.audit.record('PO_STATUS_CHANGED', 'purchase_order', id, {
        to: status, by_org: auth.org_id, note: note ?? null,
      });
      // Notify the OTHER party of the transition.
      const po = rows[0];
      const counterparty = auth.org_id === po.buyer_org_id ? po.supplier_org_id : po.buyer_org_id;
      await this.notify.notifyOrg(counterparty, 'PO_STATUS_CHANGED', { po_no: po.po_no, po_id: id, status });
      return po;
    } catch (e: any) {
      throw new BadRequestException(e.message?.replace(/^.*ERROR:\s*/, '') ?? 'Transition failed');
    }
  }
}

class DirectOrderDto {
  @IsUUID() supplierOrgId!: string;
}
class SetPoStatusDto {
  @IsIn(PO_STATUSES) status!: PoStatus;
  @IsOptional() @IsString() note?: string;
}
class ReceiptItemDto {
  @IsUUID() poItemId!: string;
  @IsInt() @Min(0) qty!: number;
}
class AmendItemDto {
  @IsUUID() poItemId!: string;
  @IsOptional() @IsInt() @Min(1) qty?: number;
  @IsOptional() @IsInt() @Min(0) unitPriceMinor?: number;
}
class ProposeAmendmentDto {
  @IsString() @MinLength(3) reason!: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => AmendItemDto) items!: AmendItemDto[];
}
class AmendmentDecisionDto {
  @IsBoolean() accept!: boolean;
  @IsOptional() @IsString() note?: string;
}
class CreateReceiptDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => ReceiptItemDto) items!: ReceiptItemDto[];
  @IsOptional() @IsString() note?: string;
}

@Controller()
export class ContractsController {
  constructor(private readonly contracts: ContractsService) {}

  @Post('contracts/from-award/:awardId')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  fromAward(@Param('awardId') awardId: string, @CurrentUser() auth: AccessTokenPayload) {
    return this.contracts.createFromAward(awardId, auth);
  }

  @Post('orders/direct/from-request/:requestId')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  directOrder(
    @Param('requestId') requestId: string,
    @Body() body: DirectOrderDto,
    @CurrentUser() auth: AccessTokenPayload,
  ) {
    return this.contracts.createDirectOrder(requestId, body.supplierOrgId, auth);
  }

  @Post('contracts/:id/activate')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  activate(@Param('id') id: string) {
    return this.contracts.activate(id);
  }

  @Get('contracts')
  list(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.contracts.list(parsePaging(page, pageSize));
  }

  @Get('contracts/:id')
  get(@Param('id') id: string) {
    return this.contracts.get(id);
  }

  @Post('contracts/:id/orders')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  createOrder(@Param('id') id: string, @CurrentUser() auth: AccessTokenPayload) {
    return this.contracts.createOrder(id, auth);
  }

  @Get('orders')
  listOrders(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.contracts.listOrders(parsePaging(page, pageSize));
  }

  @Get('orders/:id')
  getOrder(@Param('id') id: string) {
    return this.contracts.getOrder(id);
  }

  @Post('orders/:id/status')
  setStatus(
    @Param('id') id: string,
    @Body() body: SetPoStatusDto,
    @CurrentUser() auth: AccessTokenPayload,
  ) {
    return this.contracts.setOrderStatus(id, body.status, body.note, auth);
  }

  @Get('orders/:id/receipts')
  receipts(@Param('id') id: string) {
    return this.contracts.getReceipts(id);
  }

  @Post('orders/:id/receipts')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER')
  receive(
    @Param('id') id: string,
    @Body() body: CreateReceiptDto,
    @CurrentUser() auth: AccessTokenPayload,
  ) {
    return this.contracts.createReceipt(id, body, auth);
  }

  @Get('orders/:id/amendments')
  amendments(@Param('id') id: string) {
    return this.contracts.listAmendments(id);
  }

  @Post('orders/:id/amendments')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  proposeAmendment(
    @Param('id') id: string,
    @Body() body: ProposeAmendmentDto,
    @CurrentUser() auth: AccessTokenPayload,
  ) {
    return this.contracts.proposeAmendment(id, body, auth);
  }

  @Post('orders/:id/amendments/:amendmentId/decision')
  @Roles('SUPPLIER_USER')
  decideAmendment(
    @Param('id') id: string,
    @Param('amendmentId') amendmentId: string,
    @Body() body: AmendmentDecisionDto,
    @CurrentUser() auth: AccessTokenPayload,
  ) {
    return this.contracts.decideAmendment(id, amendmentId, body, auth);
  }
}

@Module({ controllers: [ContractsController], providers: [ContractsService] })
export class ContractsModule {}
