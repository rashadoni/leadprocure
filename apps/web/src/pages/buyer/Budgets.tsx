import { FormEvent, useEffect, useState } from 'react';
import { api, fmtMoney } from '../../api/client';
import { useAuth } from '../../auth/auth';
import { useI18n } from '../../i18n';

interface Budget {
  id: string;
  name: string;
  category: string;
  periodYear: number;
  periodType: 'YEAR' | 'QUARTER' | 'MONTH';
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  currency: string;
  amountMinor: number;
  committedMinor: number;
  remainingMinor: number;
  utilizationPct: number;
}

const THIS_YEAR = new Date().getFullYear();
const THIS_QUARTER = Math.floor(new Date().getMonth() / 3) + 1;
const THIS_MONTH = new Date().getMonth() + 1;
const empty = {
  name: '', category: '', periodType: 'YEAR' as Budget['periodType'], periodYear: THIS_YEAR,
  periodQuarter: THIS_QUARTER, periodMonth: THIS_MONTH, amount: '', currency: 'AZN',
};

export default function Budgets() {
  const { t } = useI18n();
  const { session } = useAuth();
  const isAdmin = session?.org.role === 'BUYER_ADMIN';
  const [rows, setRows] = useState<Budget[]>([]);
  const [form, setForm] = useState({ ...empty });
  const [editId, setEditId] = useState<string | null>(null);
  const [err, setErr] = useState('');

  // Period filter over the list: type + year, both optional.
  const [filter, setFilter] = useState({ periodType: '', year: '' });
  const load = () => api.get('/budgets', {
    params: {
      ...(filter.periodType ? { periodType: filter.periodType } : {}),
      ...(filter.year ? { year: filter.year } : {}),
    },
  }).then((r) => setRows(r.data));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filter.periodType, filter.year]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    const body = {
      name: form.name,
      category: form.category.trim() || '*',
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
        </div>
        <table>
          <thead><tr>
            <th>{t('name')}</th><th>{t('category')}</th><th>{t('period')}</th>
            <th>{t('amount')}</th><th>{t('committed')}</th><th>{t('remaining')}</th>
            <th style={{ width: 180 }}>{t('utilization')}</th>{isAdmin && <th>{t('actions')}</th>}
          </tr></thead>
          <tbody>
            {rows.map((b) => {
              const over = b.remainingMinor < 0;
              return (
                <tr key={b.id}>
                  <td>{b.name}</td>
                  <td>{b.category === '*' ? '—' : b.category}</td>
                  <td data-tip={`${b.periodStart} → ${b.periodEnd}`}>{b.periodLabel}</td>
                  <td>{fmtMoney(b.amountMinor, b.currency)}</td>
                  <td>{fmtMoney(b.committedMinor, b.currency)}</td>
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
            {rows.length === 0 && <tr><td colSpan={isAdmin ? 8 : 7} className="hint">—</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
