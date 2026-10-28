import { lockOrder, uniqueIds, safeMoney, lineMoney, taxTotals } from '../../common/procurement/invariants';
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
    await lockOrder(m, poId);
    uniqueIds(dto.items ?? [], 'poItemId');
    const po = (await m.query(`SELECT id, buyer_org_id, supplier_org_id, currency, vat_mode, department_id FROM purchase_orders WHERE id = $1`, [poId]))[0];
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
      // Draw-down: quantities already allocated to matched/approved/paid invoices cannot be billed
      // again — otherwise the same delivery could be invoiced (and paid) twice.
      const invoiced = Number(
        (await m.query(
          `SELECT COALESCE(SUM(ii.qty),0) AS q FROM invoice_items ii
           JOIN invoices i ON i.id = ii.invoice_id
           WHERE ii.po_item_id=$1 AND i.status IN ('MATCHED','APPROVED','PAID')`,
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
      const amount = lineMoney(Number(it.qty), it.unitPriceMinor);
      const lineTax = taxTotals(amount, Number(poItem.vat_rate_bp ?? VAT_RATE_BP), po.vat_mode);
      (it as any).tax = { ...lineTax, rate: Number(poItem.vat_rate_bp ?? VAT_RATE_BP) };
      const lineNet = lineTax.net;
      const rateBp = poItem.vat_rate_bp == null ? VAT_RATE_BP : Number(poItem.vat_rate_bp);
      net += lineNet;
      vat += lineTax.tax;
    }
    const gross = safeMoney(net + vat);
    const status: InvoiceStatus = allOk ? 'MATCHED' : 'DISPUTED';

    const n = await m.query(`SELECT next_document_no($1,'INV') AS n`, [auth.org_id]);
    const invoiceNo = `INV-${new Date().getFullYear()}-${String(Number(n[0].n)).padStart(4, '0')}`;
    const inv = (
      await m.query(
        `INSERT INTO invoices(buyer_org_id, supplier_org_id, po_id, invoice_no, currency, net_minor, vat_minor, gross_minor, status, match, due_date, created_by, department_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [po.buyer_org_id, auth.org_id, poId, invoiceNo, po.currency, net, vat, gross, status,
         JSON.stringify({ ok: allOk, lines: matchLines }), dto.dueDate ?? null, auth.sub,
         // inherited from the PO so paid-spend reporting survives the PO being re-scoped
         po.department_id ?? null],
      )
    )[0];
    for (const it of dto.items) {
      await m.query(
        `INSERT INTO invoice_items(invoice_id, po_item_id, buyer_org_id, supplier_org_id, qty, unit_price_minor, line_total_minor, vat_rate_bp, vat_minor, gross_minor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [inv.id, it.poItemId, po.buyer_org_id, auth.org_id, it.qty, it.unitPriceMinor, (it as any).tax.net, (it as any).tax.rate, (it as any).tax.tax, (it as any).tax.gross],
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

  // 1C-import bridge: the org's invoices as a `;`-separated CSV (UTF-8, the delimiter 1C
  // expects). Not full CommerceML — a mappable flat file the accountant loads into 1C.
  async export1cCsv(): Promise<string> {
    const rows = await this.rc.manager.query(
      `SELECT i.invoice_no, i.issued_at, i.created_at, i.status, i.net_minor, i.vat_minor, i.gross_minor,
              i.currency, p.po_no, os.legal_name AS supplier, os.voen AS supplier_voen
       FROM invoices i
       JOIN organizations os ON os.id = i.supplier_org_id
       JOIN purchase_orders p ON p.id = i.po_id
       ORDER BY i.created_at`,
    );
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const money = (m: unknown) => (Number(m) / 100).toFixed(2);
    const header = ['Номер', 'Дата', 'Статус', 'Поставщик', 'ВОЕН', 'Заказ', 'Без НДС', 'НДС', 'Итого', 'Валюта'];
    const lines = rows.map((r: any) => [
      r.invoice_no, new Date(r.issued_at ?? r.created_at).toISOString().slice(0, 10), r.status,
      r.supplier, r.supplier_voen, r.po_no, money(r.net_minor), money(r.vat_minor), money(r.gross_minor), r.currency,
    ].map(esc).join(';'));
    return '﻿' + [header.map(esc).join(';'), ...lines].join('\r\n'); // BOM so 1C/Excel read UTF-8
  }

  async get(id: string) {
    const inv = (await this.rc.manager.query(`SELECT * FROM invoices WHERE id = $1`, [id]))[0];
    if (!inv) throw new NotFoundException('Invoice not found');
    const items = await this.rc.manager.query(`SELECT * FROM invoice_items WHERE invoice_id = $1`, [id]);
    return { ...inv, items };
  }

  // Generic UBL 2.1 Invoice XML; does not claim a Peppol BIS profile. Real Peppol transmission needs an
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
    if (items.some((it: any) => it.vat_rate_bp == null || it.vat_minor == null))
      throw new BadRequestException('Legacy invoice requires an audited tax snapshot before UBL export');
    const taxGroups = new Map<number, {net:number;tax:number}>();
    for (const it of items) {
      const rate=Number(it.vat_rate_bp); const g=taxGroups.get(rate) ?? {net:0,tax:0};
      g.net+=Number(it.line_total_minor);g.tax+=Number(it.vat_minor);taxGroups.set(rate,g);
    }
    const taxSubtotals = [...taxGroups].map(([rate,g]) => `<cac:TaxSubtotal><cbc:TaxableAmount currencyID="${inv.currency}">${money(g.net)}</cbc:TaxableAmount><cbc:TaxAmount currencyID="${inv.currency}">${money(g.tax)}</cbc:TaxAmount><cac:TaxCategory><cbc:ID>${rate ? 'S' : 'Z'}</cbc:ID><cbc:Percent>${rate/100}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>`).join('');
    const unitCode = (uom: string) => {
      const codes: Record<string,string> = {pcs:'C62','ədəd':'C62','əd':'C62','шт':'C62',kg:'KGM','кг':'KGM',g:'GRM',t:'TNE',l:'LTR',m:'MTR',m2:'MTK',m3:'MTQ',h:'HUR',hour:'HUR',day:'DAY','gün':'DAY',box:'XBX',pack:'XPK',set:'SET','dəst':'SET'};
      const code=codes[String(uom).toLowerCase()];
      if (!code) throw new BadRequestException('Invoice unit requires an explicit UBL unit mapping');
      return code;
    };
    const lines = items.map((it: any, i: number) => `
  <cac:InvoiceLine>
    <cbc:ID>${i + 1}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="${unitCode(it.uom)}">${Number(it.qty)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${inv.currency}">${money(it.line_total_minor)}</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>${esc(it.name)}</cbc:Name>
      <cac:ClassifiedTaxCategory><cbc:ID>${Number(it.vat_rate_bp) ? 'S' : 'Z'}</cbc:ID><cbc:Percent>${Number(it.vat_rate_bp)/100}</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="${inv.currency}">${(Number(it.line_total_minor)/Number(it.qty)/100).toFixed(6)}</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
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
  <cac:TaxTotal><cbc:TaxAmount currencyID="${inv.currency}">${money(inv.vat_minor)}</cbc:TaxAmount>${taxSubtotals}</cac:TaxTotal>
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
    const inv = await this.get(id);
    await lockOrder(this.rc.manager, inv.po_id);
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

  // Integrations → 1C: download all invoices as a CSV 1C can import.
  @Get('export/1c')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  async export1c(@Res() res: Response) {
    const csv = await this.invoices.export1cCsv();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="invoices-1c.csv"');
    res.send(csv);
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
