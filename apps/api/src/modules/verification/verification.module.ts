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
import type { AccessTokenPayload, VerificationStatus } from '@leadprocure/shared';
import { VERIFICATION_STATUSES } from '@leadprocure/shared';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Min, MinLength } from 'class-validator';
import { CurrentUser, RequiresFeature, Roles } from '../../common/auth/decorators';
import { RequestContextService } from '../../common/context/request-context.service';
import { AuditService } from '../../common/audit/audit.service';
import { NotifyService } from '../../common/notify/notify.module';
import { DocumentsService } from '../../common/storage/documents.module';

@Injectable()
export class VerificationService {
  constructor(
    private readonly rc: RequestContextService,
    private readonly audit: AuditService,
    private readonly notify: NotifyService,
    private readonly docs: DocumentsService,
  ) {}

  // Buyer opens (or re-opens) a KYC case for a supplier.
  async openCase(supplierOrgId: string, auth: AccessTokenPayload) {
    const rows = await this.rc.manager.query(
      `INSERT INTO supplier_verification_cases(buyer_org_id, supplier_org_id, status)
       VALUES ($1,$2,'NEW')
       ON CONFLICT (buyer_org_id, supplier_org_id) DO UPDATE SET status='IN_REVIEW'
       RETURNING id, status`,
      [auth.org_id, supplierOrgId],
    );
    await this.audit.record('VERIFICATION_OPENED', 'verification_case', rows[0].id, { supplier_org_id: supplierOrgId });
    await this.notify.notifyOrg(supplierOrgId, 'VERIFICATION_OPENED', { case_id: rows[0].id });
    return this.getCase(rows[0].id);
  }

  async list() {
    // RLS returns buyer's cases (for a buyer) or supplier's cases (for a supplier).
    return this.rc.manager.query(
      `SELECT c.*, ob.legal_name AS buyer_name, os.legal_name AS supplier_name,
              (SELECT count(*)::int FROM supplier_verification_documents d WHERE d.case_id = c.id) AS doc_count
       FROM supplier_verification_cases c
       JOIN organizations ob ON ob.id = c.buyer_org_id
       JOIN organizations os ON os.id = c.supplier_org_id
       ORDER BY c.created_at DESC LIMIT 200`,
    );
  }

  async getCase(id: string) {
    const c = (await this.rc.manager.query(`SELECT * FROM supplier_verification_cases WHERE id = $1`, [id]))[0];
    if (!c) throw new NotFoundException('Case not found');
    const documents = await this.rc.manager.query(
      `SELECT id, doc_type, filename, mime, size_bytes, sha256, status, av_status, created_at
       FROM supplier_verification_documents WHERE case_id = $1 ORDER BY created_at`,
      [id],
    );
    return { ...c, documents };
  }

  // Supplier uploads a compliance document to their case.
  async presign(auth: AccessTokenPayload, filename: string, mime: string) {
    return this.docs.presign(auth.org_id, filename, mime);
  }

