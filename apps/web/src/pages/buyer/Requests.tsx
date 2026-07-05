import { FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtMoney } from '../../api/client';
import { useAuth } from '../../auth/auth';
import { useI18n } from '../../i18n';

interface Item { name: string; qty: number; price: string }

export default function Requests() {
  const { t } = useI18n();
  const { session } = useAuth();
  const nav = useNavigate();
  const [rows, setRows] = useState<any[]>([]);
  const [title, setTitle] = useState('');
  const [items, setItems] = useState<Item[]>([{ name: '', qty: 1, price: '' }]);
  const [err, setErr] = useState('');
  const canApprove = ['BUYER_ADMIN', 'BUYER_APPROVER'].includes(session?.org.role ?? '');

  const load = () => api.get('/requests').then((r) => setRows(r.data));
  useEffect(() => { load(); }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      await api.post('/requests', {
        title,
        items: items
          .filter((i) => i.name)
          .map((i) => ({ name: i.name, qty: Number(i.qty), estUnitPriceMinor: Math.round(Number(i.price) * 100) })),
      });
      setTitle('');
      setItems([{ name: '', qty: 1, price: '' }]);
      load();
    } catch (e: any) { setErr(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  const act = async (id: string, action: string) => {
    try { await api.post(`/requests/${id}/${action}`); load(); }
    catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  const makeRfq = async (id: string) => {
    try {
      const closeAt = new Date(Date.now() + 24 * 3600_000).toISOString();
      const ev = await api.post(`/events/from-request/${id}`, { closeAt, visibility: 'INVITED' });
      nav(`/buyer/events/${ev.data.id}`);
    } catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  // Reverse auction: start at the estimate, min decrement = 1% (floor 1 AZN).
  const makeAuction = async (r: any) => {
    try {
      const start = Number(r.estimated_total_minor);
      const ev = await api.post(`/events/reverse/from-request/${r.id}`, {
        closeAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
        visibility: 'INVITED',
        startPriceMinor: start,
        minDecrementMinor: Math.max(Math.round(start / 100), 100),
      });
      nav(`/buyer/events/${ev.data.id}`);
    } catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  return (
    <>
      <h1>{t('requests')}</h1>
      <div className="card">
        <form onSubmit={create}>
          <label>{t('title')}</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} required />
          <h3>{t('items')}</h3>
          {items.map((it, idx) => (
            <div className="row" key={idx}>
              <div><label>{t('name')}</label>
                <input value={it.name} onChange={(e) => setItems(items.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x)))} /></div>
              <div><label>{t('qty')}</label>
                <input type="number" min={1} value={it.qty} onChange={(e) => setItems(items.map((x, i) => (i === idx ? { ...x, qty: Number(e.target.value) } : x)))} /></div>
              <div><label>{t('unit_price')} (AZN)</label>
                <input type="number" step="0.01" min={0} value={it.price} onChange={(e) => setItems(items.map((x, i) => (i === idx ? { ...x, price: e.target.value } : x)))} /></div>
            </div>
          ))}
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button type="button" className="btn ghost small" onClick={() => setItems([...items, { name: '', qty: 1, price: '' }])}>+ {t('items')}</button>
            <button className="btn">{t('create')}</button>
          </div>
          {err && <div className="error">{err}</div>}
        </form>
      </div>
      <div className="card">
        <table>
          <thead><tr><th>#</th><th>{t('title')}</th><th>{t('total')}</th><th>{t('status')}</th><th>Method</th><th>{t('actions')}</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.request_no}</td>
                <td>{r.title}</td>
                <td>{fmtMoney(r.estimated_total_minor, r.currency)}</td>
                <td><span className={`badge ${r.status}`}>{r.status}</span></td>
                <td>{r.method_resolved ?? '—'}</td>
                <td>
                  {r.status === 'DRAFT' && <button className="btn small" onClick={() => act(r.id, 'submit')}>{t('submit')}</button>}{' '}
                  {r.status === 'SUBMITTED' && canApprove && (
                    <>
                      <button className="btn small" onClick={() => act(r.id, 'approve')}>{t('approve')}</button>{' '}
                      <button className="btn small ghost" onClick={() => act(r.id, 'reject')}>{t('reject')}</button>
                    </>
                  )}
                  {r.status === 'APPROVED' && r.method_resolved !== 'DIRECT' && canApprove && (
                    <>
                      <button className="btn small" onClick={() => makeRfq(r.id)}>RFQ 🔒</button>{' '}
                      <button className="btn small ghost" onClick={() => makeAuction(r)}>{t('auction')} ⚡</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
