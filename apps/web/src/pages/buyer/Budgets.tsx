import { FormEvent, useEffect, useState } from 'react';
import { api, fmtMoney } from '../../api/client';
import { useAuth } from '../../auth/auth';
import { useI18n } from '../../i18n';

interface Budget {
  id: string;
  name: string;
  category: string;
  periodYear: number;
  currency: string;
  amountMinor: number;
  committedMinor: number;
  remainingMinor: number;
  utilizationPct: number;
}

const THIS_YEAR = new Date().getFullYear();
const empty = { name: '', category: '', periodYear: THIS_YEAR, amount: '', currency: 'AZN' };

export default function Budgets() {
  const { t } = useI18n();
  const { session } = useAuth();
  const isAdmin = session?.org.role === 'BUYER_ADMIN';
  const [rows, setRows] = useState<Budget[]>([]);
  const [form, setForm] = useState({ ...empty });
  const [editId, setEditId] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const load = () => api.get('/budgets').then((r) => setRows(r.data));
  useEffect(() => { load(); }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    const body = {
      name: form.name,
      category: form.category.trim() || '*',
      periodYear: Number(form.periodYear),
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
    setEditId(b.id);
    setForm({ name: b.name, category: b.category === '*' ? '' : b.category, periodYear: b.periodYear, amount: String(b.amountMinor / 100), currency: b.currency });
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
            <div><label>{t('year')}</label>
              <input type="number" value={form.periodYear} onChange={(e) => setForm({ ...form, periodYear: Number(e.target.value) })} required /></div>
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
        <table>
          <thead><tr>
            <th>{t('name')}</th><th>{t('category')}</th><th>{t('year')}</th>
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
                  <td>{b.periodYear}</td>
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
