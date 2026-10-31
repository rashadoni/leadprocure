import { returnedRows } from '../../common/procurement/invariants';
import { BadRequestException, Body, Controller, Get, Injectable, Module, NotFoundException, Param, Post } from '@nestjs/common';
import type { AccessTokenPayload } from '@leadprocure/shared';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { CurrentUser, RequiresFeature, Roles } from '../../common/auth/decorators';
import { RequestContextService } from '../../common/context/request-context.service';
import { AuditService } from '../../common/audit/audit.service';

@Injectable()
export class SuppliersService {
  constructor(
    private readonly rc: RequestContextService,
    private readonly audit: AuditService,
  ) {}

  // Global directory (supplier orgs are network-global; RLS does not hide them).
  async directory() {
    return this.rc.manager.query(
      `SELECT o.id, o.legal_name, o.voen, o.country, sp.categories
       FROM organizations o JOIN supplier_profiles sp ON sp.org_id = o.id
       WHERE o.kind IN ('SUPPLIER','BOTH') AND o.status = 'ACTIVE'
       ORDER BY o.legal_name`,
    );
  }

  // Buyer's own registry (per-buyer relationship rows; RLS scopes to buyer_org_id).
  async registry() {
    return this.rc.manager.query(
      `SELECT r.id, r.supplier_org_id, r.status, r.created_at, o.legal_name, o.voen, sp.categories
       FROM supplier_relationships r
       JOIN organizations o ON o.id = r.supplier_org_id
       LEFT JOIN supplier_profiles sp ON sp.org_id = r.supplier_org_id
       ORDER BY r.created_at DESC LIMIT 200`,
    );
  }

  async invite(supplierOrgId: string) {
    const m = this.rc.manager;
    const org = await m.query(
      `SELECT id FROM organizations WHERE id = $1 AND kind IN ('SUPPLIER','BOTH')`,
      [supplierOrgId],
    );
    if (!org.length) throw new NotFoundException('Supplier organization not found');
    const rows = await m.query(
      `INSERT INTO supplier_relationships(buyer_org_id, supplier_org_id, status)
       VALUES ($1,$2,'INVITED')
       ON CONFLICT (buyer_org_id, supplier_org_id) DO UPDATE SET updated_at = now()
       RETURNING id, status`,
      [this.rc.orgId, supplierOrgId],
    );
    await this.audit.record('SUPPLIER_INVITED', 'supplier_relationship', rows[0].id, {
      supplier_org_id: supplierOrgId,
    });
    return rows[0];
  }

  async scorecard(supplierOrgId: string) {
    const m = this.rc.manager;
    const entries = await m.query(
      `SELECT id, metric, score, note, source_po_id, created_at
       FROM supplier_scorecard_entries WHERE supplier_org_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [supplierOrgId],
    );
    const averages = await m.query(
      `SELECT metric, round(avg(score))::int AS avg_score, count(*)::int AS n
       FROM supplier_scorecard_entries WHERE supplier_org_id = $1 GROUP BY metric ORDER BY metric`,
      [supplierOrgId],
    );
    return { entries, averages };
  }

  async addScore(
    supplierOrgId: string,
    dto: { metric: 'OTIF' | 'QUALITY' | 'COMMS'; score: number; note?: string; sourcePoId?: string },
    buyerOrgId: string,
    userId: string,
  ) {
    const m = this.rc.manager;
    // A rating is an input to the award recommendation — reliability carries 30% of the
    // weighted total in ai-scorer — so it has to be about a supplier. Nothing stopped it
    // being attached to any uuid at all, a buyer organization included.
    const org = await m.query(
      `SELECT id FROM organizations WHERE id = $1 AND kind IN ('SUPPLIER','BOTH')`,
      [supplierOrgId],
    );
    if (!org.length) throw new NotFoundException('Supplier organization not found');
    // And when it cites an order, that order has to be this buyer's with this supplier.
    // RLS already hides everyone else's, so a foreign id simply finds nothing here.
    if (dto.sourcePoId) {
      const po = await m.query(
        `SELECT id FROM purchase_orders WHERE id = $1 AND buyer_org_id = $2 AND supplier_org_id = $3`,
        [dto.sourcePoId, buyerOrgId, supplierOrgId],
      );
      if (!po.length) throw new BadRequestException('That order is not yours with this supplier');
    }
    const row = (
      await this.rc.manager.query(
        `INSERT INTO supplier_scorecard_entries(buyer_org_id, supplier_org_id, source_po_id, metric, score, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [buyerOrgId, supplierOrgId, dto.sourcePoId ?? null, dto.metric, dto.score, dto.note ?? null, userId],
      )
    )[0];
    await this.audit.record('SCORECARD_ENTRY_ADDED', 'scorecard_entry', row.id, {
      supplier_org_id: supplierOrgId, metric: dto.metric, score: dto.score,
    });
    return this.scorecard(supplierOrgId);
  }

