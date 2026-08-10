import { FormEvent, useEffect, useState } from 'react';
import { api, fmtDate, fmtMoney } from '../../api/client';
import { useAuth } from '../../auth/auth';
import { useI18n } from '../../i18n';

interface Budget {
  id: string;
  name: string;
  category: string;
  periodYear: number;
  departmentId: string | null;
  departmentCode: string | null;
  departmentName: string | null;
  periodType: 'YEAR' | 'QUARTER' | 'MONTH';
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  currency: string;
  amountMinor: number;
  committedMinor: number;
  actualMinor: number;
  usedMinor: number;
  remainingMinor: number;
  utilizationPct: number;
}

const THIS_YEAR = new Date().getFullYear();
const THIS_QUARTER = Math.floor(new Date().getMonth() / 3) + 1;
const THIS_MONTH = new Date().getMonth() + 1;
const empty = {
  name: '', category: '', departmentId: '', periodType: 'YEAR' as Budget['periodType'],
  periodYear: THIS_YEAR, periodQuarter: THIS_QUARTER, periodMonth: THIS_MONTH,
  amount: '', currency: 'AZN',
};

export default function Budgets() {
  const { t } = useI18n();
  const { session } = useAuth();
  const isAdmin = session?.org.role === 'BUYER_ADMIN';
  const [rows, setRows] = useState<Budget[]>([]);
  const [form, setForm] = useState({ ...empty });
  const [editId, setEditId] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const [deps, setDeps] = useState<any[]>([]);
  const [unbudgeted, setUnbudgeted] = useState<any[]>([]);
  const [policy, setPolicy] = useState<{ warnPct: number; blockPct: number | null; allowOverride: boolean } | null>(null);
  useEffect(() => { api.get('/departments').then((r) => setDeps(r.data)).catch(() => {}); }, []);
  useEffect(() => { api.get('/budgets/policy').then((r) => setPolicy(r.data)).catch(() => {}); }, []);

  const savePolicy = async (patch: Record<string, unknown>) => {
    try {
      const { data } = await api.put('/budgets/policy', { ...policy, ...patch });
      setPolicy(data);
    } catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  // Period + department filter over the list, all optional.
  const [filter, setFilter] = useState({ periodType: '', year: '', departmentId: '' });
  const load = () => {
    api.get('/budgets', {
      params: {
        ...(filter.periodType ? { periodType: filter.periodType } : {}),
        ...(filter.year ? { year: filter.year } : {}),
        ...(filter.departmentId ? { departmentId: filter.departmentId } : {}),
      },
    }).then((r) => setRows(r.data));
    // approved spend no budget covers — invisible in a per-budget table, so it gets its own panel
    api.get('/budgets/unbudgeted').then((r) => setUnbudgeted(r.data)).catch(() => setUnbudgeted([]));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filter.periodType, filter.year, filter.departmentId]);

  // Per-department rollup: what finance actually asked to see.
  const byDepartment = rows.reduce((acc: Record<string, any>, b) => {
    const key = b.departmentCode ?? '—';
    const cur = acc[key] ?? { code: key, amount: 0, committed: 0, actual: 0, currency: b.currency };
    cur.amount += b.amountMinor;
    cur.committed += b.committedMinor;
    cur.actual += b.actualMinor;
    acc[key] = cur;
    return acc;
  }, {});
  const depSummary = Object.values(byDepartment) as Array<{
    code: string; amount: number; committed: number; actual: number; currency: string;
  }>;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    const body = {
      name: form.name,
      category: form.category.trim() || '*',
      ...(form.departmentId ? { departmentId: form.departmentId } : {}),
      periodType: form.periodType,
      periodYear: Number(form.periodYear),
      ...(form.periodType === 'QUARTER' ? { periodQuarter: Number(form.periodQuarter) } : {}),
      ...(form.periodType === 'MONTH' ? { periodMonth: Number(form.periodMonth) } : {}),
      amountMinor: Math.round(Number(form.amount) * 100),
      currency: form.currency || 'AZN',
    };
    try {
      if (editId) await api.put(`/budgets/${editId}`, body);
      else await api.post('/budgets', body);
      setForm({ ...empty });
      setEditId(null);
      load();
    } catch (e: any) { setErr(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  const edit = (b: Budget) => {
    const month = Number(b.periodStart.slice(5, 7));
    setEditId(b.id);
    setForm({
      name: b.name,
      category: b.category === '*' ? '' : b.category,
      periodType: b.periodType,
      periodYear: Number(b.periodStart.slice(0, 4)),
      periodQuarter: Math.floor((month - 1) / 3) + 1,
      periodMonth: month,
      departmentId: b.departmentId ?? '',
      amount: String(b.amountMinor / 100),
      currency: b.currency,
    });
  };
  const remove = async (id: string) => {
    if (!confirm('Delete budget?')) return;
    await api.delete(`/budgets/${id}`); load();
  };

  return (
    <>
      <h1>{t('budgets')}</h1>
      {isAdmin && (
        <div className="card">
          <form onSubmit={submit} className="row" style={{ alignItems: 'flex-end' }}>
            <div><label>{t('name')}</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
            <div><label>{t('category')} </label>
              <input placeholder="*" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></div>
            <div><label>{t('department')}</label>
              {/* empty = org-wide ceiling; a department budget always wins over it */}
              <select value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })}>
                <option value="">{t('bud_org_wide')}</option>
                {deps.filter((d) => d.is_active || d.id === form.departmentId).map((d) => (
                  <option key={d.id} value={d.id}>{d.code}</option>
                ))}
              </select></div>
            <div><label>{t('period')}</label>
              <select value={form.periodType} onChange={(e) => setForm({ ...form, periodType: e.target.value as Budget['periodType'] })}>
                <option value="YEAR">{t('period_year')}</option>
                <option value="QUARTER">{t('period_quarter')}</option>
                <option value="MONTH">{t('period_month')}</option>
              </select></div>
            <div><label>{t('year')}</label>
              <input type="number" value={form.periodYear} onChange={(e) => setForm({ ...form, periodYear: Number(e.target.value) })} required /></div>
            {form.periodType === 'QUARTER' && (
              <div><label>{t('period_quarter')}</label>
                <select value={form.periodQuarter} onChange={(e) => setForm({ ...form, periodQuarter: Number(e.target.value) })}>
                  {[1, 2, 3, 4].map((qq) => <option key={qq} value={qq}>Q{qq}</option>)}
                </select></div>
            )}
            {form.periodType === 'MONTH' && (
              <div><label>{t('period_month')}</label>
                <select value={form.periodMonth} onChange={(e) => setForm({ ...form, periodMonth: Number(e.target.value) })}>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((mm) => (
                    <option key={mm} value={mm}>{String(mm).padStart(2, '0')}</option>
                  ))}
                </select></div>
            )}
            <div><label>{t('amount')} (AZN)</label>
              <input type="number" step="0.01" min={0} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required /></div>
            <div>
              <button className="btn">{editId ? t('save') : t('create')}</button>
              {editId && <button type="button" className="btn ghost" onClick={() => { setEditId(null); setForm({ ...empty }); }} style={{ marginLeft: 6 }}>✕</button>}
            </div>
          </form>
          {err && <div className="error">{err}</div>}
        </div>
      )}
      {isAdmin && policy && (
        <div className="card">
          <h3>{t('bud_thresholds')}</h3>
          <div className="hint" style={{ marginBottom: 10 }}>{t('bud_thresholds_hint')}</div>
          <div className="row" style={{ alignItems: 'flex-end', maxWidth: 760 }}>
            <div><label>{t('bud_warn_pct')}</label>
              <input type="number" min={1} max={1000} value={policy.warnPct}
                onChange={(e) => setPolicy({ ...policy, warnPct: Number(e.target.value) })}
                onBlur={(e) => savePolicy({ warnPct: Number(e.target.value) })} /></div>
            <div><label>{t('bud_block_pct')}</label>
              {/* empty = blocking off, which is the default: approvals never fail on budget */}
              <input type="number" min={1} max={1000} placeholder={t('bud_block_off')}
                value={policy.blockPct ?? ''}
                onChange={(e) => setPolicy({ ...policy, blockPct: e.target.value === '' ? null : Number(e.target.value) })}
                onBlur={(e) => savePolicy({ blockPct: e.target.value === '' ? null : Number(e.target.value) })} /></div>
            <div><label>{t('bud_allow_override')}</label>
              <select value={policy.allowOverride ? '1' : '0'}
                onChange={(e) => savePolicy({ allowOverride: e.target.value === '1' })}>
                <option value="1">{t('yes')}</option>
                <option value="0">{t('no')}</option>
              </select></div>
          </div>
        </div>
      )}

      {depSummary.length > 0 && (
        <div className="card">
          <h3>{t('bud_by_department')}</h3>
          <table>
            <thead><tr>
              <th>{t('department')}</th><th>{t('amount')}</th><th>{t('committed')}</th><th>{t('actual')}</th>
              <th>{t('remaining')}</th><th style={{ width: 180 }}>{t('utilization')}</th>
            </tr></thead>
            <tbody>
              {depSummary.map((d) => {
                const used = d.committed + d.actual;
                const pct = d.amount > 0 ? Math.round((used / d.amount) * 1000) / 10 : 0;
                const over = used > d.amount;
                return (
                  <tr key={d.code}>
                    <td><b>{d.code === '—' ? t('bud_org_wide') : d.code}</b></td>
                    <td>{fmtMoney(d.amount, d.currency)}</td>
                    <td>{fmtMoney(d.committed, d.currency)}</td>
                    <td>{fmtMoney(d.actual, d.currency)}</td>
                    <td className={over ? 'error' : ''}>{fmtMoney(d.amount - used, d.currency)}</td>
                    <td>
                      <div className="budget-bar">
                        <div className={`budget-fill ${over ? 'over' : ''}`} style={{ width: `${Math.min(100, pct)}%` }} />
                      </div>
                      <span className="hint">{pct}%{over ? ` · ${t('budget_over')}` : ''}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          <select value={filter.periodType} onChange={(e) => setFilter({ ...filter, periodType: e.target.value })} style={{ maxWidth: 200 }}>
            <option value="">{t('period_all')}</option>
            <option value="YEAR">{t('period_year')}</option>
            <option value="QUARTER">{t('period_quarter')}</option>
            <option value="MONTH">{t('period_month')}</option>
          </select>
          <input type="number" placeholder={t('year')} value={filter.year}
            onChange={(e) => setFilter({ ...filter, year: e.target.value })} style={{ maxWidth: 140 }} />
          <select value={filter.departmentId} onChange={(e) => setFilter({ ...filter, departmentId: e.target.value })} style={{ maxWidth: 220 }}>
            <option value="">{t('dep_all')}</option>
            {deps.map((d) => <option key={d.id} value={d.id}>{d.code}</option>)}
          </select>
        </div>
        <table>
          <thead><tr>
            <th>{t('name')}</th><th>{t('category')}</th><th>{t('department')}</th><th>{t('period')}</th>
            <th>{t('amount')}</th><th>{t('committed')}</th><th>{t('actual')}</th><th>{t('remaining')}</th>
            <th style={{ width: 180 }}>{t('utilization')}</th>{isAdmin && <th>{t('actions')}</th>}
          </tr></thead>
          <tbody>
            {rows.map((b) => {
              const over = b.remainingMinor < 0;
              return (
                <tr key={b.id}>
                  <td>{b.name}</td>
                  <td>{b.category === '*' ? '—' : b.category}</td>
                  <td data-tip={b.departmentName || undefined}>{b.departmentCode ?? t('bud_org_wide')}</td>
                  <td data-tip={`${b.periodStart} → ${b.periodEnd}`}>{b.periodLabel}</td>
                  <td>{fmtMoney(b.amountMinor, b.currency)}</td>
                  <td data-tip={t('committed_hint')}>{fmtMoney(b.committedMinor, b.currency)}</td>
                  <td data-tip={t('actual_hint')}>{fmtMoney(b.actualMinor, b.currency)}</td>
                  <td className={over ? 'error' : ''}>{fmtMoney(b.remainingMinor, b.currency)}</td>
                  <td>
                    <div className="budget-bar">
                      <div className={`budget-fill ${over ? 'over' : ''}`} style={{ width: `${Math.min(100, b.utilizationPct)}%` }} />
                    </div>
                    <span className="hint">{b.utilizationPct}%{over ? ` · ${t('budget_over')}` : ''}</span>
                  </td>
                  {isAdmin && (
                    <td>
                      <button className="btn small ghost" data-tip={t('tip_edit')} onClick={() => edit(b)}>✎</button>{' '}
                      <button className="btn small ghost" data-tip={t('tip_delete')} onClick={() => remove(b.id)}>🗑</button>
                    </td>
                  )}
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={isAdmin ? 10 : 9} className="hint">—</td></tr>}
          </tbody>
        </table>
      </div>

      {unbudgeted.length > 0 && (
        <div className="card">
          <h3>⚠ {t('bud_unbudgeted')}</h3>
          <div className="hint" style={{ marginBottom: 10 }}>{t('bud_unbudgeted_hint')}</div>
          <table>
            <thead><tr>
              <th>#</th><th>{t('title')}</th><th>{t('category')}</th><th>{t('department')}</th>
              <th>{t('date')}</th><th>{t('amount')}</th>
            </tr></thead>
            <tbody>
              {unbudgeted.map((u) => (
                <tr key={u.requestId}>
                  <td>{u.requestNo}</td>
                  <td>{u.title}</td>
                  <td>{u.category ?? '—'}</td>
                  <td>{u.departmentCode ?? '—'}</td>
                  <td className="hint">{fmtDate(u.approvedAt)}</td>
                  <td>{fmtMoney(u.amountMinor, u.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
