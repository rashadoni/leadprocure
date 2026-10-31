import { useEffect, useState } from 'react';
import { api, fmtMoney } from '../../api/client';
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
  paceDeltaPct: number;
}

export default function Analytics() {
  const { t } = useI18n();
  const [currency,setCurrency]=useState('AZN');
  const [d, setD] = useState<Spend | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reload, setReload] = useState(0);
  // The page used to be hard-wired to the last 12 months, so "show me Q3" had no answer.
  // Presets cover what gets asked for; the month inputs cover everything else.
  const [win, setWin] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const monthsAgo = (n: number) => {
    const dt = new Date();
    // Month arithmetic must start on day 1: June 31 otherwise rolls into July.
    dt.setUTCDate(1);
    dt.setUTCMonth(dt.getUTCMonth() - n);
    return dt.toISOString().slice(0, 7);
  };
  const thisMonth = new Date().toISOString().slice(0, 7);
  const preset = (fromMonthsAgo: number) => setWin({ from: monthsAgo(fromMonthsAgo), to: thisMonth });
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

  const filters = <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
    <select data-testid="analytics-currency" aria-label={t('currency')} value={currency} onChange={e=>setCurrency(e.target.value)}>{['AZN','USD','EUR'].map(c=><option key={c}>{c}</option>)}</select>
    <button className="btn ghost small" onClick={() => preset(11)}>{t('win_12m')}</button>
    <button className="btn ghost small" onClick={() => preset(2)}>{t('win_quarter')}</button>
    <button className="btn ghost small" onClick={() => setWin({ from: `${new Date().getUTCFullYear()}-01`, to: thisMonth })}>{t('win_ytd')}</button>
    <input type="month" aria-label={t('analytics_from')} value={win.from} onChange={(e) => setWin({ ...win, from: e.target.value })} style={{ width: 150 }} />
    <input type="month" aria-label={t('analytics_to')} value={win.to} onChange={(e) => setWin({ ...win, to: e.target.value })} style={{ width: 150 }} />
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
  // the plan line must fit the same scale as the bars, or it lands off the chart
  const maxMonth = Math.max(1, ...d.monthly.map((m) => Math.max(m.totalMinor, m.plannedMinor, m.prevTotalMinor)));
  // Growth reads as a cost, so up is red and down is green — the opposite of a sales chart.
  const delta = (r: { prevTotalMinor: number; deltaMinor: number; deltaPct: number | null }) => {
    if (r.prevTotalMinor === 0 && r.deltaMinor === 0) return null;
    const up = r.deltaMinor > 0;
    return (
      <span className={up ? 'error' : 'hint'} data-tip={`${t('yoy_prev')}: ${money(r.prevTotalMinor)}`}>
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
        {/* PO volume is net; invoices are gross — label the VAT basis so «paid > spend» never
            reads as a data error. The invoice tiles are the INVOICE LEDGER: every invoice
            recorded in this window, whatever became of its order. /buyer/budgets answers a
            different question with the same word, so both carry their basis in the label. */}
        {[
          { label: `${t('spend')} · ${t('net_label')}`, value: money(d.monthly.reduce((s, m) => s + m.totalMinor, 0)) },
          { label: `${t('savings')} · ${d.savings.events}`, value: `${money(d.savings.savedMinor)} (${savingsPct}%)`,
            hint: t('savings_hint') },
          { label: `${t(paidBasis)} · ${d.invoices.paidCount} · ${t('gross_label')}`, value: money(d.invoices.paidMinor),
            hint: t(paidBasisTip) },
          { label: `${t('inv_outstanding')} · ${d.invoices.outstandingCount} · ${t('gross_label')}`, value: money(d.invoices.outstandingMinor),
            hint: t('inv_outstanding_hint') },
        ].map((c: any) => (
          <div className="card" key={c.label} style={{ marginBottom: 0 }} title={c.hint}>
            <div style={{ color: 'var(--muted)', fontSize: 12 }}>{c.label}</div>
            <div style={{ fontSize: 20, fontWeight: 800, marginTop: 6 }}>{c.value}</div>
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
        <div className="chart">
          {d.monthly.map((m) => (
            <div key={m.month} className="chart-col"
              title={`${m.month}: ${t('fact')} ${money(m.totalMinor)} · ${t('plan')} ${money(m.plannedMinor)} · ${t('yoy_prev')} ${money(m.prevTotalMinor)}`}>
              {/* the same month a year ago, behind the bar — the eye compares heights without
                  a legend, and an empty last year simply shows nothing */}
              {m.prevTotalMinor > 0 && (
                <div className="chart-prev" style={{ bottom: `${Math.min(100, Math.round((m.prevTotalMinor / maxMonth) * 100))}%` }} />
              )}
              <div className="chart-bar" style={{ height: `${Math.round((m.totalMinor / maxMonth) * 100)}%` }} />
              {/* the plan for that month: the phasing finance entered, or an even proration */}
              {m.plannedMinor > 0 && (
                <div className="chart-plan" style={{ bottom: `${Math.min(100, Math.round((m.plannedMinor / maxMonth) * 100))}%` }} />
              )}
              <span className="chart-label">{m.month.slice(5)}</span>
            </div>
          ))}
        </div>
        <div className="hint" style={{ marginTop: 8 }}>{t('plan_line_hint')}</div>
      </div>

      <ListState of={{ loading: false, failed: paceFailed, reload: loadPace }} />
      {pace.length > 0 && (
        <div className="card">
          <h3>{t('budget_pace')}</h3>
          <div className="hint" style={{ marginBottom: 10 }}>{t('budget_pace_hint')}</div>
          <table>
            <thead><tr>
              <th>{t('department')}</th><th>{t('amount')}</th><th>{t('utilization')}</th>
              <th>{t('period_elapsed')}</th><th>{t('pace')}</th>
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
                    <td className="hint">{p.elapsedPct}%</td>
                    <td className={ahead ? 'error' : ''}>
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

      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div className="card" style={{ flex: 1 }}>
          <h3>{t('by_department')} <span className="hint" style={{ fontWeight: 400, fontSize: 12 }}>· {t('yoy_note')}</span></h3>
          {/* keyed off the PO's own department, so direct and catalog orders count too */}
          {d.byDepartment.length === 0 && <div className="hint">—</div>}
          {d.byDepartment.map((c) => (
            <div key={c.department} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <span>{c.department}</span>
                <span>{money(c.totalMinor)} · {c.poCount} PO {delta(c)}</span>
              </div>
              <div className="budget-bar"><div className="budget-fill" style={{ width: `${Math.round((c.totalMinor / maxDep) * 100)}%` }} /></div>
            </div>
          ))}
        </div>
        <div className="card" style={{ flex: 1 }}>
          <h3>{t('by_category')} <span className="hint" style={{ fontWeight: 400, fontSize: 12 }}>· {t('yoy_note')}</span></h3>
          {d.byCategory.length === 0 && <div className="hint">—</div>}
          {d.byCategory.map((c) => (
            <div key={c.category} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <span>{c.category}</span>
                <span>{money(c.totalMinor)} · {c.poCount} PO {delta(c)}</span>
              </div>
              <div className="budget-bar"><div className="budget-fill" style={{ width: `${Math.round((c.totalMinor / maxCat) * 100)}%` }} /></div>
            </div>
          ))}
        </div>
        <div className="card" style={{ flex: 1 }}>
          <h3>{t('top_suppliers')}</h3>
          <table>
            <thead><tr><th>{t('supplier_org')}</th><th>{t('total')}</th><th>PO</th></tr></thead>
            <tbody>
              {d.topSuppliers.map((s) => (
                <tr key={s.name}><td>{s.name}</td><td>{money(s.totalMinor)}</td><td>{s.poCount}</td></tr>
              ))}
              {d.topSuppliers.length === 0 && <tr><td colSpan={3} className="hint">—</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
