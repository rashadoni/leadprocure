import { RequiresNewWork } from '../../common/auth/decorators';
import { assertSupplierAllowed, uniqueIds, safeMoney, lineMoney, returnedRows } from '../../common/procurement/invariants';
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
import type { AccessTokenPayload } from '@leadprocure/shared';
import { IsArray, IsInt, IsOptional, IsString, IsUUID, Max, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser, RequiresFeature, Roles } from '../../common/auth/decorators';
import { RequestContextService } from '../../common/context/request-context.service';
import { AuditService } from '../../common/audit/audit.service';
import { NotifyService } from '../../common/notify/notify.module';

@Injectable()
export class CatalogsService {
  constructor(
    private readonly rc: RequestContextService,
    private readonly audit: AuditService,
    private readonly notify: NotifyService,
  ) {}

  async create(dto: { supplierOrgId: string; title: string; currency?: string }, auth: AccessTokenPayload) {
    await assertSupplierAllowed(this.rc.manager, auth.org_id, dto.supplierOrgId);
    const rows = await this.rc.manager.query(
      `INSERT INTO catalogs(buyer_org_id, supplier_org_id, title, currency, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [auth.org_id, dto.supplierOrgId, dto.title, dto.currency ?? 'AZN', auth.sub],
    );
    await this.audit.record('CATALOG_CREATED', 'catalog', rows[0].id, { supplier_org_id: dto.supplierOrgId });
    return this.get(rows[0].id);
  }

  // Seed a catalog straight from an awarded contract's priced lines.
  async createFromContract(contractId: string, auth: AccessTokenPayload) {
    const m = this.rc.manager;
    const c = (await m.query(`SELECT * FROM contracts WHERE id = $1`, [contractId]))[0];
    if (!c) throw new NotFoundException('Contract not found');
    if (c.buyer_org_id !== auth.org_id) throw new BadRequestException('Not your contract');
    await assertSupplierAllowed(m, auth.org_id, c.supplier_org_id);
    if (c.status !== 'ACTIVE') throw new BadRequestException('Contract must be ACTIVE');
    // A contract has one price list, and the button that calls this gives no visible result
    // on the page it lives on — so a reader who clicks again because "nothing happened" used
    // to end up with a second identical draft. An existing DRAFT for this contract is
    // returned instead. An ACTIVE or archived one is left alone: re-issuing a price list
    // after the previous one went live is a real thing to want.
    const existing = (
      await m.query(
        `SELECT id FROM catalogs WHERE contract_id = $1 AND status = 'DRAFT' ORDER BY created_at LIMIT 1`,
        [contractId],
      )
    )[0];
    if (existing) return this.get(existing.id);
    const cat = (
      await m.query(
        `INSERT INTO catalogs(buyer_org_id, supplier_org_id, contract_id, title, currency, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [auth.org_id, c.supplier_org_id, contractId, `${c.title} — catalog`, c.currency, auth.sub],
      )
    )[0];
    await m.query(
      `INSERT INTO catalog_items(catalog_id, buyer_org_id, supplier_org_id, name, uom, unit_price_minor, vat_rate_bp)
       SELECT $1, $2, $3, ei.name, ei.uom, bi.unit_price_minor, ei.vat_rate_bp
       FROM contracts c JOIN awards a ON a.id = c.award_id
       JOIN bid_items bi ON bi.bid_id = a.winning_bid_id
       JOIN event_items ei ON ei.id = bi.event_item_id
       WHERE c.id = $4 AND ei.lot_id=a.lot_id AND a.cancelled_at IS NULL`,
      [cat.id, auth.org_id, c.supplier_org_id, contractId],
    );
    await this.audit.record('CATALOG_CREATED', 'catalog', cat.id, { from_contract: contractId });
    return this.get(cat.id);
  }

