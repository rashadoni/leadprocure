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
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AccessTokenPayload, InvoiceStatus } from '@leadprocure/shared';
import { IsArray, IsInt, IsOptional, IsString, IsUUID, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
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
    let vat = 0;
    let allOk = true;
    for (const it of dto.items) {
      if (!Number.isInteger(it.unitPriceMinor) || it.unitPriceMinor < 0) throw new BadRequestException('unitPriceMinor must be a non-negative integer');
      if (!(Number(it.qty) > 0)) throw new BadRequestException('qty must be positive');
      const poItem = (await m.query(`SELECT unit_price_minor, qty, vat_rate_bp FROM purchase_order_items WHERE id=$1 AND po_id=$2`, [it.poItemId, poId]))[0];
      if (!poItem) throw new BadRequestException(`Item ${it.poItemId} is not on this order`);
      const received = Number(
        (await m.query(`SELECT COALESCE(SUM(qty_received),0) AS r FROM goods_receipt_items WHERE po_item_id=$1`, [it.poItemId]))[0].r,
      );
      // Draw-down: quantities already billed on prior, non-rejected invoices cannot be billed
      // again — otherwise the same delivery could be invoiced (and paid) twice.
      const invoiced = Number(
        (await m.query(
          `SELECT COALESCE(SUM(ii.qty),0) AS q FROM invoice_items ii
           JOIN invoices i ON i.id = ii.invoice_id
           WHERE ii.po_item_id=$1 AND i.status <> 'REJECTED'`,
          [it.poItemId],
        ))[0].q,
      );
      const billable = received - invoiced;
      const priceOk = it.unitPriceMinor <= Number(poItem.unit_price_minor);
      const qtyOk = Number(it.qty) <= billable; // received, minus what was already invoiced
      if (!priceOk || !qtyOk) allOk = false;
      matchLines.push({
        po_item_id: it.poItemId, price_ok: priceOk, qty_ok: qtyOk,
        invoice_price: it.unitPriceMinor, po_price: Number(poItem.unit_price_minor),
        invoice_qty: Number(it.qty), received, already_invoiced: invoiced, billable,
      });
      // Per-line ƏDV from the PO line's own rate (0% / exempt lines carry vat_rate_bp = 0),
      // not a flat 18% on the whole invoice.
      const lineNet = Number(it.qty) * it.unitPriceMinor;
      const rateBp = poItem.vat_rate_bp == null ? VAT_RATE_BP : Number(poItem.vat_rate_bp);
      net += lineNet;
      vat += Math.round((lineNet * rateBp) / 10000);
    }
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
       ORDER BY i.created_at DESC LIMIT 200`,
    );
  }

  async get(id: string) {
    const inv = (await this.rc.manager.query(`SELECT * FROM invoices WHERE id = $1`, [id]))[0];
    if (!inv) throw new NotFoundException('Invoice not found');
    const items = await this.rc.manager.query(`SELECT * FROM invoice_items WHERE invoice_id = $1`, [id]);
    return { ...inv, items };
  }

  // Peppol BIS Billing 3.0-shaped UBL 2.1 Invoice XML. Real Peppol transmission needs an
  // Access Point provider (external onboarding); this export is the document seam.
  async ublXml(id: string): Promise<string> {
    const m = this.rc.manager;
    const inv = (
      await m.query(
        `SELECT i.*, ob.legal_name AS buyer_name, ob.voen AS buyer_voen,
                os.legal_name AS supplier_name, os.voen AS supplier_voen, p.po_no
         FROM invoices i
         JOIN organizations ob ON ob.id = i.buyer_org_id
         JOIN organizations os ON os.id = i.supplier_org_id
         JOIN purchase_orders p ON p.id = i.po_id
         WHERE i.id = $1`,
        [id],
      )
    )[0];
    if (!inv) throw new NotFoundException('Invoice not found');
    const items = await m.query(
      `SELECT ii.*, poi.name, poi.uom FROM invoice_items ii
       JOIN purchase_order_items poi ON poi.id = ii.po_item_id WHERE ii.invoice_id = $1`,
      [id],
    );
    const money = (minor: number | string) => (Number(minor) / 100).toFixed(2);
    const esc = (s: string) => String(s ?? '').replace(/[<>&'"]/g, (c) =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] as string));
    const lines = items.map((it: any, i: number) => `
  <cac:InvoiceLine>
    <cbc:ID>${i + 1}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="C62">${Number(it.qty)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${inv.currency}">${money(it.line_total_minor)}</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>${esc(it.name)}</cbc:Name>
      <cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>18</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="${inv.currency}">${money(it.unit_price_minor)}</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>
  <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
  <cbc:ID>${esc(inv.invoice_no)}</cbc:ID>
  <cbc:IssueDate>${new Date(inv.issued_at).toISOString().slice(0, 10)}</cbc:IssueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${inv.currency}</cbc:DocumentCurrencyCode>
  <cac:OrderReference><cbc:ID>${esc(inv.po_no)}</cbc:ID></cac:OrderReference>
  <cac:AccountingSupplierParty><cac:Party>
    <cac:PartyName><cbc:Name>${esc(inv.supplier_name)}</cbc:Name></cac:PartyName>
    <cac:PartyTaxScheme><cbc:CompanyID>${esc(inv.supplier_voen ?? '')}</cbc:CompanyID>
      <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
  </cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party>
    <cac:PartyName><cbc:Name>${esc(inv.buyer_name)}</cbc:Name></cac:PartyName>
    <cac:PartyTaxScheme><cbc:CompanyID>${esc(inv.buyer_voen ?? '')}</cbc:CompanyID>
      <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
  </cac:Party></cac:AccountingCustomerParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="${inv.currency}">${money(inv.vat_minor)}</cbc:TaxAmount></cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${inv.currency}">${money(inv.net_minor)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${inv.currency}">${money(inv.net_minor)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${inv.currency}">${money(inv.gross_minor)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${inv.currency}">${money(inv.gross_minor)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>${lines}
</Invoice>`;
  }

  // reason is required by the DB seam only for the DISPUTED → APPROVED override.
  async setStatus(id: string, status: InvoiceStatus, auth: AccessTokenPayload, reason?: string) {
    try {
      const rows = await this.rc.manager.query(
        `SELECT * FROM invoice_set_status($1, $2::invoice_status, $3)`, [id, status, reason ?? null]);
      await this.audit.record('INVOICE_STATUS_CHANGED', 'invoice', id, { status, by_org: auth.org_id, override_reason: reason ?? null });
      await this.notify.notifyOrg(rows[0].supplier_org_id, 'INVOICE_STATUS_CHANGED', { invoice_id: id, status });
      return rows[0];
    } catch (e: any) {
      throw new BadRequestException(e.message?.replace(/^.*ERROR:\s*/, '') ?? 'Transition failed');
    }
  }
}

class ApproveInvoiceDto {
  @IsOptional() @IsString() reason?: string;
}

class InvoiceLineDto {
  @IsUUID() poItemId!: string;
  @IsInt() @Min(1) qty!: number;
  @IsInt() @Min(0) unitPriceMinor!: number;
}
class SubmitInvoiceDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => InvoiceLineDto) items!: InvoiceLineDto[];
  @IsOptional() @IsString() dueDate?: string;
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

  @Get(':id/ubl')
  async ubl(@Param('id') id: string, @Res() res: Response) {
    const xml = await this.invoices.ublXml(id);
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${id}.xml"`);
    res.send(xml);
  }

  @Post('from-po/:poId')
  @Roles('SUPPLIER_USER')
  submit(@Param('poId') poId: string, @Body() body: SubmitInvoiceDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.invoices.submit(poId, body, auth);
  }

  @Post(':id/approve')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  approve(@Param('id') id: string, @Body() body: ApproveInvoiceDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.invoices.setStatus(id, 'APPROVED', auth, body.reason);
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
