import { Body, Controller, Get, Injectable, Logger, Module, Param, Post } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { CurrentUser, RequiresFeature, Roles } from '../../common/auth/decorators';
import type { AccessTokenPayload } from '@leadprocure/shared';
import { SourcingService } from './sourcing.service';

// Deadline scheduler. Runs with no request context, so it goes through the
// SECURITY DEFINER close_due_events() seam instead of RLS-scoped queries.
@Injectable()
export class SourcingScheduler {
  private readonly logger = new Logger(SourcingScheduler.name);
  constructor(
    private readonly ds: DataSource,
    private readonly emitter: EventEmitter2,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async closeDueEvents(): Promise<void> {
    const closed: Array<{ event_id: string }> = await this.ds.query(`SELECT * FROM close_due_events()`);
    for (const row of closed) {
      this.logger.log(`Event ${row.event_id} closed by deadline`);
      this.emitter.emit('rt.emit', {
        room: `event:${row.event_id}`,
        event: 'event.status',
        data: { status: 'CLOSED' },
      });
    }
  }
}

@Controller('events')
@RequiresFeature('sourcing.rfq')
export class SourcingController {
  constructor(private readonly sourcing: SourcingService) {}

  @Get()
  list(@CurrentUser() auth: AccessTokenPayload) {
    return this.sourcing.list(auth);
  }

  @Get(':id')
  detail(@Param('id') id: string, @CurrentUser() auth: AccessTokenPayload) {
    return this.sourcing.detail(id, auth);
  }

  @Post('from-request/:requestId')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  create(
    @Param('requestId') requestId: string,
    @Body() body: { title?: string; closeAt: string; visibility?: 'PUBLIC' | 'INVITED' },
    @CurrentUser() auth: AccessTokenPayload,
  ) {
    return this.sourcing.createFromRequest(requestId, body, auth);
  }

  @Post(':id/publish')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  publish(@Param('id') id: string, @CurrentUser() auth: AccessTokenPayload) {
    return this.sourcing.publish(id, auth);
  }

  @Post(':id/invite')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  invite(@Param('id') id: string, @Body() body: { supplierOrgId: string }) {
    return this.sourcing.invite(id, body.supplierOrgId);
  }

  @Post(':id/bid')
  @Roles('SUPPLIER_USER')
  bid(
    @Param('id') id: string,
    @Body() body: { items: Array<{ eventItemId: string; unitPriceMinor: number }>; currency?: string; deliveryDays?: number },
    @CurrentUser() auth: AccessTokenPayload,
  ) {
    return this.sourcing.submitBid(id, body, auth);
  }

  @Post(':id/withdraw')
  @Roles('SUPPLIER_USER')
  withdraw(@Param('id') id: string, @CurrentUser() auth: AccessTokenPayload) {
    return this.sourcing.withdrawBid(id, auth);
  }

  @Post(':id/open')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  open(@Param('id') id: string, @CurrentUser() auth: AccessTokenPayload) {
    return this.sourcing.openCeremony(id, auth);
  }

  @Post(':id/evaluate')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  evaluate(
    @Param('id') id: string,
    @Body() body: { criteria: Array<{ key: string; weight: number }>; scores: Array<{ bidId: string; key: string; score: number }> },
    @CurrentUser() auth: AccessTokenPayload,
  ) {
    return this.sourcing.evaluate(id, body, auth);
  }

  @Post(':id/award')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  award(
    @Param('id') id: string,
    @Body() body: { lotId: string; bidId: string },
    @CurrentUser() auth: AccessTokenPayload,
  ) {
    return this.sourcing.award(id, body, auth);
  }

  @Get(':id/ocds')
  @RequiresFeature('compliance.ocds_export')
  ocds(@Param('id') id: string, @CurrentUser() auth: AccessTokenPayload) {
    return this.sourcing.ocdsRelease(id, auth);
  }
}

@Module({
  controllers: [SourcingController],
  providers: [SourcingService, SourcingScheduler],
})
export class SourcingModule {}
