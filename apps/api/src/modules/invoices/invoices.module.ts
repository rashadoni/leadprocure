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
import type { AccessTokenPayload, InvoiceStatus } from '@leadprocure/shared';
import { CurrentUser, RequiresFeature, Roles } from '../../common/auth/decorators';
import { RequestContextService } from '../../common/context/request-context.service';
import { AuditService } from '../../common/audit/audit.service';
import { NotifyService } from '../../common/notify/notify.module';

const VAT_RATE_BP = 1800; // 18% ƏDV

@Injectable()
export class InvoicesService {
  constructor(
    private readonly rc: RequestContextService,
    private readonly audit: AuditService,
    private readonly notify: NotifyService,
  ) {}

  // Supplier submits an invoice for a PO; a 3-way match (invoice ↔ PO ↔ receipt) runs
  // immediately → MATCHED or DISPUTED.
  async submit(
    poId: string,
    dto: { items: Array<{ poItemId: string; qty: number; unitPriceMinor: number }>; dueDate?: string },
    auth: AccessTokenPayload,
  ) {
    const m = this.rc.manager;
    const po = (await m.query(`SELECT id, buyer_org_id, supplier_org_id, currency FROM purchase_orders WHERE id = $1`, [poId]))[0];
    if (!po) throw new NotFoundException('Order not found');
    if (po.supplier_org_id !== auth.org_id) throw new BadRequestException('Only the awarded supplier invoices this order');
    if (!dto.items?.length) throw new BadRequestException('At least one line is required');

    const matchLines: any[] = [];
    let net = 0;
    let allOk = true;
    for (const it of dto.items) {
      if (!Number.isInteger(it.unitPriceMinor) || it.unitPriceMinor < 0) throw new BadRequestException('unitPriceMinor must be a non-negative integer');
      if (!(Number(it.qty) > 0)) throw new BadRequestException('qty must be positive');
      const poItem = (await m.query(`SELECT unit_price_minor, qty FROM purchase_order_items WHERE id=$1 AND po_id=$2`, [it.poItemId, poId]))[0];
      if (!poItem) throw new BadRequestException(`Item ${it.poItemId} is not on this order`);
      const received = Number(
        (await m.query(`SELECT COALESCE(SUM(qty_received),0) AS r FROM goods_receipt_items WHERE po_item_id=$1`, [it.poItemId]))[0].r,
      );
      const priceOk = it.unitPriceMinor <= Number(poItem.unit_price_minor);
      const qtyOk = Number(it.qty) <= received; // bill only what was received
      if (!priceOk || !qtyOk) allOk = false;
      matchLines.push({
        po_item_id: it.poItemId, price_ok: priceOk, qty_ok: qtyOk,
        invoice_price: it.unitPriceMinor, po_price: Number(poItem.unit_price_minor),
        invoice_qty: Number(it.qty), received,
      });
      net += Number(it.qty) * it.unitPriceMinor;
    }
    const vat = Math.round((net * VAT_RATE_BP) / 10000);
    const gross = net + vat;
    const status: InvoiceStatus = allOk ? 'MATCHED' : 'DISPUTED';

    const n = await m.query(`SELECT count(*)::int AS n FROM invoices WHERE supplier_org_id=$1`, [auth.org_id]);
    const invoiceNo = `INV-${new Date().getFullYear()}-${String(n[0].n + 1).padStart(4, '0')}`;
    const inv = (
      await m.query(
        `INSERT INTO invoices(buyer_org_id, supplier_org_id, po_id, invoice_no, currency, net_minor, vat_minor, gross_minor, status, match, due_date, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [po.buyer_org_id, auth.org_id, poId, invoiceNo, po.currency, net, vat, gross, status,
         JSON.stringify({ ok: allOk, lines: matchLines }), dto.dueDate ?? null, auth.sub],
      )
    )[0];
    for (const it of dto.items) {
      await m.query(
        `INSERT INTO invoice_items(invoice_id, po_item_id, buyer_org_id, supplier_org_id, qty, unit_price_minor, line_total_minor)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [inv.id, it.poItemId, po.buyer_org_id, auth.org_id, it.qty, it.unitPriceMinor, Number(it.qty) * it.unitPriceMinor],
      );
    }
    await this.audit.record('INVOICE_SUBMITTED', 'invoice', inv.id, { po_id: poId, status, gross_minor: gross });
    await this.notify.notifyOrg(po.buyer_org_id, 'INVOICE_SUBMITTED', { invoice_no: invoiceNo, status });
    return this.get(inv.id);
  }

  async list() {
    return this.rc.manager.query(
      `SELECT i.*, ob.legal_name AS buyer_name, os.legal_name AS supplier_name, p.po_no
       FROM invoices i
       JOIN organizations ob ON ob.id = i.buyer_org_id
       JOIN organizations os ON os.id = i.supplier_org_id
       JOIN purchase_orders p ON p.id = i.po_id
       ORDER BY i.created_at DESC`,
    );
  }

  async get(id: string) {
    const inv = (await this.rc.manager.query(`SELECT * FROM invoices WHERE id = $1`, [id]))[0];
    if (!inv) throw new NotFoundException('Invoice not found');
    const items = await this.rc.manager.query(`SELECT * FROM invoice_items WHERE invoice_id = $1`, [id]);
    return { ...inv, items };
  }

  async setStatus(id: string, status: InvoiceStatus, auth: AccessTokenPayload) {
    try {
      const rows = await this.rc.manager.query(`SELECT * FROM invoice_set_status($1, $2::invoice_status)`, [id, status]);
      await this.audit.record('INVOICE_STATUS_CHANGED', 'invoice', id, { status, by_org: auth.org_id });
      await this.notify.notifyOrg(rows[0].supplier_org_id, 'INVOICE_STATUS_CHANGED', { invoice_id: id, status });
      return rows[0];
    } catch (e: any) {
      throw new BadRequestException(e.message?.replace(/^.*ERROR:\s*/, '') ?? 'Transition failed');
    }
  }
}

@Controller('invoices')
@RequiresFeature('p2p.invoicing')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  list() {
    return this.invoices.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.invoices.get(id);
  }

  @Post('from-po/:poId')
  @Roles('SUPPLIER_USER')
  submit(@Param('poId') poId: string, @Body() body: any, @CurrentUser() auth: AccessTokenPayload) {
    return this.invoices.submit(poId, body, auth);
  }

  @Post(':id/approve')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  approve(@Param('id') id: string, @CurrentUser() auth: AccessTokenPayload) {
    return this.invoices.setStatus(id, 'APPROVED', auth);
  }

  @Post(':id/reject')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  reject(@Param('id') id: string, @CurrentUser() auth: AccessTokenPayload) {
    return this.invoices.setStatus(id, 'REJECTED', auth);
  }

  @Post(':id/pay')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  pay(@Param('id') id: string, @CurrentUser() auth: AccessTokenPayload) {
    return this.invoices.setStatus(id, 'PAID', auth);
  }
}

@Module({ controllers: [InvoicesController], providers: [InvoicesService] })
export class InvoicesModule {}
