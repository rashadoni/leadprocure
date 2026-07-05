import { Body, Controller, Get, Injectable, Logger, Module, Param, Post, Put } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { CurrentUser, RequiresFeature, Roles } from '../../common/auth/decorators';
import type { AccessTokenPayload } from '@leadprocure/shared';
import { SourcingService } from './sourcing.service';
import { AuctionService, QnaService } from './auction.service';

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

  @Post(':id/lots')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  addLot(@Param('id') id: string, @Body() body: { title: string }) {
    return this.sourcing.addLot(id, body.title);
  }

  @Put(':id/items/:itemId/lot')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  assignLot(@Param('id') id: string, @Param('itemId') itemId: string, @Body() body: { lotId: string }) {
    return this.sourcing.assignItemToLot(id, itemId, body.lotId);
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

  @Get(':id/ai-recommendation')
  @RequiresFeature('ai.scoring')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER')
  aiRecommendation(@Param('id') id: string, @CurrentUser() auth: AccessTokenPayload) {
    return this.sourcing.aiRecommendation(id, auth);
  }
}

@Controller('events')
@RequiresFeature('sourcing.reverse_auction')
export class AuctionController {
  constructor(private readonly auction: AuctionService) {}

  @Post('reverse/from-request/:requestId')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  create(
    @Param('requestId') requestId: string,
    @Body() body: { title?: string; closeAt: string; visibility?: 'PUBLIC' | 'INVITED';
                    startPriceMinor: number; minDecrementMinor: number; qnaCutoffAt?: string },
    @CurrentUser() auth: AccessTokenPayload,
  ) {
    return this.auction.createFromRequest(requestId, body, auth);
  }

  @Get(':id/auction/state')
  state(@Param('id') id: string, @CurrentUser() auth: AccessTokenPayload) {
    return this.auction.state(id, auth);
  }

  @Post(':id/auction/bids')
  @Roles('SUPPLIER_USER')
  bid(
    @Param('id') id: string,
    @Body() body: { items: Array<{ eventItemId: string; unitPriceMinor: number }>; idempotencyKey?: string },
    @CurrentUser() auth: AccessTokenPayload,
  ) {
    return this.auction.placeBid(id, body, auth);
  }

  @Post(':id/auction/finalize')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  finalize(@Param('id') id: string, @CurrentUser() auth: AccessTokenPayload) {
    return this.auction.finalize(id, auth);
  }
}

@Controller('events')
export class QnaController {
  constructor(private readonly qna: QnaService) {}

  @Get(':id/qna')
  list(@Param('id') id: string) {
    return this.qna.list(id);
  }

  @Post(':id/qna')
  @Roles('SUPPLIER_USER')
  ask(@Param('id') id: string, @Body() body: { question: string }, @CurrentUser() auth: AccessTokenPayload) {
    return this.qna.ask(id, body.question, auth);
  }

  @Post(':id/qna/:qnaId/answer')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  answer(
    @Param('id') id: string,
    @Param('qnaId') qnaId: string,
    @Body() body: { answer: string },
    @CurrentUser() auth: AccessTokenPayload,
  ) {
    return this.qna.answer(id, qnaId, body.answer, auth);
  }

  @Post(':id/addenda')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  addendum(@Param('id') id: string, @Body() body: { text: string }, @CurrentUser() auth: AccessTokenPayload) {
    return this.qna.addendum(id, body.text, auth);
  }
}

@Module({
  controllers: [SourcingController, AuctionController, QnaController],
  providers: [SourcingService, SourcingScheduler, AuctionService, QnaService],
})
export class SourcingModule {}
