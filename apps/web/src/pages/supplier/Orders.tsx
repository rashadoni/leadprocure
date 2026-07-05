import { useEffect, useState } from 'react';
import { api, fmtMoney } from '../../api/client';
import { useI18n } from '../../i18n';
import { PO_SUPPLIER_TRANSITIONS } from '@leadprocure/shared';

// "Заказы в работе" — the supplier's delivery pipeline. Each PO advances through
// CONFIRMED → PACKED → SHIPPED → DELIVERED; transitions are validated by the DB seam.
export default function Orders() {
  const { t } = useI18n();
  const [orders, setOrders] = useState<any[]>([]);

  const load = () => api.get('/orders').then((r) => setOrders(r.data));
  useEffect(() => { load(); }, []);

  const advance = async (id: string, next: string) => {
    try { await api.post(`/orders/${id}/status`, { status: next }); load(); }
    catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  return (
    <>
      <h1>{t('my_orders')}</h1>
      <div className="card">
        <table>
          <thead><tr><th>#</th><th>{t('buyer_org')}</th><th>{t('total')}</th><th>{t('status')}</th><th>{t('actions')}</th></tr></thead>
          <tbody>
            {orders.map((p) => {
              const next = PO_SUPPLIER_TRANSITIONS[p.status];
              return (
                <tr key={p.id}>
                  <td>{p.po_no}</td>
                  <td>{p.buyer_name}</td>
                  <td>{fmtMoney(p.total_minor, p.currency)}</td>
                  <td><span className={`badge ${p.status}`}>{p.status}</span></td>
                  <td>{next && <button className="btn small" onClick={() => advance(p.id, next)}>→ {next}</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