  async addItem(
    catalogId: string,
    dto: { name: string; sku?: string; uom?: string; unitPriceMinor: number; moq?: number; vatRateBp?: number },
    auth: AccessTokenPayload,
  ) {
    const cat = await this.requireCatalog(catalogId, auth);
    if (!Number.isInteger(dto.unitPriceMinor) || dto.unitPriceMinor < 0) {
      throw new BadRequestException('unitPriceMinor must be a non-negative integer');
    }
    await this.rc.manager.query(
      `INSERT INTO catalog_items(catalog_id, buyer_org_id, supplier_org_id, name, sku, uom, unit_price_minor, vat_rate_bp, moq)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [catalogId, auth.org_id, cat.supplier_org_id, dto.name, dto.sku ?? null, dto.uom ?? 'pcs',
       dto.unitPriceMinor, dto.vatRateBp ?? 1800, dto.moq ?? 1],
    );
    return this.get(catalogId);
  }

  async activate(catalogId: string, auth: AccessTokenPayload) {
    await this.requireCatalog(catalogId, auth);
    const rows = returnedRows(await this.rc.manager.query(
      `UPDATE catalogs SET status='ACTIVE', updated_at=now() WHERE id=$1 AND status='DRAFT' RETURNING id`,
      [catalogId],
    ));
    if (!rows.length) throw new BadRequestException('Catalog not found or not DRAFT');
    await this.audit.record('CATALOG_ACTIVATED', 'catalog', catalogId, {});
    return this.get(catalogId);
  }

  async list() {
    return this.rc.manager.query(
      `SELECT c.*, ob.legal_name AS buyer_name, os.legal_name AS supplier_name,
              (SELECT count(*)::int FROM catalog_items ci WHERE ci.catalog_id = c.id) AS item_count
       FROM catalogs c
       JOIN organizations ob ON ob.id = c.buyer_org_id
       JOIN organizations os ON os.id = c.supplier_org_id
       ORDER BY c.created_at DESC LIMIT 200`,
    );
  }

  async get(id: string) {
    const c = (await this.rc.manager.query(`SELECT * FROM catalogs WHERE id = $1`, [id]))[0];
    if (!c) throw new NotFoundException('Catalog not found');
    const items = await this.rc.manager.query(
      `SELECT id, name, sku, uom, unit_price_minor, vat_rate_bp, moq FROM catalog_items WHERE catalog_id = $1 ORDER BY name`,
      [id],
    );
    return { ...c, items };
  }

  // Instant re-order from an active catalog — becomes a PO (no tender), MOQ enforced.
  async order(
    catalogId: string,
    lines: Array<{ catalogItemId: string; qty: number }>,
    auth: AccessTokenPayload,
    departmentId?: string,
  ) {
    const m = this.rc.manager;
    const cat = await this.requireCatalog(catalogId, auth);
    await assertSupplierAllowed(m, auth.org_id, cat.supplier_org_id);
    if (cat.status !== 'ACTIVE') throw new BadRequestException('Catalog must be ACTIVE');
    if (!lines?.length) throw new BadRequestException('At least one line is required');
    uniqueIds(lines, 'catalogItemId');
    const items = await m.query(`SELECT * FROM catalog_items WHERE catalog_id = $1`, [catalogId]);
    const byId = new Map<string, any>(items.map((i: any) => [i.id, i]));

    const poLines: Array<{ ci: any; qty: number; lineTotal: number }> = [];
    let total = 0;
    for (const l of lines) {
      const ci = byId.get(l.catalogItemId);
      if (!ci) throw new BadRequestException(`Unknown catalog item ${l.catalogItemId}`);
      if (!(Number(l.qty) > 0)) throw new BadRequestException('qty must be positive');
      if (Number(l.qty) < Number(ci.moq)) throw new BadRequestException(`Below MOQ (${ci.moq}) for ${ci.name}`);
      const lineTotal = lineMoney(Number(l.qty), Number(ci.unit_price_minor));
      total += lineTotal;
      poLines.push({ ci, qty: Number(l.qty), lineTotal });
    }

    safeMoney(total);
    // Which cost centre this call-off is charged to: an explicit pick, else the buyer's
    // home department. Without one the spend lands in the "outside every budget" report.
    let dep: string | null = departmentId ?? null;
    if (dep) {
      const found = await m.query(`SELECT id, is_active FROM departments WHERE id = $1`, [dep]);
      if (!found.length) throw new BadRequestException('Unknown department');
      if (!found[0].is_active) throw new BadRequestException('Department is inactive');
    } else {
      dep = (
        await m.query(
          `SELECT department_id FROM memberships WHERE user_id = $1 AND org_id = $2 AND department_id IS NOT NULL LIMIT 1`,
          [auth.sub, auth.org_id],
        )
      )[0]?.department_id ?? null;
    }

    const n = await m.query(`SELECT next_document_no($1,'PO') AS n`, [auth.org_id]);
    const poNo = `PO-${new Date().getFullYear()}-${String(Number(n[0].n)).padStart(4, '0')}`;
    const po = (
      await m.query(
        `INSERT INTO purchase_orders(contract_id, buyer_org_id, supplier_org_id, po_no, status, total_minor,
           currency, created_by, department_id)
         VALUES ($1,$2,$3,$4,'DRAFT',$5,$6,$7,$8) RETURNING id`,
        [cat.contract_id, auth.org_id, cat.supplier_org_id, poNo, total, cat.currency, auth.sub, dep],
      )
    )[0];
    await m.query(`UPDATE purchase_orders SET vat_mode=COALESCE((SELECT vat_mode FROM contracts WHERE id=$2),'EXCLUSIVE') WHERE id=$1`,[po.id,cat.contract_id]);
    let line = 1;
    for (const pl of poLines) {
      await m.query(
        `INSERT INTO purchase_order_items(po_id, buyer_org_id, supplier_org_id, line_no, name, qty, uom, unit_price_minor, line_total_minor, vat_rate_bp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [po.id, auth.org_id, cat.supplier_org_id, line++, pl.ci.name, pl.qty, pl.ci.uom,
         pl.ci.unit_price_minor, pl.lineTotal, pl.ci.vat_rate_bp],
      );
    }
    await this.audit.record('CATALOG_ORDER_CREATED', 'purchase_order', po.id, { catalog_id: catalogId, po_no: poNo, total_minor: total });
    await this.notify.notifyOrg(cat.supplier_org_id, 'CATALOG_ORDER_CREATED', { po_no: poNo, po_id: po.id });
    return { id: po.id, po_no: poNo, total_minor: total, status: 'DRAFT' };
  }

