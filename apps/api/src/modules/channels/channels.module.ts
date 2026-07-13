import {
  BadRequestException, Body, Controller, Delete, Get, Injectable, Module, Param, Post, Put,
} from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import * as nodemailer from 'nodemailer';
import type { AccessTokenPayload } from '@leadprocure/shared';
import { CurrentUser, RequiresFeature, Roles } from '../../common/auth/decorators';
import { RequestContextService } from '../../common/context/request-context.service';
import { AuditService } from '../../common/audit/audit.service';

// Secret fields per channel — never returned to the client (masked to a boolean), and
// preserved on update when the client submits an empty value (i.e. "keep existing").
const SECRET_KEYS: Record<string, string[]> = {
  EMAIL: ['password'],
  WHATSAPP: ['token'],
};

class EmailConfigDto {
  @IsString() host!: string;
  @IsInt() @Min(1) @Max(65535) port!: number;
  @IsOptional() @IsString() user?: string;
  @IsOptional() @IsString() password?: string; // omit/empty = keep existing
  @IsString() from!: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
class WhatsappConfigDto {
  @IsString() apiUrl!: string;
  @IsOptional() @IsString() token?: string; // omit/empty = keep existing
  @IsString() from!: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
class TestDto {
  @IsString() to!: string; // email address or phone number
}

// Reusable senders so the follow-up ticker and the "send test" button share one path.
export async function sendEmailVia(cfg: any, to: string, subject: string, text: string): Promise<void> {
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: Number(cfg.port),
    secure: Number(cfg.port) === 465,
    auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
  });
  await transport.sendMail({ from: cfg.from, to, subject, text, html: `<pre>${text}</pre>` });
}
export async function sendWhatsappVia(cfg: any, to: string, text: string): Promise<void> {
  const res = await fetch(cfg.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token ?? ''}` },
    body: JSON.stringify({ from: cfg.from, to, body: text }),
  });
  if (!res.ok) throw new Error(`WhatsApp gateway ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

@Injectable()
export class ChannelsService {
  constructor(
    private readonly rc: RequestContextService,
    private readonly audit: AuditService,
  ) {}

  // Both channels always listed (connected or not) so the UI shows two cards; secrets
  // are replaced by has<Field> booleans so a saved password/token is never shipped back.
  async list(auth: AccessTokenPayload) {
    const rows: Array<{ channel: string; config: any; is_active: boolean; last_test_at: string | null }> =
      await this.rc.manager.query(
        `SELECT channel, config, is_active, last_test_at FROM channel_connections WHERE buyer_org_id = $1`,
        [auth.org_id],
      );
    const byChannel = new Map(rows.map((r) => [r.channel, r]));
    return (['EMAIL', 'WHATSAPP'] as const).map((channel) => {
      const row = byChannel.get(channel);
      const cfg = row?.config ?? {};
      const masked: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(cfg)) {
        if (SECRET_KEYS[channel].includes(k)) masked[`has_${k}`] = Boolean(v);
        else masked[k] = v;
      }
      return {
        channel,
        connected: Boolean(row),
        isActive: row?.is_active ?? false,
        lastTestAt: row?.last_test_at ?? null,
        config: masked,
      };
    });
  }

  private async currentConfig(channel: string, auth: AccessTokenPayload) {
    const rows = await this.rc.manager.query(
      `SELECT config FROM channel_connections WHERE buyer_org_id = $1 AND channel = $2`,
      [auth.org_id, channel],
    );
    return (rows[0]?.config ?? {}) as Record<string, unknown>;
  }

  async save(channel: string, dto: EmailConfigDto | WhatsappConfigDto, auth: AccessTokenPayload) {
    const existing = await this.currentConfig(channel, auth);
    const { isActive, ...incoming } = dto as any;
    const config: Record<string, unknown> = { ...existing, ...incoming };
    // blank secret = keep the stored one (so the UI never has to re-enter it)
    for (const key of SECRET_KEYS[channel]) {
      if (incoming[key] == null || incoming[key] === '') config[key] = existing[key] ?? '';
    }
    await this.rc.manager.query(
      `INSERT INTO channel_connections(buyer_org_id, channel, config, is_active)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (buyer_org_id, channel)
       DO UPDATE SET config = $3, is_active = $4, updated_at = now()`,
      [auth.org_id, channel, JSON.stringify(config), isActive ?? true],
    );
    await this.audit.record('CHANNEL_SAVED', 'channel_connection', channel, { channel });
    return this.list(auth);
  }

  async remove(channel: string, auth: AccessTokenPayload) {
    await this.rc.manager.query(
      `DELETE FROM channel_connections WHERE buyer_org_id = $1 AND channel = $2`,
      [auth.org_id, channel],
    );
    await this.audit.record('CHANNEL_REMOVED', 'channel_connection', channel, { channel });
    return this.list(auth);
  }

  // Uses the STORED config (secrets included) so the buyer can verify a connection
  // without re-typing credentials. A failure surfaces the gateway/SMTP error verbatim.
  async test(channel: string, dto: TestDto, auth: AccessTokenPayload) {
    const cfg = await this.currentConfig(channel, auth);
    if (!cfg || !Object.keys(cfg).length) throw new BadRequestException('Channel is not configured yet');
    const text = 'Leadprocure — test message · sınaq mesajı · тестовое сообщение';
    try {
      if (channel === 'EMAIL') await sendEmailVia(cfg, dto.to, 'Leadprocure — test', text);
      else await sendWhatsappVia(cfg, dto.to, text);
    } catch (e: any) {
      throw new BadRequestException(`Test send failed: ${e?.message?.slice(0, 300) ?? 'unknown error'}`);
    }
    await this.rc.manager.query(
      `UPDATE channel_connections SET last_test_at = now() WHERE buyer_org_id = $1 AND channel = $2`,
      [auth.org_id, channel],
    );
    await this.audit.record('CHANNEL_TEST_SENT', 'channel_connection', channel, { channel, to: dto.to });
    return { ok: true };
  }
}

@Controller('channels')
@RequiresFeature('outreach.followups')
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER')
  list(@CurrentUser() auth: AccessTokenPayload) {
    return this.channels.list(auth);
  }

  @Put('EMAIL')
  @Roles('BUYER_ADMIN')
  saveEmail(@Body() dto: EmailConfigDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.channels.save('EMAIL', dto, auth);
  }

  @Put('WHATSAPP')
  @Roles('BUYER_ADMIN')
  saveWhatsapp(@Body() dto: WhatsappConfigDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.channels.save('WHATSAPP', dto, auth);
  }

  @Post(':channel/test')
  @Roles('BUYER_ADMIN')
  test(@Param('channel') channel: string, @Body() dto: TestDto, @CurrentUser() auth: AccessTokenPayload) {
    if (!['EMAIL', 'WHATSAPP'].includes(channel)) throw new BadRequestException('Unknown channel');
    return this.channels.test(channel, dto, auth);
  }

  @Delete(':channel')
  @Roles('BUYER_ADMIN')
  remove(@Param('channel') channel: string, @CurrentUser() auth: AccessTokenPayload) {
    if (!['EMAIL', 'WHATSAPP'].includes(channel)) throw new BadRequestException('Unknown channel');
    return this.channels.remove(channel, auth);
  }
}

@Module({
  providers: [ChannelsService],
  controllers: [ChannelsController],
  exports: [ChannelsService],
})
export class ChannelsModule {}
