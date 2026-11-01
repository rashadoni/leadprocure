import { useEffect, useState } from 'react';
import { api, fmtMoney, fmtNumShort } from '../../api/client';
import type { PaidBasis } from '@leadprocure/shared';
import { useI18n } from '../../i18n';
import { isDenied, ListState } from '../../components/ListState';

// Every split carries the same window a year earlier beside it. A row that exists only in
// last year's half still comes back — "we stopped buying this" is a change worth seeing.
type YoyRow<K extends string> = { [P in K]: string } & {
  totalMinor: number;
  poCount: number;
  prevTotalMinor: number;
  deltaMinor: number;
  deltaPct: number | null;
};

interface Spend {
  currency: string;
  window: { from: string | null; to: string | null };
  monthly: { month: string; totalMinor: number; plannedMinor: number; prevTotalMinor: number }[];
  byCategory: YoyRow<'category'>[];
  byDepartment: YoyRow<'department'>[];
  topSuppliers: { name: string; totalMinor: number; poCount: number }[];
  savings: { estimatedMinor: number; awardedMinor: number; savedMinor: number; events: number };
  // The invoice LEDGER, not budget settlement: the endpoint names its own basis, and
  // PAID_BASES in @leadprocure/shared holds both definitions side by side.
  invoices: {
    paidMinor: number; outstandingMinor: number; paidCount: number; outstandingCount: number;
    basis: PaidBasis; dateBasis: string;
  };
}

interface Pace {
  departmentCode: string | null;
  currency: string;
  amountMinor: number;
  usedMinor: number;
  remainingMinor: number;
  utilizationPct: number;
  elapsedPct: number;
  // whether "should be at 58%" came from a monthly phasing or from the bare calendar
  phased: boolean;
  paceDeltaPct: number;
}

// Which preset window is on screen. Kept beside the window itself rather than derived from
// it: in March "quarter" and "year to date" resolve to the very same two months, and a
// derived highlight would have to pick one of them and be wrong half the time.
type WinKey = '12m' | 'q' | 'ytd' | '';

// The axis a reader can actually use: a round top tick, so the three labels come out as
// 0 / 75k / 150k instead of 0 / 62.4k / 124.8k. Bars lose a few per cent of height and the
// chart gains a scale, which is the trade the whole axis exists to make.
const niceMax = (v: number): number => {
  if (!(v > 0)) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
};

