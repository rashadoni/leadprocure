import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Global,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { PutObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AccessTokenPayload } from '@leadprocure/shared';
import { RequestContextService } from '../context/request-context.service';
import { AuditService } from '../audit/audit.service';
import { AppConfig } from '../config/config.service';

// Attachments via S3-compatible storage (MinIO locally). Flow:
//   1) POST /documents/presign → client PUTs the file straight to storage
//   2) POST /documents/confirm → row with sha256/mime/size; AV status recorded
// ClamAV scanning is stubbed behind CLAMAV_ENABLED (SKIPPED when off) — the column
// and seam exist so a real scanner slots in without schema changes.
@Injectable()
export class DocumentsService {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(
    private readonly rc: RequestContextService,
    private readonly audit: AuditService,
    private readonly cfg: AppConfig,
  ) {
    this.bucket = process.env.S3_BUCKET ?? 'leadprocure';
    this.s3 = new S3Client({
      endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
      region: process.env.S3_REGION ?? 'us-east-1',
      forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY ?? 'minioadmin',
        secretAccessKey: process.env.S3_SECRET_KEY ?? 'minioadmin',
      },
    });
  }

  async presign(orgId: string, filename: string, mime: string) {
    const storageKey = `${orgId}/${randomUUID()}/${filename.replace(/[^\w.\-]/g, '_')}`;
    const url = await getSignedUrl(
      this.s3,
      new PutObjectCommand({ Bucket: this.bucket, Key: storageKey, ContentType: mime }),
      { expiresIn: 900 },
    );
    return { uploadUrl: url, storageKey };
  }

  async confirm(
    auth: AccessTokenPayload,
    dto: { storageKey: string; filename: string; mime: string; sizeBytes: number; sha256: string; entityType: string; entityId?: string },
  ) {
    const avStatus = this.cfg.clamavEnabled ? 'PENDING' : 'SKIPPED';
    const rows = await this.rc.manager.query(
      `INSERT INTO documents(owner_org_id, entity_type, entity_id, storage_key, filename, mime, size_bytes, sha256, av_status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        auth.org_id, dto.entityType, dto.entityId ?? null, dto.storageKey, dto.filename,
        dto.mime, dto.sizeBytes, dto.sha256, avStatus, auth.sub,
      ],
    );
    await this.audit.record('DOCUMENT_UPLOADED', 'document', rows[0].id, {
      sha256: dto.sha256, entity_type: dto.entityType, entity_id: dto.entityId ?? null,
    });
    return { id: rows[0].id, avStatus };
  }

  async list(entityType?: string, entityId?: string) {
    if (entityType && entityId) {
      return this.rc.manager.query(
        `SELECT id, entity_type, entity_id, filename, mime, size_bytes, sha256, av_status, version, created_at
         FROM documents WHERE entity_type=$1 AND entity_id=$2 ORDER BY created_at DESC`,
        [entityType, entityId],
      );
    }
    return this.rc.manager.query(
      `SELECT id, entity_type, entity_id, filename, mime, size_bytes, sha256, av_status, version, created_at
       FROM documents ORDER BY created_at DESC LIMIT 100`,
    );
  }

  async downloadUrl(id: string) {
    const rows = await this.rc.manager.query(`SELECT storage_key FROM documents WHERE id=$1`, [id]);
    if (!rows.length) return { url: null };
    const url = await getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: rows[0].storage_key }),
      { expiresIn: 900 },
    );
    return { url };
  }

  // ---- Bid attachments (cross-org; supplier writes, buyer reads after opening) ----

  async confirmBidDoc(
    auth: AccessTokenPayload,
    bidId: string,
    dto: { storageKey: string; filename: string; mime: string; sizeBytes: number; sha256: string },
  ) {
    const m = this.rc.manager;
    // RLS: a supplier only sees their own bid, so this both fetches parties and authorizes.
    const bid = (
      await m.query(
        `SELECT b.supplier_org_id, e.buyer_org_id FROM bids b
         JOIN sourcing_events e ON e.id = b.event_id WHERE b.id = $1`,
        [bidId],
      )
    )[0];
    if (!bid) throw new NotFoundException('Bid not found');
    if (bid.supplier_org_id !== auth.org_id) throw new BadRequestException('Not your bid');
    const avStatus = this.cfg.clamavEnabled ? 'PENDING' : 'SKIPPED';
    const rows = await m.query(
      `INSERT INTO bid_documents(bid_id, buyer_org_id, supplier_org_id, storage_key, filename, mime, size_bytes, sha256, av_status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [bidId, bid.buyer_org_id, auth.org_id, dto.storageKey, dto.filename, dto.mime, dto.sizeBytes, dto.sha256, avStatus, auth.sub],
    );
    await this.audit.record('DOCUMENT_UPLOADED', 'bid_document', rows[0].id, { bid_id: bidId, sha256: dto.sha256 });
    return { id: rows[0].id, avStatus };
  }

  async listBidDocs(bidId: string) {
    // RLS decides visibility (supplier own / buyer after opening).
    return this.rc.manager.query(
      `SELECT id, filename, mime, size_bytes, sha256, av_status, created_at
       FROM bid_documents WHERE bid_id = $1 ORDER BY created_at DESC`,
      [bidId],
    );
  }

  // Generic signed GET for any storage key (used by verification docs etc.).
  async signedGetUrl(storageKey: string) {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }), { expiresIn: 900 });
  }

  async bidDocDownloadUrl(id: string) {
    const rows = await this.rc.manager.query(`SELECT storage_key FROM bid_documents WHERE id=$1`, [id]);
    if (!rows.length) return { url: null };
    const url = await getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: rows[0].storage_key }),
      { expiresIn: 900 },
    );
    return { url };
  }
}

