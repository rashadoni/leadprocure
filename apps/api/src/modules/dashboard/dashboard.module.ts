import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
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

    // Actionable tasks: what needs a human decision right now. ref/amount let the UI
    // distinguish same-titled documents (4 × "Ремонт кровли" must not look identical).
    const tasks = await m.query(`
      SELECT 'APPROVE_REQUEST' AS kind, id, title, request_no AS ref,
             estimated_total_minor AS amount_minor, currency, created_at AS at
      FROM procurement_requests WHERE status='SUBMITTED'
      UNION ALL
      SELECT 'OPEN_BIDS', id, title, NULL, NULL, NULL, updated_at FROM sourcing_events WHERE status='CLOSED'
      UNION ALL
      SELECT 'AWARD', id, title, NULL, NULL, NULL, updated_at FROM sourcing_events WHERE status='EVALUATION'
      UNION ALL
      SELECT 'ACCEPT_DELIVERY', id, po_no, po_no, total_minor, currency, updated_at
      FROM purchase_orders WHERE status='DELIVERED'
      ORDER BY 7 DESC LIMIT 10`);

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
      SELECT 'BID' AS kind, e.id, e.title, NULL AS ref, NULL AS amount_minor, NULL AS currency,
             e.close_at AS at
      FROM sourcing_events e
        WHERE e.status = 'OPEN' AND NOT EXISTS (SELECT 1 FROM bids b WHERE b.event_id = e.id)
      UNION ALL
      SELECT 'ADVANCE_DELIVERY', p.id, p.po_no, p.po_no, p.total_minor, p.currency, p.updated_at
      FROM purchase_orders p
        WHERE p.status IN ('ISSUED','CONFIRMED','PACKED','SHIPPED')
      UNION ALL
      SELECT 'INVOICE', p.id, p.po_no, p.po_no, p.total_minor, p.currency, p.updated_at
      FROM purchase_orders p
        WHERE p.status = 'ACCEPTED' AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.po_id = p.id)
      ORDER BY 7 DESC LIMIT 10`);

    return {
      openTenders, myActiveBids, contractsWon, ordersInProgress, invoicesPending,
      unreadNotifications: unread, verificationStatus: ver[0]?.status ?? null, tasks,
    };
  }

  // Spend analytics (buyer). "Spend" = ACCEPTED purchase orders — money the buyer has
  // committed to pay after accepting delivery. Category comes via the PO→contract→event→
  // request chain, so direct/bare POs land under '—' (uncategorized). Savings are grouped
  // per awarded event so a multi-lot award doesn't double-count the request estimate.
  // `from`/`to` bound every panel on the page. Without them the chart was hard-wired to
  // the last 12 months and the splits to all time, so "show me Q3" had no answer at all.
  // Both default to the previous 12 months, which is what the page used to be.
  async spendAnalytics(filter: { from?: string; to?: string } = {}) {
    const m = this.rc.manager;
    const to = filter.to ?? null;
    const from = filter.from ?? null;

    const [monthly, byCategory, topSuppliers, byDepartment, savingsRows, invoiceRows] = await Promise.all([
      // Actual by month, plus the PLAN for that month. A budget's plan is spread evenly
      // across the months its period covers — a year of 120k reads as 10k a month. It is a
      // proration, not a phasing the user entered, which is why the tooltip says so.
      m.query(`
        SELECT to_char(gs.m, 'YYYY-MM') AS month,
               COALESCE(sum(p.total_minor), 0)::bigint AS total,
               COALESCE((
                 SELECT sum(b.amount_minor / GREATEST(1, (
                          (EXTRACT(YEAR FROM b.period_end) - EXTRACT(YEAR FROM b.period_start)) * 12
                          + EXTRACT(MONTH FROM b.period_end) - EXTRACT(MONTH FROM b.period_start) + 1)))::bigint
                 FROM budgets b
                 WHERE b.status IN ('APPROVED','CLOSED')
                   AND gs.m >= date_trunc('month', b.period_start)
                   AND gs.m <= date_trunc('month', b.period_end)
               ), 0)::bigint AS planned
        FROM generate_series(
               COALESCE($1::date, date_trunc('month', now()) - interval '11 months'),
               COALESCE($2::date, date_trunc('month', now())), interval '1 month') gs(m)
        LEFT JOIN purchase_orders p
          ON date_trunc('month', p.created_at) = gs.m AND p.status = 'ACCEPTED'
        GROUP BY gs.m ORDER BY gs.m`, [from, to]),
      m.query(`
        SELECT COALESCE(pr.category, '—') AS category,
               sum(p.total_minor)::bigint AS total, count(*)::int AS po_count
        FROM purchase_orders p
        LEFT JOIN contracts c ON c.id = p.contract_id
        LEFT JOIN sourcing_events e ON e.id = c.event_id
        LEFT JOIN procurement_requests pr ON pr.id = e.request_id
        WHERE p.status = 'ACCEPTED'
          AND ($1::date IS NULL OR p.created_at >= $1::timestamptz)
          AND ($2::date IS NULL OR p.created_at < ($2::date + interval '1 month')::timestamptz)
        GROUP BY 1 ORDER BY 2 DESC`, [from, to]),
      m.query(`
        SELECT o.legal_name AS name, sum(p.total_minor)::bigint AS total, count(*)::int AS po_count
        FROM purchase_orders p JOIN organizations o ON o.id = p.supplier_org_id
        WHERE p.status = 'ACCEPTED'
          AND ($1::date IS NULL OR p.created_at >= $1::timestamptz)
          AND ($2::date IS NULL OR p.created_at < ($2::date + interval '1 month')::timestamptz)
        GROUP BY o.id, o.legal_name ORDER BY 2 DESC LIMIT 5`, [from, to]),
      // Spend by cost centre. Reads the PO's OWN department_id rather than walking
      // PO→contract→event→request like the category split above: that chain breaks on
      // direct purchases and catalog call-offs, which is precisely the spend a department
      // head asks about. Orders predating departments group under '—'.
      m.query(`
        SELECT COALESCE(d.code, '—') AS department,
               sum(p.total_minor)::bigint AS total, count(*)::int AS po_count
        FROM purchase_orders p
        LEFT JOIN departments d ON d.id = p.department_id
        WHERE p.status = 'ACCEPTED'
        GROUP BY 1 ORDER BY 2 DESC`),
      m.query(`
        WITH awarded AS (
          SELECT e.id, pr.estimated_total_minor AS est, sum(b.total_minor)::bigint AS awd
          FROM sourcing_events e
          JOIN procurement_requests pr ON pr.id = e.request_id
          JOIN awards a ON a.event_id = e.id
          JOIN bids b ON b.id = a.winning_bid_id
          GROUP BY e.id, pr.estimated_total_minor
        )
        SELECT COALESCE(sum(est), 0)::bigint AS estimated, COALESCE(sum(awd), 0)::bigint AS awarded,
               COALESCE(sum(est - awd), 0)::bigint AS saved, count(*)::int AS events
        FROM awarded`),
      m.query(`
        SELECT COALESCE(sum(gross_minor) FILTER (WHERE status = 'PAID'), 0)::bigint AS paid,
               COALESCE(sum(gross_minor) FILTER (WHERE status NOT IN ('PAID','REJECTED')), 0)::bigint AS outstanding,
               count(*) FILTER (WHERE status = 'PAID')::int AS paid_count,
               count(*) FILTER (WHERE status NOT IN ('PAID','REJECTED'))::int AS outstanding_count
        FROM invoices`),
    ]);

    const s = savingsRows[0];
    const inv = invoiceRows[0];
    return {
      window: { from, to },
      monthly: monthly.map((r: any) => ({
        month: r.month, totalMinor: Number(r.total), plannedMinor: Number(r.planned),
      })),
      byCategory: byCategory.map((r: any) => ({ category: r.category, totalMinor: Number(r.total), poCount: r.po_count })),
      byDepartment: byDepartment.map((r: any) => ({ department: r.department, totalMinor: Number(r.total), poCount: r.po_count })),
      topSuppliers: topSuppliers.map((r: any) => ({ name: r.name, totalMinor: Number(r.total), poCount: r.po_count })),
      savings: {
        estimatedMinor: Number(s.estimated), awardedMinor: Number(s.awarded),
        savedMinor: Number(s.saved), events: s.events,
      },
      invoices: {
        paidMinor: Number(inv.paid), outstandingMinor: Number(inv.outstanding),
        paidCount: inv.paid_count, outstandingCount: inv.outstanding_count,
      },
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

  @Get('spend-analytics')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER')
  spendAnalytics(@Query('from') from?: string, @Query('to') to?: string) {
    return this.dashboard.spendAnalytics({ from: from || undefined, to: to || undefined });
  }
}

@Module({ controllers: [DashboardController], providers: [DashboardService] })
export class DashboardModule {}
