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
} from '@nestjs/common';
import type { AccessTokenPayload, PoStatus } from '@leadprocure/shared';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { RequestContextService } from '../../common/context/request-context.service';
import { AuditService } from '../../common/audit/audit.service';

@Injectable()
export class ContractsService {
  constructor(
    private readonly rc: RequestContextService,
    private readonly audit: AuditService,
  ) {}

  // Award → contract. Snapshot of the winning bid becomes the contract header;
  // items are copied per-PO later (a contract can cover many partial orders).
  async createFromAward(awardId: string, auth: AccessTokenPayload) {
    const m = this.rc.manager;
    const rows = await m.query(
      `SELECT a.id AS award_id, a.event_id, a.winning_bid_id, e.title, e.buyer_org_id,
              e.evaluation_currency, e.vat_mode, b.supplier_org_id, b.total_minor
       FROM awards a
       JOIN sourcing_events e ON e.id = a.event_id
       JOIN bids b ON b.id = a.winning_bid_id
       WHERE a.id = $1`,
      [awardId],
    );
    if (!rows.length) throw new NotFoundException('Award not found');
    const a = rows[0];
    if (a.buyer_org_id !== auth.org_id) throw new NotFoundException('Award not found');

    const dup = await m.query(`SELECT id FROM contracts WHERE award_id = $1`, [awardId]);
    if (dup.length) return this.get(dup[0].id); // idempotent

    const n = await m.query(`SELECT count(*)::int AS n FROM contracts`);
    const contractNo = `CTR-${new Date().getFullYear()}-${String(n[0].n + 1).padStart(4, '0')}`;
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
    const rows = await this.rc.manager.query(
      `UPDATE contracts SET status='ACTIVE', updated_at=now() WHERE id=$1 AND status='DRAFT' RETURNING id`,
      [id],
    );
    if (!rows.length) throw new BadRequestException('Contract not found or not DRAFT');
    await this.audit.record('CONTRACT_ACTIVATED', 'contract', id, {});
    return this.get(id);
  }

  async list() {
    return this.rc.manager.query(
      `SELECT c.*, ob.legal_name AS buyer_name, os.legal_name AS supplier_name,
              (SELECT count(*)::int FROM purchase_orders p WHERE p.contract_id = c.id) AS po_count
       FROM contracts c
       JOIN organizations ob ON ob.id = c.buyer_org_id
       JOIN organizations os ON os.id = c.supplier_org_id
       ORDER BY c.created_at DESC`,
    );
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

    const items = await m.query(
      `SELECT ei.id AS event_item_id, ei.line_no, ei.name, ei.qty, ei.uom, ei.vat_rate_bp,
              bi.unit_price_minor, bi.line_total_minor
       FROM contracts c
       JOIN awards a ON a.id = c.award_id
       JOIN bid_items bi ON bi.bid_id = a.winning_bid_id
       JOIN event_items ei ON ei.id = bi.event_item_id
       WHERE c.id = $1 ORDER BY ei.line_no`,
      [contractId],
    );
    if (!items.length) throw new BadRequestException('No priced items on the awarded bid');
    const total = items.reduce((s: number, it: any) => s + Number(it.line_total_minor), 0);

    const n = await m.query(`SELECT count(*)::int AS n FROM purchase_orders`);
    const poNo = `PO-${new Date().getFullYear()}-${String(n[0].n + 1).padStart(4, '0')}`;
    const po = (
      await m.query(
        `INSERT INTO purchase_orders(contract_id, buyer_org_id, supplier_org_id, po_no, status,
           total_minor, currency, created_by)
         VALUES ($1,$2,$3,$4,'DRAFT',$5,$6,$7) RETURNING id`,
        [contractId, c.buyer_org_id, c.supplier_org_id, poNo, total, c.currency, auth.sub],
      )
    )[0];
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
    await this.audit.record('PO_CREATED', 'purchase_order', po.id, { contract_id: contractId, po_no: poNo, total_minor: total });
    return this.getOrder(po.id);
  }

  async listOrders() {
    return this.rc.manager.query(
      `SELECT p.*, ob.legal_name AS buyer_name, os.legal_name AS supplier_name
       FROM purchase_orders p
       JOIN organizations ob ON ob.id = p.buyer_org_id
       JOIN organizations os ON os.id = p.supplier_org_id
       ORDER BY p.created_at DESC`,
    );
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

  // All transitions run through the SECURITY DEFINER seam — it enforces which side
  // may perform which transition; we just relay and audit.
  async setOrderStatus(id: string, status: PoStatus, note: string | undefined, auth: AccessTokenPayload) {
    try {
      const rows = await this.rc.manager.query(`SELECT * FROM po_apply_status($1, $2, $3)`, [
        id, status, note ?? null,
      ]);
      await this.audit.record('PO_STATUS_CHANGED', 'purchase_order', id, {
        to: status, by_org: auth.org_id, note: note ?? null,
      });
      return rows[0];
    } catch (e: any) {
      throw new BadRequestException(e.message?.replace(/^.*ERROR:\s*/, '') ?? 'Transition failed');
    }
  }
}

@Controller()
export class ContractsController {
  constructor(private readonly contracts: ContractsService) {}

  @Post('contracts/from-award/:awardId')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  fromAward(@Param('awardId') awardId: string, @CurrentUser() auth: AccessTokenPayload) {
    return this.contracts.createFromAward(awardId, auth);
  }

  @Post('contracts/:id/activate')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  activate(@Param('id') id: string) {
    return this.contracts.activate(id);
  }

  @Get('contracts')
  list() {
    return this.contracts.list();
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
  listOrders() {
    return this.contracts.listOrders();
  }

  @Get('orders/:id')
  getOrder(@Param('id') id: string) {
    return this.contracts.getOrder(id);
  }

  @Post('orders/:id/status')
  setStatus(
    @Param('id') id: string,
    @Body() body: { status: PoStatus; note?: string },
    @CurrentUser() auth: AccessTokenPayload,
  ) {
    return this.contracts.setOrderStatus(id, body.status, body.note, auth);
  }
}

@Module({ controllers: [ContractsController], providers: [ContractsService] })
export class ContractsModule {}
