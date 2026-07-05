import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { Roles } from '../../common/auth/decorators';
import { RequestContextService } from '../../common/context/request-context.service';

// Buyer KPIs — every query is RLS-scoped by the request context, so plain
// aggregates cannot leak across orgs by construction.
@Injectable()
export class DashboardService {
  constructor(private readonly rc: RequestContextService) {}

  async buyer() {
    const m = this.rc.manager;
    const one = async (sql: string) => Number((await m.query(sql))[0]?.v ?? 0);

    const [awardedSpend, savings, activeEvents, pendingApprovals, unreadNotifications, openPos] =
      await Promise.all([
        one(`SELECT COALESCE(SUM(b.total_minor),0)::bigint AS v
             FROM awards a JOIN bids b ON b.id = a.winning_bid_id`),
        one(`SELECT COALESCE(SUM(pr.estimated_total_minor - b.total_minor),0)::bigint AS v
             FROM sourcing_events e
             JOIN procurement_requests pr ON pr.id = e.request_id
             JOIN awards a ON a.event_id = e.id
             JOIN bids b ON b.id = a.winning_bid_id`),
        one(`SELECT count(*)::int AS v FROM sourcing_events
             WHERE status IN ('OPEN','CLOSED','OPENING','EVALUATION')`),
        one(`SELECT count(*)::int AS v FROM procurement_requests WHERE status = 'SUBMITTED'`),
        one(`SELECT count(*)::int AS v FROM notifications WHERE read_at IS NULL`),
        one(`SELECT count(*)::int AS v FROM purchase_orders
             WHERE status NOT IN ('ACCEPTED','REJECTED','CANCELLED')`),
      ]);

    // Actionable tasks: what needs a human decision right now.
    const tasks = await m.query(`
      SELECT 'APPROVE_REQUEST' AS kind, id, title, created_at FROM procurement_requests WHERE status='SUBMITTED'
      UNION ALL
      SELECT 'OPEN_BIDS', id, title, updated_at FROM sourcing_events WHERE status='CLOSED'
      UNION ALL
      SELECT 'AWARD', id, title, updated_at FROM sourcing_events WHERE status='EVALUATION'
      UNION ALL
      SELECT 'ACCEPT_DELIVERY', id, po_no, updated_at FROM purchase_orders WHERE status='DELIVERED'
      ORDER BY 4 DESC LIMIT 10`);

    return { awardedSpend, savings, activeEvents, pendingApprovals, unreadNotifications, openPos, tasks };
  }
}

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('buyer')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER')
  buyer() {
    return this.dashboard.buyer();
  }
}

@Module({ controllers: [DashboardController], providers: [DashboardService] })
export class DashboardModule {}
