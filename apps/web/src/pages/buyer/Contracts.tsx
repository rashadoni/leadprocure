import { useEffect, useState } from 'react';
import { api, fmtMoney } from '../../api/client';
import { useAuth } from '../../auth/auth';
import { useI18n } from '../../i18n';
import { PO_BUYER_NEXT } from '@leadprocure/shared';

export default function Contracts() {
  const { t } = useI18n();
  const { session } = useAuth();
  const [contracts, setContracts] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const isBuyerSide = session?.org.kind !== 'SUPPLIER';

  const load = () => {
    api.get('/contracts').then((r) => setContracts(r.data));
    api.get('/orders').then((r) => setOrders(r.data));
  };
  useEffect(load, []);

  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); load(); } catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  // Receive all outstanding quantities (partial receipts are supported by the API).
  const receiveAll = async (poId: string) => {
    const { data } = await api.get(`/orders/${poId}/receipts`);
    const remaining = data.summary
      .filter((s: any) => Number(s.received) < Number(s.ordered))
      .map((s: any) => ({ poItemId: s.po_item_id, qty: Number(s.ordered) - Number(s.received) }));
    if (!remaining.length) { alert('Nothing left to receive'); return; }
    await act(() => api.post(`/orders/${poId}/receipts`, { items: remaining }));
  };

  return (
    <>
      <h1>{t('contracts')}</h1>
      <div className="card">
        <table>
          <thead><tr><th>#</th><th>{t('title')}</th><th>{isBuyerSide ? t('supplier_org') : t('buyer_org')}</th><th>{t('total')}</th><th>{t('status')}</th><th>PO</th><th>{t('actions')}</th></tr></thead>
          <tbody>
            {contracts.map((c) => (
              <tr key={c.id}>
                <td>{c.contract_no}</td>
                <td>{c.title}</td>
                <td>{isBuyerSide ? c.supplier_name : c.buyer_name}</td>
                <td>{fmtMoney(c.total_minor, c.currency)}</td>
                <td><span className={`badge ${c.status}`}>{c.status}</span></td>
                <td>{c.po_count}</td>
                <td>
                  {isBuyerSide && c.status === 'DRAFT' && (
                    <button className="btn small" onClick={() => act(() => api.post(`/contracts/${c.id}/activate`))}>{t('activate')}</button>
                  )}{' '}
                  {isBuyerSide && c.status === 'ACTIVE' && (
                    <>
                      <button className="btn small" onClick={() => act(() => api.post(`/contracts/${c.id}/orders`))}>{t('create_po')}</button>{' '}
                      <button className="btn small ghost" onClick={() => act(() => api.post(`/catalogs/from-contract/${c.id}`))}>📖 {t('catalogs')}</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h1>{t('orders')}</h1>
      <div className="card">
        <table>
          <thead><tr><th>#</th><th>{isBuyerSide ? t('supplier_org') : t('buyer_org')}</th><th>{t('total')}</th><th>{t('status')}</th><th>{t('actions')}</th></tr></thead>
          <tbody>
            {orders.map((p) => (
              <tr key={p.id}>
                <td>{p.po_no}</td>
                <td>{isBuyerSide ? p.supplier_name : p.buyer_name}</td>
                <td>{fmtMoney(p.total_minor, p.currency)}</td>
                <td><span className={`badge ${p.status}`}>{p.status}</span></td>
                <td>
                  {isBuyerSide && (PO_BUYER_NEXT[p.status] ?? []).map((next) => (
                    <button key={next} className={`btn small ${next === 'CANCELLED' || next === 'REJECTED' ? 'ghost' : ''}`}
                      onClick={() => act(() => api.post(`/orders/${p.id}/status`, { status: next }))}>
                      {next}
                    </button>
                  ))}{' '}
                  {isBuyerSide && ['SHIPPED', 'DELIVERED'].includes(p.status) && (
                    <button className="btn small" onClick={() => receiveAll(p.id)}>{t('receive')} 📥</button>
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
