import { returnedRows } from '../../common/procurement/invariants';
import {
  Body, ConflictException, Controller, Delete, Get, Injectable, Module, NotFoundException, Param, Post,
} from '@nestjs/common';
import { IsOptional, IsString, Matches, MinLength } from 'class-validator';
import type { AccessTokenPayload } from '@leadprocure/shared';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { RequestContextService } from '../../common/context/request-context.service';
import { AuditService } from '../../common/audit/audit.service';

// Curated per-buyer procurement categories. All queries run under the buyer's RLS context.
@Injectable()
export class CategoriesService {
  constructor(private readonly rc: RequestContextService, private readonly audit: AuditService) {}

  list() {
    return this.rc.manager.query(
      `SELECT id, code, name, created_at FROM procurement_categories ORDER BY code`,
    );
  }

  async create(dto: UpsertCategoryDto, auth: AccessTokenPayload) {
    const code = dto.code.trim();
    try {
      const row = (
        await this.rc.manager.query(
          `INSERT INTO procurement_categories(buyer_org_id, code, name) VALUES ($1,$2,$3) RETURNING id, code, name, created_at`,
          [auth.org_id, code, dto.name?.trim() || null],
        )
      )[0];
      await this.audit.record('CATEGORY_CREATED', 'category', row.id, { code });
      return row;
    } catch (e: any) {
      if (e?.code === '23505') throw new ConflictException(`Category "${code}" already exists`);
      throw e;
    }
  }

  async remove(id: string, auth: AccessTokenPayload) {
    const res = returnedRows(await this.rc.manager.query(`DELETE FROM procurement_categories WHERE id=$1 RETURNING code`, [id]));
    if (!res[0]) throw new NotFoundException('Category not found');
    await this.audit.record('CATEGORY_DELETED', 'category', id, { code: res[0].code, by_org: auth.org_id });
    return { ok: true };
  }
}

class UpsertCategoryDto {
  // A short, stable code (letters/digits/-/_) — this is what requests/policies/budgets store.
  // \w is ASCII-only, so "MƏRKƏZ" and "TƏCHİZAT" were rejected — unusable codes in the one
  // language this product ships in. Unicode letters and digits are allowed; spaces and
  // punctuation still are not, because the code is a short stable key, not a title.
  @IsString() @MinLength(1)
  @Matches(/^[\p{L}\p{N}_-]{1,40}$/u, { message: 'code: 1–40 chars, letters/digits/-/_' })
  code!: string;
  @IsOptional() @IsString() name?: string;
}

@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER', 'BUYER_FINANCE')
  list() {
    return this.categories.list();
  }

  @Post()
  @Roles('BUYER_ADMIN')
  create(@Body() dto: UpsertCategoryDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.categories.create(dto, auth);
  }

  @Delete(':id')
  @Roles('BUYER_ADMIN')
  remove(@Param('id') id: string, @CurrentUser() auth: AccessTokenPayload) {
    return this.categories.remove(id, auth);
  }
}

@Module({ controllers: [CategoriesController], providers: [CategoriesService] })
export class CategoriesModule {}