class PresignDocDto {
  @IsString() @MinLength(1) filename!: string;
  @IsString() @MinLength(1) mime!: string;
}
class ConfirmDocDto {
  @IsString() @MinLength(1) storageKey!: string;
  @IsString() @MinLength(1) filename!: string;
  @IsString() @MinLength(1) mime!: string;
  @IsInt() @Min(0) sizeBytes!: number;
  @IsString() sha256!: string;
  // entityType/entityId route where the doc attaches (entityType is required by the service).
  @IsString() @MinLength(1) entityType!: string;
  @IsOptional() @IsString() entityId?: string;
}
class ConfirmBidDocDto {
  @IsString() @MinLength(1) storageKey!: string;
  @IsString() @MinLength(1) filename!: string;
  @IsString() @MinLength(1) mime!: string;
  @IsInt() @Min(0) sizeBytes!: number;
  @IsString() sha256!: string;
}

@Controller('documents')
export class DocumentsController {
  constructor(private readonly docs: DocumentsService) {}

  @Post('presign')
  presign(@CurrentUser() auth: AccessTokenPayload, @Body() body: PresignDocDto) {
    return this.docs.presign(auth.org_id, body.filename, body.mime);
  }

  @Post('confirm')
  confirm(@CurrentUser() auth: AccessTokenPayload, @Body() body: ConfirmDocDto) {
    return this.docs.confirm(auth, body);
  }

  @Get()
  list(@Query('entityType') entityType?: string, @Query('entityId') entityId?: string) {
    return this.docs.list(entityType, entityId);
  }

  @Get(':id/download')
  download(@Param('id') id: string) {
    return this.docs.downloadUrl(id);
  }

  // ---- bid attachments ----
  @Post('bid/:bidId/presign')
  @Roles('SUPPLIER_USER')
  presignBid(@CurrentUser() auth: AccessTokenPayload, @Body() body: PresignDocDto) {
    return this.docs.presign(auth.org_id, body.filename, body.mime);
  }

  @Post('bid/:bidId/confirm')
  @Roles('SUPPLIER_USER')
  confirmBid(@CurrentUser() auth: AccessTokenPayload, @Param('bidId') bidId: string, @Body() body: ConfirmBidDocDto) {
    return this.docs.confirmBidDoc(auth, bidId, body);
  }

  @Get('bid/:bidId')
  listBid(@Param('bidId') bidId: string) {
    return this.docs.listBidDocs(bidId);
  }

  @Get('bid-doc/:id/download')
  downloadBid(@Param('id') id: string) {
    return this.docs.bidDocDownloadUrl(id);
  }
}

@Global()
@Module({ controllers: [DocumentsController], providers: [DocumentsService], exports: [DocumentsService] })
export class DocumentsModule {}
