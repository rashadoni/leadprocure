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
import type { AccessTokenPayload, ShipmentStatus } from '@leadprocure/shared';
import { SHIPMENT_STATUSES } from '@leadprocure/shared';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { RequestContextService } from '../../common/context/request-context.service';
import { AuditService } from '../../common/audit/audit.service';

// A logistics milestone drives the coarse PO status to a target. The PO state machine
// (po_apply_status) only allows one legal step at a time, so we WALK the supplier chain
// toward the target, each step in a savepoint so an inapplicable step is a no-op rather
// than poisoning the request transaction.
const PO_TARGET: Partial<Record<ShipmentStatus, string>> = {
  PICKED_UP: 'SHIPPED',
  IN_TRANSIT: 'SHIPPED',
  DELIVERED: 'DELIVERED',
};
const SUPPLIER_PO_CHAIN = ['CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED'];
// Delivery progress only runs one way. The timeline is the supplier's own claim and the
// buyer's board reads it, so letting it slide back turned a delivered order into one in
// transit — two clicks apart in the dropdown, and flatly contradicting a purchase order
// already at DELIVERED or ACCEPTED. EXCEPTION is deliberately outside the order: it is
// how a shipment says something went wrong, and it stays available at every point.
const SHIPMENT_PROGRESS = ['CREATED', 'PICKED_UP', 'IN_TRANSIT', 'CUSTOMS', 'ARRIVED', 'DELIVERED'];
const progressOf = (status: string) => SHIPMENT_PROGRESS.indexOf(status);

@Injectable()
export class LogisticsService {
  constructor(
    private readonly rc: RequestContextService,
    private readonly audit: AuditService,
  ) {}

  async createForPo(
    poId: string,
    dto: { carrier?: string; trackingNo?: string; origin?: string; destination?: string; eta?: string },
    auth: AccessTokenPayload,
  ) {
    const m = this.rc.manager;
    // RLS shows the PO to this supplier only if they own it.
    const po = await m.query(`SELECT id, buyer_org_id, supplier_org_id FROM purchase_orders WHERE id = $1`, [poId]);
    if (!po.length) throw new NotFoundException('Order not found');
    if (po[0].supplier_org_id !== auth.org_id) throw new BadRequestException('Only the awarded supplier ships this order');

    const rows = await m.query(
      `INSERT INTO shipments(po_id, buyer_org_id, supplier_org_id, carrier, tracking_no, origin, destination, eta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (po_id) DO UPDATE SET carrier=$4, tracking_no=$5, origin=$6, destination=$7, eta=$8, updated_at=now()
       RETURNING id`,
      [poId, po[0].buyer_org_id, po[0].supplier_org_id, dto.carrier ?? null, dto.trackingNo ?? null,
       dto.origin ?? null, dto.destination ?? null, dto.eta ?? null],
    );
    await this.audit.record('SHIPMENT_CREATED', 'shipment', rows[0].id, { po_id: poId, carrier: dto.carrier });
    return this.get(poId);
  }