  async confirmDoc(
    caseId: string,
    dto: { docType: string; storageKey: string; filename: string; mime: string; sizeBytes: number; sha256: string },
    auth: AccessTokenPayload,
  ) {
    const m = this.rc.manager;
    const c = (await m.query(`SELECT buyer_org_id, supplier_org_id FROM supplier_verification_cases WHERE id = $1`, [caseId]))[0];
    if (!c) throw new NotFoundException('Case not found');
    if (c.supplier_org_id !== auth.org_id) throw new BadRequestException('Not your case');
    const avStatus = this.docs.uploadAvStatus();
    const rows = await m.query(
      `INSERT INTO supplier_verification_documents(
         case_id, buyer_org_id, supplier_org_id, doc_type, storage_key, filename, mime, size_bytes, sha256, av_status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        caseId, c.buyer_org_id, auth.org_id, dto.docType, dto.storageKey, dto.filename,
        dto.mime, dto.sizeBytes, dto.sha256, avStatus,
      ],
    );
    await this.audit.record('VERIFICATION_DOC_UPLOADED', 'verification_document', rows[0].id, { case_id: caseId, doc_type: dto.docType });
    await this.notify.notifyOrg(c.buyer_org_id, 'VERIFICATION_DOC_UPLOADED', { case_id: caseId, doc_type: dto.docType });
    if (avStatus === 'PENDING') this.docs.requestAvScan();
    return this.getCase(caseId);
  }

  async docDownload(docId: string) {
    const rows = await this.rc.manager.query(
      `SELECT storage_key, av_status FROM supplier_verification_documents WHERE id = $1`,
      [docId],
    );
    if (!rows.length) return { url: null };
    return { url: await this.docs.signedGetUrl(rows[0].storage_key, rows[0].av_status) };
  }

  // Buyer decides the case; APPROVED promotes the supplier in the registry.
  async decide(caseId: string, status: VerificationStatus, notes: string | undefined, auth: AccessTokenPayload) {
    const m = this.rc.manager;
    if (status !== 'APPROVED' && status !== 'REJECTED') throw new BadRequestException('status must be APPROVED or REJECTED');
    // Fetch the party first (a SELECT is a reliable read; UPDATE…RETURNING in TypeORM
    // yields [rows, count], so reading a column off it is not safe).
    const c = (await m.query(`SELECT supplier_org_id FROM supplier_verification_cases WHERE id = $1`, [caseId]))[0];
    if (!c) throw new NotFoundException('Case not found');
    await m.query(
      `UPDATE supplier_verification_cases SET status=$2, review_notes=$3, reviewed_by=$4, reviewed_at=now() WHERE id=$1`,
      [caseId, status, notes ?? null, auth.sub],
    );
    if (status === 'APPROVED') {
      await m.query(
        `INSERT INTO supplier_relationships(buyer_org_id, supplier_org_id, status)
         VALUES ($1,$2,'APPROVED')
         ON CONFLICT (buyer_org_id, supplier_org_id) DO UPDATE SET status='APPROVED', updated_at=now()`,
        [auth.org_id, c.supplier_org_id],
      );
    }
    await this.audit.record('VERIFICATION_DECIDED', 'verification_case', caseId, { status });
    await this.notify.notifyOrg(c.supplier_org_id, 'VERIFICATION_DECIDED', { case_id: caseId, status });
    return this.getCase(caseId);
  }
}

class OpenCaseDto {
  @IsUUID() supplierOrgId!: string;
}
class DecideDto {
  @IsIn(VERIFICATION_STATUSES) status!: VerificationStatus;
  @IsOptional() @IsString() notes?: string;
}
class VerifyPresignDto {
  @IsString() @MinLength(1) filename!: string;
  @IsString() @MinLength(1) mime!: string;
}
class ConfirmDocDto {
  @IsString() @MinLength(1) docType!: string;
  @IsString() @MinLength(1) storageKey!: string;
  @IsString() @MinLength(1) filename!: string;
  @IsString() @MinLength(1) mime!: string;
  @IsInt() @Min(0) sizeBytes!: number;
  @IsString() sha256!: string;
}

@Controller('verification')
@RequiresFeature('suppliers.verification')
export class VerificationController {
  constructor(private readonly verification: VerificationService) {}

  @Get('cases')
  list() {
    return this.verification.list();
  }

  @Get('cases/:id')
  getCase(@Param('id') id: string) {
    return this.verification.getCase(id);
  }

  @Post('cases')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  open(@Body() body: OpenCaseDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.verification.openCase(body.supplierOrgId, auth);
  }

  @Post('cases/:id/decide')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  decide(@Param('id') id: string, @Body() body: DecideDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.verification.decide(id, body.status, body.notes, auth);
  }

  @Post('presign')
  @Roles('SUPPLIER_USER')
  presign(@CurrentUser() auth: AccessTokenPayload, @Body() body: VerifyPresignDto) {
    return this.verification.presign(auth, body.filename, body.mime);
  }

  @Post('cases/:id/documents')
  @Roles('SUPPLIER_USER')
  confirmDoc(@Param('id') id: string, @Body() body: ConfirmDocDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.verification.confirmDoc(id, body, auth);
  }

  @Get('documents/:docId/download')
  download(@Param('docId') docId: string) {
    return this.verification.docDownload(docId);
  }
}

@Module({ controllers: [VerificationController], providers: [VerificationService] })
export class VerificationModule {}
