import { Body, Controller, Get, Injectable, Module, NotFoundException, Param, Post } from '@nestjs/common';
import { RequiresFeature, Roles } from '../../common/auth/decorators';
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
       ORDER BY r.created_at DESC`,
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

  async setStatus(relationshipId: string, status: 'APPROVED' | 'BLOCKED') {
    const rows = await this.rc.manager.query(
      `UPDATE supplier_relationships SET status = $2, updated_at = now() WHERE id = $1 RETURNING id, status`,
      [relationshipId, status],
    );
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
  setStatus(@Param('id') id: string, @Body() body: { status: 'APPROVED' | 'BLOCKED' }) {
    return this.suppliers.setStatus(id, body.status === 'BLOCKED' ? 'BLOCKED' : 'APPROVED');
  }
}

@Module({ controllers: [SuppliersController], providers: [SuppliersService] })
export class SuppliersModule {}
