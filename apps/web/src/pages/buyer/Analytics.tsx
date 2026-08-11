import { useEffect, useState } from 'react';
import { api, fmtMoney } from '../../api/client';
import { useI18n } from '../../i18n';

interface Spend {
  window: { from: string | null; to: string | null };
  monthly: { month: string; totalMinor: number; plannedMinor: number }[];
  byCategory: { category: string; totalMinor: number; poCount: number }[];
  byDepartment: { department: string; totalMinor: number; poCount: number }[];
  topSuppliers: { name: string; totalMinor: number; poCount: number }[];
  savings: { estimatedMinor: number; awardedMinor: number; savedMinor: number; events: number };
  invoices: { paidMinor: number; outstandingMinor: number; paidCount: number; outstandingCount: number };
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
  const [d, setD] = useState<Spend | null>(null);
  // The page used to be hard-wired to the last 12 months, so "show me Q3" had no answer.
  // Presets cover what gets asked for; the month inputs cover everything else.
  const [win, setWin] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const monthsAgo = (n: number) => {
    const dt = new Date(); dt.setUTCMonth(dt.getUTCMonth() - n);
    return dt.toISOString().slice(0, 7);
  };
  const thisMonth = new Date().toISOString().slice(0, 7);
  const preset = (fromMonthsAgo: number) => setWin({ from: monthsAgo(fromMonthsAgo), to: thisMonth });
  // Budget pace lives behind the controls.budgets feature; if it is off, the call fails and
  // the card simply doesn't render — the rest of the page is unaffected.
  const [pace, setPace] = useState<Pace[]>([]);
  useEffect(() => {
    api.get('/dashboard/spend-analytics', {
      params: {
        ...(win.from ? { from: `${win.from}-01` } : {}),
        ...(win.to ? { to: `${win.to}-01` } : {}),
      },
    }).then((r) => setD(r.data));
  }, [win.from, win.to]);
  useEffect(() => {
    api.get('/budgets/rollup', { params: { current: 1 } })
      .then((r) => setPace(r.data)).catch(() => setPace([]));
  }, []);
  // Auth-guarded CSV of exactly the window on screen.
  const exportCsv = () => {
    if (!d) return;
    const rows = [[t('date'), t('plan'), t('fact')].join(';')]
      .concat(d.monthly.map((m) => [m.month, (m.plannedMinor / 100).toFixed(2), (m.totalMinor / 100).toFixed(2)].join(';')));
    const blob = new Blob(['\ufeff' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'analytics.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  if (!d) return <><h1>{t('analytics')}</h1><div className="center">…</div></>;

  // the plan line must fit the same scale as the bars, or it lands off the chart
  const maxMonth = Math.max(1, ...d.monthly.map((m) => Math.max(m.totalMinor, m.plannedMinor)));
  const maxCat = Math.max(1, ...d.byCategory.map((c) => c.totalMinor));
  const maxDep = Math.max(1, ...d.byDepartment.map((c) => c.totalMinor));
  const savingsPct = d.savings.estimatedMinor > 0
    ? Math.round((d.savings.savedMinor / d.savings.estimatedMinor) * 1000) / 10 : 0;

  return (
    <>
      <h1>{t('analytics')}</h1>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12, marginBottom: 16 }}>
        {/* PO volume is net; invoices are gross — label the VAT basis so «paid > spend» never
            reads as a data error. */}
        {[
          { label: `${t('spend')} · ${t('net_label')}`, value: fmtMoney(d.monthly.reduce((s, m) => s + m.totalMinor, 0)) },
          { label: `${t('savings')} · ${d.savings.events}`, value: `${fmtMoney(d.savings.savedMinor)} (${savingsPct}%)`,
            hint: t('savings_hint') },
          { label: `${t('paid')} · ${d.invoices.paidCount} · ${t('gross_label')}`, value: fmtMoney(d.invoices.paidMinor) },
          { label: `${t('outstanding')} · ${d.invoices.outstandingCount} · ${t('gross_label')}`, value: fmtMoney(d.invoices.outstandingMinor) },
        ].map((c: any) => (
          <div className="card" key={c.label} style={{ marginBottom: 0 }} title={c.hint}>
            <div style={{ color: 'var(--muted)', fontSize: 12 }}>{c.label}</div>
            <div style={{ fontSize: 20, fontWeight: 800, marginTop: 6 }}>{c.value}</div>
          </div>
        ))}
      </div>

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0 }}>{t('monthly_spend')}</h3>
          <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', alignItems: 'center' }}>
            <button className="btn ghost small" onClick={() => preset(11)}>{t('win_12m')}</button>
            <button className="btn ghost small" onClick={() => preset(2)}>{t('win_quarter')}</button>
            <button className="btn ghost small" onClick={() => setWin({ from: `${new Date().getFullYear()}-01`, to: thisMonth })}>{t('win_ytd')}</button>
            <input type="month" value={win.from} onChange={(e) => setWin({ ...win, from: e.target.value })} style={{ width: 150 }} />
            <input type="month" value={win.to} onChange={(e) => setWin({ ...win, to: e.target.value })} style={{ width: 150 }} />
            <button className="btn ghost small" onClick={exportCsv}>⤓ CSV</button>
          </div>
        </div>
        <div className="chart">
          {d.monthly.map((m) => (
            <div key={m.month} className="chart-col"
              title={`${m.month}: ${t('fact')} ${fmtMoney(m.totalMinor)} · ${t('plan')} ${fmtMoney(m.plannedMinor)}`}>
              <div className="chart-bar" style={{ height: `${Math.round((m.totalMinor / maxMonth) * 100)}%` }} />
              {/* the plan for that month, prorated across the budget's period */}
              {m.plannedMinor > 0 && (
                <div className="chart-plan" style={{ bottom: `${Math.min(100, Math.round((m.plannedMinor / maxMonth) * 100))}%` }} />
              )}
              <span className="chart-label">{m.month.slice(5)}</span>
            </div>
          ))}
        </div>
        <div className="hint" style={{ marginTop: 8 }}>{t('plan_line_hint')}</div>
      </div>

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
                    <td>{fmtMoney(p.amountMinor, p.currency)}</td>
                    <td>{fmtMoney(p.usedMinor, p.currency)} · {p.utilizationPct}%</td>
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
          <h3>{t('by_department')}</h3>
          {/* keyed off the PO's own department, so direct and catalog orders count too */}
          {d.byDepartment.length === 0 && <div className="hint">—</div>}
          {d.byDepartment.map((c) => (
            <div key={c.department} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <span>{c.department}</span><span>{fmtMoney(c.totalMinor)} · {c.poCount} PO</span>
              </div>
              <div className="budget-bar"><div className="budget-fill" style={{ width: `${Math.round((c.totalMinor / maxDep) * 100)}%` }} /></div>
            </div>
          ))}
        </div>
        <div className="card" style={{ flex: 1 }}>
          <h3>{t('by_category')}</h3>
          {d.byCategory.length === 0 && <div className="hint">—</div>}
          {d.byCategory.map((c) => (
            <div key={c.category} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <span>{c.category}</span><span>{fmtMoney(c.totalMinor)} · {c.poCount} PO</span>
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
                <tr key={s.name}><td>{s.name}</td><td>{fmtMoney(s.totalMinor)}</td><td>{s.poCount}</td></tr>
              ))}
              {d.topSuppliers.length === 0 && <tr><td colSpan={3} className="hint">—</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