  private async requireCatalog(id: string, auth: AccessTokenPayload) {
    const c = (await this.rc.manager.query(`SELECT * FROM catalogs WHERE id = $1`, [id]))[0];
    if (!c) throw new NotFoundException('Catalog not found');
    if (c.buyer_org_id !== auth.org_id) throw new BadRequestException('Not your catalog');
    return c;
  }
}

class CreateCatalogDto {
  @IsUUID() supplierOrgId!: string;
  @IsString() @MinLength(1) title!: string;
  @IsOptional() @IsString() currency?: string;
}
class AddCatalogItemDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsString() sku?: string;
  @IsOptional() @IsString() uom?: string;
  @IsInt() @Min(0) unitPriceMinor!: number;
  @IsOptional() @IsInt() @Min(1) moq?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10000) vatRateBp?: number;
}
class CatalogOrderItemDto {
  @IsUUID() catalogItemId!: string;
  @IsInt() @Min(1) qty!: number;
}
class CatalogOrderDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => CatalogOrderItemDto) items!: CatalogOrderItemDto[];
  // A catalog call-off skips the request stage, so it is the only chance to say whose
  // budget it comes out of. Omitted → the ordering user's home department.
  @IsOptional() @IsUUID() departmentId?: string;
}

@Controller('catalogs')
@RequiresFeature('contracts.catalog')
export class CatalogsController {
  constructor(private readonly catalogs: CatalogsService) {}

  @Get()
  list() {
    return this.catalogs.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.catalogs.get(id);
  }

  @Post()
  @RequiresNewWork()
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  create(@Body() body: CreateCatalogDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.catalogs.create(body, auth);
  }

  @Post('from-contract/:contractId')
  @RequiresNewWork()
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  fromContract(@Param('contractId') contractId: string, @CurrentUser() auth: AccessTokenPayload) {
    return this.catalogs.createFromContract(contractId, auth);
  }

  @Post(':id/items')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  addItem(@Param('id') id: string, @Body() body: AddCatalogItemDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.catalogs.addItem(id, body, auth);
  }

  @Post(':id/activate')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  activate(@Param('id') id: string, @CurrentUser() auth: AccessTokenPayload) {
    return this.catalogs.activate(id, auth);
  }

  @Post(':id/order')
  @RequiresNewWork()
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER')
  order(@Param('id') id: string, @Body() body: CatalogOrderDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.catalogs.order(id, body.items, auth, body.departmentId);
  }
}

@Module({ controllers: [CatalogsController], providers: [CatalogsService] })
export class CatalogsModule {}