  async setStatus(relationshipId: string, status: 'APPROVED' | 'BLOCKED') {
    const rel=(await this.rc.manager.query(`SELECT buyer_org_id,supplier_org_id FROM supplier_relationships WHERE id=$1`,[relationshipId]))[0];
    if (!rel) throw new NotFoundException('Relationship not found');
    await this.rc.manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,85))`,[`${rel.buyer_org_id}:${rel.supplier_org_id}`]);
    const rows = returnedRows(await this.rc.manager.query(
      `UPDATE supplier_relationships SET status = $2, updated_at = now() WHERE id = $1 RETURNING id, status`,
      [relationshipId, status],
    ));
    if (!rows.length) throw new NotFoundException('Relationship not found');
    await this.audit.record(
      status === 'APPROVED' ? 'SUPPLIER_APPROVED' : 'SUPPLIER_BLOCKED',
      'supplier_relationship',
      relationshipId,
      {},
    );
    return rows[0];
  }
}

class SetRelStatusDto {
  @IsIn(['APPROVED', 'BLOCKED']) status!: 'APPROVED' | 'BLOCKED';
}
class AddScoreDto {
  @IsIn(['OTIF', 'QUALITY', 'COMMS']) metric!: 'OTIF' | 'QUALITY' | 'COMMS';
  @IsInt() @Min(0) @Max(100) score!: number;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsUUID() sourcePoId?: string;
}

@Controller('suppliers')
@RequiresFeature('suppliers.registry')
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Get('directory')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER')
  directory() {
    return this.suppliers.directory();
  }

  @Get()
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER')
  registry() {
    return this.suppliers.registry();
  }

  @Post(':supplierOrgId/invite')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  invite(@Param('supplierOrgId') supplierOrgId: string) {
    return this.suppliers.invite(supplierOrgId);
  }

  @Post('relationships/:id/status')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  setStatus(@Param('id') id: string, @Body() body: SetRelStatusDto) {
    return this.suppliers.setStatus(id, body.status === 'BLOCKED' ? 'BLOCKED' : 'APPROVED');
  }

  @Get(':supplierOrgId/scorecard')
  scorecard(@Param('supplierOrgId') supplierOrgId: string) {
    return this.suppliers.scorecard(supplierOrgId);
  }

  // Reliability from these entries is 30% of the weighted total the award recommendation
  // ranks by (SCORING_WEIGHTS in common/ai/ai-scorer.ts), so this is an input to who wins,
  // not a note. It now takes the same roles as the rest of the registry: a BUYER_USER who
  // may not approve a request, invite a supplier or block one may not move the ranking
  // either.
  @Post(':supplierOrgId/scorecard')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  addScore(
    @Param('supplierOrgId') supplierOrgId: string,
    @Body() body: AddScoreDto,
    @CurrentUser() auth: AccessTokenPayload,
  ) {
    return this.suppliers.addScore(supplierOrgId, body, auth.org_id, auth.sub);
  }
}

@Module({ controllers: [SuppliersController], providers: [SuppliersService] })
export class SuppliersModule {}