  async addEvent(
    poId: string,
    dto: { status: ShipmentStatus; location?: string; note?: string },
    auth: AccessTokenPayload,
  ) {
    const m = this.rc.manager;
    const ship = await m.query(
      `SELECT id, supplier_org_id, buyer_org_id, status FROM shipments WHERE po_id = $1`,
      [poId],
    );
    if (!ship.length) throw new NotFoundException('No shipment for this order');
    if (ship[0].supplier_org_id !== auth.org_id) throw new BadRequestException('Only the supplier updates tracking');

    // Once the buyer has accepted the goods the delivery is settled; rewriting the
    // timeline after that only makes the two screens disagree.
    const po = (await m.query(`SELECT status FROM purchase_orders WHERE id = $1`, [poId]))[0];
    if (po?.status === 'ACCEPTED') {
      throw new BadRequestException('The buyer has accepted this delivery; its tracking is closed');
    }
    if (dto.status !== 'EXCEPTION' && progressOf(dto.status) < progressOf(ship[0].status)) {
      throw new BadRequestException(
        `Delivery is already at ${ship[0].status}; record EXCEPTION to report a problem instead of moving it back to ${dto.status}`,
      );
    }

    await m.query(
      `INSERT INTO shipment_events(shipment_id, buyer_org_id, supplier_org_id, status, location, note)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [ship[0].id, ship[0].buyer_org_id, ship[0].supplier_org_id, dto.status, dto.location ?? null, dto.note ?? null],
    );
    await m.query(`UPDATE shipments SET status=$2, updated_at=now() WHERE id=$1`, [ship[0].id, dto.status]);

    const target = PO_TARGET[dto.status];
    if (target) await this.advancePoTo(poId, target);
    await this.audit.record('SHIPMENT_EVENT_ADDED', 'shipment', ship[0].id, { po_id: poId, status: dto.status });
    return this.get(poId);
  }

  // Best-effort: step the PO forward through its legal supplier chain up to `target`.
  private async advancePoTo(poId: string, target: string): Promise<void> {
    const m = this.rc.manager;
    const targetIdx = SUPPLIER_PO_CHAIN.indexOf(target);
    for (let i = 1; i < SUPPLIER_PO_CHAIN.length && i <= targetIdx; i++) {
      const step = SUPPLIER_PO_CHAIN[i];
      await m.query(`SAVEPOINT po_step`);
      try {
        await m.query(`SELECT po_apply_status($1, $2::po_status, 'via logistics')`, [poId, step]);
        await m.query(`RELEASE SAVEPOINT po_step`);
      } catch {
        await m.query(`ROLLBACK TO SAVEPOINT po_step`); // step not currently legal — skip
      }
    }
  }

  async get(poId: string) {
    const m = this.rc.manager;
    // The order's own status travels with the timeline. Walking the PO forward is
    // best-effort by design — a milestone on an order the supplier never confirmed moves
    // nothing — and without this the two screens simply disagreed in silence.
    const po = (await m.query(`SELECT status FROM purchase_orders WHERE id = $1`, [poId]))[0];
    const ship = await m.query(`SELECT * FROM shipments WHERE po_id = $1`, [poId]);
    if (!ship.length) return { shipment: null, events: [], poStatus: po?.status ?? null };
    const events = await m.query(
      `SELECT status, location, note, occurred_at FROM shipment_events WHERE shipment_id=$1 ORDER BY occurred_at`,
      [ship[0].id],
    );
    return { shipment: ship[0], events, poStatus: po?.status ?? null };
  }

  // All in-flight shipments for the acting org (buyer or supplier).
  async board() {
    return this.rc.manager.query(
      `SELECT s.*, p.po_no, p.status AS po_status, ob.legal_name AS buyer_name, os.legal_name AS supplier_name
       FROM shipments s
       JOIN purchase_orders p ON p.id = s.po_id
       JOIN organizations ob ON ob.id = s.buyer_org_id
       JOIN organizations os ON os.id = s.supplier_org_id
       ORDER BY s.updated_at DESC LIMIT 200`,
    );
  }
}

class CreateShipmentDto {
  @IsOptional() @IsString() carrier?: string;
  @IsOptional() @IsString() trackingNo?: string;
  @IsOptional() @IsString() origin?: string;
  @IsOptional() @IsString() destination?: string;
  @IsOptional() @IsString() eta?: string;
}
class ShipmentEventDto {
  @IsIn(SHIPMENT_STATUSES) status!: ShipmentStatus;
  @IsOptional() @IsString() location?: string;
  @IsOptional() @IsString() note?: string;
}

@Controller('logistics')
export class LogisticsController {
  constructor(private readonly logistics: LogisticsService) {}

  @Get()
  board() {
    return this.logistics.board();
  }

  @Get('po/:poId')
  get(@Param('poId') poId: string) {
    return this.logistics.get(poId);
  }

  @Post('po/:poId/shipment')
  @Roles('SUPPLIER_USER')
  create(@Param('poId') poId: string, @Body() body: CreateShipmentDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.logistics.createForPo(poId, body, auth);
  }

  @Post('po/:poId/events')
  @Roles('SUPPLIER_USER')
  addEvent(@Param('poId') poId: string, @Body() body: ShipmentEventDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.logistics.addEvent(poId, body, auth);
  }
}

@Module({ controllers: [LogisticsController], providers: [LogisticsService] })
export class LogisticsModule {}
