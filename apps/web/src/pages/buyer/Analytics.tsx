import { useEffect, useState } from 'react';
import { api, fmtMoney } from '../../api/client';
import { useI18n } from '../../i18n';

interface Spend {
  monthly: { month: string; totalMinor: number }[];
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
  // Budget pace lives behind the controls.budgets feature; if it is off, the call fails and
  // the card simply doesn't render — the rest of the page is unaffected.
  const [pace, setPace] = useState<Pace[]>([]);
  useEffect(() => { api.get('/dashboard/spend-analytics').then((r) => setD(r.data)); }, []);
  useEffect(() => {
    api.get('/budgets/rollup', { params: { current: 1 } })
      .then((r) => setPace(r.data)).catch(() => setPace([]));
  }, []);
  if (!d) return <><h1>{t('analytics')}</h1><div className="center">…</div></>;

  const maxMonth = Math.max(1, ...d.monthly.map((m) => m.totalMinor));
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
        <h3>{t('monthly_spend')}</h3>
        <div className="chart">
          {d.monthly.map((m) => (
            <div key={m.month} className="chart-col" title={`${m.month}: ${fmtMoney(m.totalMinor)}`}>
              <div className="chart-bar" style={{ height: `${Math.round((m.totalMinor / maxMonth) * 100)}%` }} />
              <span className="chart-label">{m.month.slice(5)}</span>
            </div>
          ))}
        </div>
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
