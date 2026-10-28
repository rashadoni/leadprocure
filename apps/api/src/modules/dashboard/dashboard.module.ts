import { BadRequestException, Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { Roles } from '../../common/auth/decorators';
import { RequestContextService } from '../../common/context/request-context.service';

const lineNet = (amount: string) => `(CASE WHEN e.vat_mode='INCLUSIVE' THEN ${amount}-round((${amount})*ei.vat_rate_bp::numeric/(10000+ei.vat_rate_bp)) ELSE ${amount} END)`;
const poNet = `(CASE WHEN p.vat_mode='INCLUSIVE' THEN (SELECT sum(poi.line_total_minor-round(poi.line_total_minor*poi.vat_rate_bp::numeric/(10000+poi.vat_rate_bp))) FROM purchase_order_items poi WHERE poi.po_id=p.id) ELSE p.total_minor END)`;

const iso = (d: Date) => d.toISOString().slice(0, 10);

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
        one(`SELECT COALESCE(SUM((SELECT sum(${lineNet('bi.line_total_minor')}) FROM bid_items bi JOIN event_items ei ON ei.id=bi.event_item_id WHERE bi.bid_id=b.id AND ei.lot_id=a.lot_id)),0)::bigint AS v
             FROM awards a JOIN bids b ON b.id = a.winning_bid_id JOIN sourcing_events e ON e.id=a.event_id WHERE a.cancelled_at IS NULL AND b.currency='AZN'`),
        one(`SELECT COALESCE(SUM((SELECT sum(${lineNet('ei.qty*ei.est_unit_price_minor')}-${lineNet('bi.line_total_minor')}) FROM bid_items bi JOIN event_items ei ON ei.id=bi.event_item_id WHERE bi.bid_id=b.id AND ei.lot_id=a.lot_id)),0)::bigint AS v
             FROM sourcing_events e
             JOIN procurement_requests pr ON pr.id = e.request_id
             JOIN awards a ON a.event_id = e.id
             JOIN bids b ON b.id = a.winning_bid_id WHERE a.cancelled_at IS NULL AND b.currency='AZN' AND e.evaluation_currency='AZN'`),
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
  async spendAnalytics(filter: { from?: string; to?: string; currency?: string } = {}) {
    const currency = filter.currency ?? 'AZN';
    if (!/^[A-Z]{3}$/.test(currency)) throw new BadRequestException('Invalid currency');
    const m = this.rc.manager;
    // The page sends 'YYYY-MM' (an <input type="month">), which Postgres cannot cast to a
    // date — every windowed request answered 500, and no test had ever passed a window.
    // Anything else is refused here rather than reaching the query as a cast error.
    const monthStart = (d?: string): string | null => {
      if (!d) return null;
      if (/^\d{4}-(0[1-9]|1[0-2])$/.test(d)) return `${d}-01`;
      if (/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(d)) return d;
      throw new BadRequestException(`Expected YYYY-MM, got "${d}"`);
    };
    // Resolved here, not left as NULL for the SQL to default: the chart defaulted to the
    // last twelve months while the splits defaulted to all time, and once a year-earlier
    // window exists an unbounded "previous year" would simply mean "everything".
    const now = new Date();
    const firstOf = (year: number, monthIdx: number) => iso(new Date(Date.UTC(year, monthIdx, 1)));
    const to = monthStart(filter.to) ?? firstOf(now.getUTCFullYear(), now.getUTCMonth());
    const from = monthStart(filter.from) ?? firstOf(now.getUTCFullYear(), now.getUTCMonth() - 11);
    // The same window a year earlier. "We spent 40k on fuel" means nothing on its own; the
    // question a finance review actually asks is whether that is more or less than last year.
    const shift = (d: string | null) => (d ? `${Number(d.slice(0, 4)) - 1}${d.slice(4)}` : null);
    const prevFrom = shift(from);
    const prevTo = shift(to);
    // Both aggregates run twice — once per window — so the two halves cannot drift apart.
    const CATEGORY_SQL = `
      SELECT COALESCE(pr.category, '—') AS key,
             sum(${poNet})::bigint AS total, count(*)::int AS po_count
      FROM purchase_orders p
      LEFT JOIN contracts c ON c.id = p.contract_id
      LEFT JOIN sourcing_events e ON e.id = c.event_id
      LEFT JOIN procurement_requests pr ON pr.id = e.request_id
      WHERE p.status = 'ACCEPTED' AND p.currency=$3
        AND ($1::date IS NULL OR p.created_at >= $1::timestamptz)
        AND ($2::date IS NULL OR p.created_at < ($2::date + interval '1 month')::timestamptz)
      GROUP BY 1 ORDER BY 2 DESC`;
    // Reads the PO's OWN department_id rather than walking PO→contract→event→request like
    // the category split: that chain breaks on direct purchases and catalog call-offs, which
    // is precisely the spend a department head asks about. Orders predating departments
    // group under '—'. It also honours the window now — it used to report all time while the
    // page showed a date filter above it.
    const DEPARTMENT_SQL = `
      SELECT COALESCE(d.code, '—') AS key,
             sum(${poNet})::bigint AS total, count(*)::int AS po_count
      FROM purchase_orders p
      LEFT JOIN departments d ON d.id = p.department_id
      WHERE p.status = 'ACCEPTED' AND p.currency=$3
        AND ($1::date IS NULL OR p.created_at >= $1::timestamptz)
        AND ($2::date IS NULL OR p.created_at < ($2::date + interval '1 month')::timestamptz)
      GROUP BY 1 ORDER BY 2 DESC`;

    const [
      monthly, byCategory, topSuppliers, byDepartment, savingsRows, invoiceRows,
      prevMonthly, prevCategory, prevDepartment,
    ] = await Promise.all([
      // Actual by month, plus the PLAN for that month. A phased budget contributes the share
      // finance entered for that month; an unphased one is spread evenly across the months
      // its period covers, so a year of 120k still reads as 10k a month.
      m.query(`
        SELECT to_char(gs.m, 'YYYY-MM') AS month,
               COALESCE(sum(${poNet}), 0)::bigint AS total,
               COALESCE((
                 SELECT sum(CASE
                          WHEN ph.share_bp IS NOT NULL THEN b.amount_minor * ph.share_bp / 10000
                          ELSE b.amount_minor / GREATEST(1, (
                            (EXTRACT(YEAR FROM b.period_end) - EXTRACT(YEAR FROM b.period_start)) * 12
                            + EXTRACT(MONTH FROM b.period_end) - EXTRACT(MONTH FROM b.period_start) + 1))
                        END)::bigint
                 FROM budgets b
                 LEFT JOIN budget_phasing ph ON ph.budget_id = b.id AND ph.month_start = gs.m
                 WHERE b.status IN ('APPROVED','CLOSED') AND b.currency=$3
                   AND gs.m >= date_trunc('month', b.period_start)
                   AND gs.m <= date_trunc('month', b.period_end)
               ), 0)::bigint AS planned
        FROM generate_series(
               COALESCE($1::date, date_trunc('month', now()) - interval '11 months'),
               COALESCE($2::date, date_trunc('month', now())), interval '1 month') gs(m)
        LEFT JOIN purchase_orders p
          ON date_trunc('month', p.created_at) = gs.m AND p.status = 'ACCEPTED' AND p.currency=$3
        GROUP BY gs.m ORDER BY gs.m`, [from, to, currency]),
      m.query(CATEGORY_SQL, [from, to, currency]),
      m.query(`
        SELECT o.legal_name AS name, sum(${poNet})::bigint AS total, count(*)::int AS po_count
        FROM purchase_orders p JOIN organizations o ON o.id = p.supplier_org_id
        WHERE p.status = 'ACCEPTED' AND p.currency=$3
          AND ($1::date IS NULL OR p.created_at >= $1::timestamptz)
          AND ($2::date IS NULL OR p.created_at < ($2::date + interval '1 month')::timestamptz)
        GROUP BY o.id, o.legal_name ORDER BY 2 DESC LIMIT 5`, [from, to, currency]),
      m.query(DEPARTMENT_SQL, [from, to, currency]),
      m.query(`
        WITH awarded AS (
          SELECT e.id, sum(${lineNet('ei.qty*ei.est_unit_price_minor')})::bigint AS est,
                 sum(${lineNet('bi.line_total_minor')})::bigint AS awd
          FROM sourcing_events e JOIN awards a ON a.event_id=e.id AND a.cancelled_at IS NULL
          JOIN bids b ON b.id=a.winning_bid_id
          JOIN bid_items bi ON bi.bid_id=b.id
          JOIN event_items ei ON ei.id=bi.event_item_id AND ei.lot_id=a.lot_id
          WHERE e.evaluation_currency=$3 AND b.currency=$3
            AND a.awarded_at >= $1::date AND a.awarded_at < ($2::date + interval '1 month')
          GROUP BY e.id
        )
        SELECT COALESCE(sum(est), 0)::bigint AS estimated, COALESCE(sum(awd), 0)::bigint AS awarded,
               COALESCE(sum(est - awd), 0)::bigint AS saved, count(*)::int AS events
        FROM awarded`,[from, to, currency]),
      m.query(`
        SELECT COALESCE(sum(gross_minor) FILTER (WHERE status = 'PAID'), 0)::bigint AS paid,
               COALESCE(sum(gross_minor) FILTER (WHERE status NOT IN ('PAID','REJECTED')), 0)::bigint AS outstanding,
               count(*) FILTER (WHERE status = 'PAID')::int AS paid_count,
               count(*) FILTER (WHERE status NOT IN ('PAID','REJECTED'))::int AS outstanding_count
        FROM invoices WHERE currency=$3 AND created_at >= $1::date AND created_at < ($2::date + interval '1 month')`, [from, to, currency]),
      // last year's same window
      m.query(`
        SELECT to_char(gs.m + interval '1 year', 'YYYY-MM') AS month,
               COALESCE(sum(${poNet}), 0)::bigint AS total
        FROM generate_series(
               COALESCE($1::date, date_trunc('month', now()) - interval '11 months') - interval '1 year',
               COALESCE($2::date, date_trunc('month', now())) - interval '1 year', interval '1 month') gs(m)
        LEFT JOIN purchase_orders p
          ON date_trunc('month', p.created_at) = gs.m AND p.status = 'ACCEPTED' AND p.currency=$3
        GROUP BY gs.m ORDER BY gs.m`, [from, to, currency]),
      m.query(CATEGORY_SQL, [prevFrom, prevTo, currency]),
      m.query(DEPARTMENT_SQL, [prevFrom, prevTo, currency]),
    ]);

    // Merge this window with the same window a year earlier. A key that only appears in the
    // earlier window still gets a row: "we stopped buying this" is exactly the kind of change
    // a year-on-year view exists to surface, and dropping the row would hide it.
    const compare = (cur: any[], prev: any[], label: string) => {
      const prevBy = new Map(prev.map((r) => [r.key, Number(r.total)]));
      const rows = cur.map((r) => {
        const total = Number(r.total);
        const prevTotal = prevBy.get(r.key) ?? 0;
        prevBy.delete(r.key);
        return {
          [label]: r.key, totalMinor: total, poCount: r.po_count,
          prevTotalMinor: prevTotal, deltaMinor: total - prevTotal,
          deltaPct: prevTotal > 0 ? Math.round(((total - prevTotal) / prevTotal) * 1000) / 10 : null,
        };
      });
      for (const [key, prevTotal] of prevBy) {
        rows.push({
          [label]: key, totalMinor: 0, poCount: 0,
          prevTotalMinor: prevTotal, deltaMinor: -prevTotal, deltaPct: -100,
        });
      }
      return rows.sort((a: any, b: any) => b.totalMinor - a.totalMinor || b.prevTotalMinor - a.prevTotalMinor);
    };

    const s = savingsRows[0];
    const inv = invoiceRows[0];
    return {
      currency, dateBasis: 'purchase_order_created_at', amountBasis: 'net',
      window: { from, to },
      monthly: (() => {
        const prevBy = new Map(prevMonthly.map((r: any) => [r.month, Number(r.total)]));
        return monthly.map((r: any) => ({
          month: r.month, totalMinor: Number(r.total), plannedMinor: Number(r.planned),
          prevTotalMinor: prevBy.get(r.month) ?? 0,
        }));
      })(),
      byCategory: compare(byCategory, prevCategory, 'category'),
      byDepartment: compare(byDepartment, prevDepartment, 'department'),
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
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER', 'BUYER_FINANCE')
  buyer() {
    return this.dashboard.buyer();
  }

  @Get('supplier')
  @Roles('SUPPLIER_USER')
  supplier() {
    return this.dashboard.supplier();
  }

  @Get('spend-analytics')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER', 'BUYER_FINANCE')
  spendAnalytics(@Query('from') from?: string, @Query('to') to?: string, @Query('currency') currency?: string) {
    return this.dashboard.spendAnalytics({ from: from || undefined, to: to || undefined, currency });
  }
}

@Module({ controllers: [DashboardController], providers: [DashboardService] })
export class DashboardModule {}
