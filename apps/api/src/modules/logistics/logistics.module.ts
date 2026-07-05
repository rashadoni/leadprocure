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
    const ship = await m.query(`SELECT id, supplier_org_id, buyer_org_id FROM shipments WHERE po_id = $1`, [poId]);
    if (!ship.length) throw new NotFoundException('No shipment for this order');
    if (ship[0].supplier_org_id !== auth.org_id) throw new BadRequestException('Only the supplier updates tracking');

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
    const ship = await m.query(`SELECT * FROM shipments WHERE po_id = $1`, [poId]);
    if (!ship.length) return { shipment: null, events: [] };
    const events = await m.query(
      `SELECT status, location, note, occurred_at FROM shipment_events WHERE shipment_id=$1 ORDER BY occurred_at`,
      [ship[0].id],
    );
    return { shipment: ship[0], events };
  }

  // All in-flight shipments for the acting org (buyer or supplier).
  async board() {
    return this.rc.manager.query(
      `SELECT s.*, p.po_no, ob.legal_name AS buyer_name, os.legal_name AS supplier_name
       FROM shipments s
       JOIN purchase_orders p ON p.id = s.po_id
       JOIN organizations ob ON ob.id = s.buyer_org_id
       JOIN organizations os ON os.id = s.supplier_org_id
       ORDER BY s.updated_at DESC`,
    );
  }
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
  create(@Param('poId') poId: string, @Body() body: any, @CurrentUser() auth: AccessTokenPayload) {
    return this.logistics.createForPo(poId, body, auth);
  }

  @Post('po/:poId/events')
  @Roles('SUPPLIER_USER')
  addEvent(@Param('poId') poId: string, @Body() body: any, @CurrentUser() auth: AccessTokenPayload) {
    return this.logistics.addEvent(poId, body, auth);
  }
}

@Module({ controllers: [LogisticsController], providers: [LogisticsService] })
export class LogisticsModule {}
