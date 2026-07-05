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

  // Supplier KPIs — all RLS-scoped to the supplier org.
  async supplier() {
    const m = this.rc.manager;
    const one = async (sql: string) => Number((await m.query(sql))[0]?.v ?? 0);

    const [openTenders, myActiveBids, contractsWon, ordersInProgress, invoicesPending, unread] = await Promise.all([
      one(`SELECT count(*)::int AS v FROM sourcing_events WHERE status = 'OPEN'`),
      one(`SELECT count(*)::int AS v FROM bids WHERE state IN ('SUBMITTED','OPENED')`),
      one(`SELECT count(*)::int AS v FROM contracts`),
      one(`SELECT count(*)::int AS v FROM purchase_orders WHERE status NOT IN ('ACCEPTED','REJECTED','CANCELLED')`),
      one(`SELECT count(*)::int AS v FROM invoices WHERE status NOT IN ('PAID','REJECTED')`),
      one(`SELECT count(*)::int AS v FROM notifications WHERE read_at IS NULL`),
    ]);
    const ver = await m.query(`SELECT status FROM supplier_verification_cases ORDER BY created_at DESC LIMIT 1`);

    const tasks = await m.query(`
      SELECT 'BID' AS kind, e.id, e.title, e.close_at AS at FROM sourcing_events e
        WHERE e.status = 'OPEN' AND NOT EXISTS (SELECT 1 FROM bids b WHERE b.event_id = e.id)
      UNION ALL
      SELECT 'ADVANCE_DELIVERY', p.id, p.po_no, p.updated_at FROM purchase_orders p
        WHERE p.status IN ('ISSUED','CONFIRMED','PACKED','SHIPPED')
      UNION ALL
      SELECT 'INVOICE', p.id, p.po_no, p.updated_at FROM purchase_orders p
        WHERE p.status = 'ACCEPTED' AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.po_id = p.id)
      ORDER BY 4 DESC LIMIT 10`);

    return {
      openTenders, myActiveBids, contractsWon, ordersInProgress, invoicesPending,
      unreadNotifications: unread, verificationStatus: ver[0]?.status ?? null, tasks,
    };
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

  @Get('supplier')
  @Roles('SUPPLIER_USER')
  supplier() {
    return this.dashboard.supplier();
  }
}

@Module({ controllers: [DashboardController], providers: [DashboardService] })
export class DashboardModule {}