export default function Analytics() {
  const { t } = useI18n();
  const [currency,setCurrency]=useState('AZN');
  const [d, setD] = useState<Spend | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reload, setReload] = useState(0);
  const monthsAgo = (n: number) => {
    const dt = new Date();
    // Month arithmetic must start on day 1: June 31 otherwise rolls into July.
    dt.setUTCDate(1);
    dt.setUTCMonth(dt.getUTCMonth() - n);
    return dt.toISOString().slice(0, 7);
  };
  const thisMonth = new Date().toISOString().slice(0, 7);
  const yearStart = `${new Date().getUTCFullYear()}-01`;
  // The page used to be hard-wired to the last 12 months, so "show me Q3" had no answer.
  // Presets cover what gets asked for; the month inputs cover everything else. The window
  // starts filled in rather than empty: the server's own default IS the last twelve months,
  // so an empty pair meant the screen could not say which window it was showing.
  const [win, setWin] = useState<{ from: string; to: string }>(
    () => ({ from: monthsAgo(11), to: thisMonth }),
  );
  const [winKey, setWinKey] = useState<WinKey>('12m');
  const preset = (key: WinKey, from: string) => { setWinKey(key); setWin({ from, to: thisMonth }); };
  // Typing a month by hand leaves no preset selected — the highlight must never claim a
  // window the reader did not pick.
  const setMonth = (part: 'from' | 'to', value: string) => {
    setWinKey('');
    setWin((w) => (part === 'from' ? { ...w, from: value } : { ...w, to: value }));
  };
  // Budget pace lives behind the controls.budgets feature; if it is off, the call fails and
  // the card simply doesn't render — the rest of the page is unaffected.
  const [pace, setPace] = useState<Pace[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setD(null);
    setLoadError(false);
    api.get('/dashboard/spend-analytics', {
      signal: controller.signal,
      params: {
        currency,
        ...(win.from ? { from: `${win.from}-01` } : {}),
        ...(win.to ? { to: `${win.to}-01` } : {}),
      },
    }).then((r) => { if (active) setD(r.data); })
      .catch(() => { if (active) setLoadError(true); });
    return () => { active = false; controller.abort(); };
  }, [win.from, win.to, currency, reload]);
  const [paceFailed, setPaceFailed] = useState(false);
  // Without the budgets licence this is denied and the card is correctly absent. Any
  // other failure is a dead read, and an absent pace card is not the same as "on pace".
  const loadPace = () => {
    setPaceFailed(false);
    api.get('/budgets/rollup', { params: { current: 1 } })
      .then((r) => setPace(r.data))
      .catch((e: any) => { setPace([]); if (!isDenied(e)) setPaceFailed(true); });
  };
  useEffect(loadPace, []);
  // Auth-guarded CSV of exactly the window on screen.
  const exportCsv = () => {
    if (!d) return;
    const rows = [[t('date'), t('plan'), t('fact'), t('yoy_prev')].join(';')]
      .concat(d.monthly.map((m) => [
        m.month, (m.plannedMinor / 100).toFixed(2), (m.totalMinor / 100).toFixed(2),
        (m.prevTotalMinor / 100).toFixed(2),
      ].join(';')));
    const blob = new Blob(['\ufeff' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'analytics.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  // A preset is marked by FILL, never by its text: the browser specs find these buttons by
  // their accessible name, and a tick added to the active one would rename it.
  const presetBtn = (key: WinKey, label: string, from: string) => (
    <button className={`btn small ${winKey === key ? '' : 'ghost'}`} aria-pressed={winKey === key}
      onClick={() => preset(key, from)}>{label}</button>
  );

  const filters = <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
    <div className="filter-field">
      <label htmlFor="an-currency">{t('currency')}</label>
      <select id="an-currency" data-testid="analytics-currency" style={{ width: 96 }} value={currency} onChange={e=>setCurrency(e.target.value)}>
        {['AZN','USD','EUR'].map(c=><option key={c}>{c}</option>)}
      </select>
    </div>
    <div className="filter-field">
      <span className="filter-label">{t('period')}</span>
      <div style={{ display: 'flex', gap: 6 }}>
        {presetBtn('12m', t('win_12m'), monthsAgo(11))}
        {presetBtn('q', t('win_quarter'), monthsAgo(2))}
        {presetBtn('ytd', t('win_ytd'), yearStart)}
      </div>
    </div>
    {/* An empty <input type="month"> draws itself as "---- --". Both fields carry a visible
        label, not only an aria-label: the placeholder cannot be set and the shape of the
        control says nothing about which end of the window it holds. The width fits the
        browser's own rendering — at 150px the English long month came out as
        "December 202!", clipped mid-year, with the picker icon on top of it. */}
    <div className="filter-field">
      <label htmlFor="an-from">{t('analytics_from')}</label>
      <input id="an-from" type="month" value={win.from} onChange={(e) => setMonth('from', e.target.value)} style={{ width: 200 }} />
    </div>
    <div className="filter-field">
      <label htmlFor="an-to">{t('analytics_to')}</label>
      <input id="an-to" type="month" value={win.to} onChange={(e) => setMonth('to', e.target.value)} style={{ width: 200 }} />
    </div>
    <button className="btn ghost small" disabled={!d} onClick={exportCsv}>⤓ CSV</button>
  </div>;

  if (!d) return <><h1>{t('analytics')}</h1>{filters}
    {loadError ? <div role="alert" className="state-error">{t('analytics_load_error')} <button className="btn ghost small" onClick={() => setReload(n => n + 1)}>{t('analytics_retry')}</button></div>
      : <div className="center" role="status">…</div>}
  </>;

  const money = (value: number) => fmtMoney(value, d.currency);
  // The label and the explanation come from the basis the endpoint DECLARES, not from an
  // assumption on this page: if the endpoint ever started reporting the other measure, the
  // wording would move with it instead of quietly lying. One wording per meaning, shared
  // with /buyer/budgets — see PAID_BASES in @leadprocure/shared.
  const paidBasis = `paid_basis_${d.invoices.basis}`;
  // `tip` explains the figure on hover, `note` is the visible line that names the other page.
  const paidBasisTip = `paid_basis_tip_${d.invoices.basis}`;
  const paidBasisNote = `paid_basis_note_${d.invoices.basis}`;
  // the plan line and last year's line must fit the same scale as the bars, or they land
  // off the chart
  const peak = Math.max(0, ...d.monthly.map((m) => Math.max(m.totalMinor, m.plannedMinor, m.prevTotalMinor)));
  const scale = niceMax(peak);
  const hasPlan = d.monthly.some((m) => m.plannedMinor > 0);
  const hasPrev = d.monthly.some((m) => m.prevTotalMinor > 0);
  // Growth reads as a cost, so up is red and down is green — the opposite of a sales chart.
  // A key with nothing behind it last year is the exception: deltaPct is null there, and
  // «new» in alarm red said something the figure does not mean — a category bought for the
  // first time is news, not a problem.
  const delta = (r: { prevTotalMinor: number; deltaMinor: number; deltaPct: number | null }) => {
    if (r.prevTotalMinor === 0 && r.deltaMinor === 0) return null;
    const isNew = r.deltaPct == null;
    const up = r.deltaMinor > 0;
    return (
      <span className={!isNew && up ? 'error' : 'hint'} data-tip={`${t('yoy_prev')}: ${money(r.prevTotalMinor)}`}>
        {up ? '▲' : '▼'} {r.deltaPct == null ? t('yoy_new') : `${Math.abs(r.deltaPct)}%`}
      </span>
    );
  };
  const maxCat = Math.max(1, ...d.byCategory.map((c) => c.totalMinor));
  const maxDep = Math.max(1, ...d.byDepartment.map((c) => c.totalMinor));
  const savingsPct = d.savings.estimatedMinor > 0
    ? Math.round((d.savings.savedMinor / d.savings.estimatedMinor) * 1000) / 10 : 0;

  return (
    <>
      <h1>{t('analytics')}</h1>
      {filters}
      <p className="hint">{t('spend_date_basis')}</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12, marginBottom: 8 }}>
        {/* PO volume is net; invoices are gross. The basis and the count used to ride in the
            card's title behind the same separator as its name — «Paid · 3 · incl. VAT» reads
            as one phrase of three unrelated parts. The name stands alone now, and the line
            under the figure says in words what was counted and on what basis. Each `tip` is
            written from the query in dashboard.module.ts, not from the label above it. */}
        {[
          { label: t('spend'), value: money(d.monthly.reduce((s, m) => s + m.totalMinor, 0)),
            note: t('net_label'), tip: t('spend_hint') },
          { label: t('savings'), value: `${money(d.savings.savedMinor)} (${savingsPct}%)`,
            note: `${t('events')}: ${d.savings.events} · ${t('net_label')}`, tip: t('savings_hint') },
          { label: t(paidBasis), value: money(d.invoices.paidMinor),
            note: `${t('invoices')}: ${d.invoices.paidCount} · ${t('gross_label')}`, tip: t(paidBasisTip) },
          { label: t('inv_outstanding'), value: money(d.invoices.outstandingMinor),
            note: `${t('invoices')}: ${d.invoices.outstandingCount} · ${t('gross_label')}`, tip: t('inv_outstanding_hint') },
        ].map((c) => (
          <div className="card" key={c.label} style={{ marginBottom: 0 }} data-tip={c.tip}>
            <div style={{ color: 'var(--muted)', fontSize: 12 }}>{c.label}</div>
            <div style={{ fontSize: 20, fontWeight: 800, marginTop: 6 }}>{c.value}</div>
            <div className="hint" style={{ fontSize: 11, marginTop: 4 }}>{c.note}</div>
          </div>
        ))}
      </div>
      {/* Said out loud, not only in a tooltip: finance opens both pages and must not have to
          guess why the two «paid» figures differ. */}
      <p className="hint" style={{ marginTop: 0, marginBottom: 16 }}>{t(paidBasisNote)}</p>

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0 }}>{t('monthly_spend')}</h3>
        </div>
        {peak === 0 ? (
          // Twelve columns of 2px stubs against an invisible scale is what an empty window
          // used to look like, and it reads as a broken chart rather than as "nothing here".
          <div className="hint" style={{ padding: '18px 0' }}>{t('chart_empty')}</div>
        ) : (
        <>
        <div className="chart-frame">
          {/* The bars used to be drawn against a maximum that appeared nowhere on screen, so
              a column's height could be compared with its neighbour and with nothing else. */}
          <div className="chart-y">
            <span className="chart-tick" style={{ bottom: '100%' }}>{fmtNumShort(scale)} {d.currency}</span>
            <span className="chart-tick" style={{ bottom: '50%' }}>{fmtNumShort(scale / 2)}</span>
            <span className="chart-tick" style={{ bottom: '0%' }}>0</span>
          </div>
          <div className="chart">
            <div className="chart-grid" aria-hidden="true">
              <i className="chart-rule" style={{ bottom: '100%' }} />
              <i className="chart-rule" style={{ bottom: '50%' }} />
              <i className="chart-rule" style={{ bottom: '0%' }} />
            </div>
            {d.monthly.map((m) => (
              <div key={m.month} className="chart-col"
                data-tip={`${m.month}: ${t('fact')} ${money(m.totalMinor)} · ${t('plan')} ${money(m.plannedMinor)} · ${t('yoy_prev')} ${money(m.prevTotalMinor)}`}>
                {/* the same month a year ago, behind the bar — the eye compares heights without
                    a legend, and an empty last year simply shows nothing */}
                {m.prevTotalMinor > 0 && (
                  <div className="chart-prev" style={{ bottom: `${Math.min(100, (m.prevTotalMinor / scale) * 100)}%` }} />
                )}
                <div className="chart-bar" style={{ height: `${Math.min(100, (m.totalMinor / scale) * 100)}%` }} />
                {/* the plan for that month: the phasing finance entered, or an even proration */}
                {m.plannedMinor > 0 && (
                  <div className="chart-plan" style={{ bottom: `${Math.min(100, (m.plannedMinor / scale) * 100)}%` }} />
                )}
                <span className="chart-label">{m.month.slice(5)}</span>
              </div>
            ))}
          </div>
        </div>
        {/* Three different marks shared one prose paragraph below the chart. Each is now
            named next to the mark itself, and a mark that isn't drawn isn't claimed. */}
        <div className="chart-key">
          <span><i className="k-fact" />{t('fact')}</span>
          {hasPlan && <span><i className="k-plan" />{t('plan')}</span>}
          {hasPrev && <span><i className="k-prev" />{t('yoy_prev')}</span>}
        </div>
        {hasPlan && <div className="hint" style={{ marginTop: 8 }}>{t('plan_line_hint')}</div>}
        {/* Budgets are AZN-only by a database constraint, so in any other currency the plan
            line is absent by design — not missing data to go looking for. */}
        {!hasPlan && d.currency !== 'AZN' && <div className="hint" style={{ marginTop: 8 }}>{t('plan_azn_only')}</div>}
        </>
        )}
      </div>

      <ListState of={{ loading: false, failed: paceFailed, reload: loadPace }} />
      {pace.length > 0 && (
        <div className="card">
          <h3>{t('budget_pace')}</h3>
          <div className="hint" style={{ marginBottom: 10 }}>{t('budget_pace_hint')}</div>
          <table>
            {/* Every column here is a share or a sum of something the row does not name, so
                each heading carries what it holds. «Темп +14%» was a bare number. */}
            <thead><tr>
              <th>{t('department')}</th>
              <th className="num" data-tip={t('an_plan_tip')}>{t('plan')}</th>
              <th className="num" data-tip={t('utilization_tip')}>{t('utilization')}</th>
              {/* NOT "period elapsed": the figure is plannedMinor/amountMinor, so under a
                  monthly phasing it is the share of the PLAN due by today, which in a
                  heating budget is nothing like the share of the calendar that has gone.
                  Same wording and same two tips as /buyer/budgets. */}
              <th>{t('bud_pace')}</th>
              <th data-tip={t('pace_tip')}>{t('pace')}</th>
            </tr></thead>
            <tbody>
              {pace.map((p) => {
                // ahead of the calendar by more than 10 points is the case worth catching
                const ahead = p.paceDeltaPct > 10;
                return (
                  <tr key={p.departmentCode ?? 'org'}>
                    <td><b>{p.departmentCode ?? t('bud_org_wide')}</b></td>
                    <td className="num">{fmtMoney(p.amountMinor, p.currency)}</td>
                    <td className="num">{fmtMoney(p.usedMinor, p.currency)} · {p.utilizationPct}%</td>
                    <td className="hint" data-tip={p.phased ? t('bud_pace_phased_tip') : t('bud_pace_tip')}>
                      {p.elapsedPct}%{p.phased ? ' 📅' : ''}
                    </td>
                    <td className={ahead ? 'error' : ''} data-tip={t('pace_tip')}>
                      {p.paceDeltaPct > 0 ? '+' : ''}{p.paceDeltaPct}%
                      {ahead ? ` · ${t('pace_ahead')}` : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Three cards in a row that could not wrap: below roughly 900px they squeezed into
          columns too narrow for a supplier's name. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(290px, 1fr))', gap: 12, alignItems: 'start' }}>
        <div className="card" style={{ marginBottom: 0 }}>
          <h3>{t('by_department')} <span className="hint" style={{ fontWeight: 400, fontSize: 12 }}>· {t('yoy_note')}</span></h3>
          {/* keyed off the PO's own department, so direct and catalog orders count too */}
          {/* the two bar lists sit beside a table that has a header; theirs was two
              unnamed numbers per row */}
          {d.byDepartment.length > 0 && (
            <div className="hint" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, marginBottom: 6 }}>
              <span>{t('department')}</span><span>{t('total')} · PO</span>
            </div>
          )}
          {d.byDepartment.length === 0 && <div className="hint">—</div>}
          {d.byDepartment.map((c) => (
            <div key={c.department} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }}>
                <span>{c.department}</span>
                <span className="nowrap">{money(c.totalMinor)} · {c.poCount} PO {delta(c)}</span>
              </div>
              <div className="budget-bar"><div className="budget-fill" style={{ width: `${Math.round((c.totalMinor / maxDep) * 100)}%` }} /></div>
            </div>
          ))}
        </div>
        <div className="card" style={{ marginBottom: 0 }}>
          <h3>{t('by_category')} <span className="hint" style={{ fontWeight: 400, fontSize: 12 }}>· {t('yoy_note')}</span></h3>
          {/* the two bar lists sit beside a table that has a header; theirs was two
              unnamed numbers per row */}
          {d.byCategory.length > 0 && (
            <div className="hint" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, marginBottom: 6 }}>
              <span>{t('category')}</span><span>{t('total')} · PO</span>
            </div>
          )}
          {d.byCategory.length === 0 && <div className="hint">—</div>}
          {d.byCategory.map((c) => (
            <div key={c.category} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }}>
                <span>{c.category}</span>
                <span className="nowrap">{money(c.totalMinor)} · {c.poCount} PO {delta(c)}</span>
              </div>
              <div className="budget-bar"><div className="budget-fill" style={{ width: `${Math.round((c.totalMinor / maxCat) * 100)}%` }} /></div>
            </div>
          ))}
        </div>
        <div className="card" style={{ marginBottom: 0 }}>
          <h3>{t('top_suppliers')}</h3>
          <table>
            <thead><tr><th>{t('supplier_org')}</th><th className="num">{t('total')}</th><th className="num">PO</th></tr></thead>
            <tbody>
              {d.topSuppliers.map((s) => (
                <tr key={s.name}><td>{s.name}</td><td className="num">{money(s.totalMinor)}</td><td className="num">{s.poCount}</td></tr>
              ))}
              {d.topSuppliers.length === 0 && <tr><td colSpan={3} className="hint">—</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
