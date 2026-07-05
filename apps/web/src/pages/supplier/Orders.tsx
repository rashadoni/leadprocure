import { useEffect, useState } from 'react';
import { api, fmtMoney } from '../../api/client';
import { useI18n } from '../../i18n';
import { PO_SUPPLIER_TRANSITIONS, SHIPMENT_STATUSES } from '@leadprocure/shared';

// "Заказы в работе" — the supplier's delivery pipeline. Each PO advances through
// CONFIRMED → PACKED → SHIPPED → DELIVERED; transitions are validated by the DB seam.
export default function Orders() {
  const { t } = useI18n();
  const [orders, setOrders] = useState<any[]>([]);

  const load = () => api.get('/orders').then((r) => setOrders(r.data));
  useEffect(() => { load(); }, []);

  const [ship, setShip] = useState<Record<string, any>>({});

  const advance = async (id: string, next: string) => {
    try { await api.post(`/orders/${id}/status`, { status: next }); load(); }
    catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  const loadShip = async (poId: string) => {
    const r = await api.get(`/logistics/po/${poId}`);
    setShip((s) => ({ ...s, [poId]: r.data }));
  };
  const startShipment = async (poId: string) => {
    const carrier = prompt('Carrier (перевозчик):', 'AzərPost');
    if (carrier == null) return;
    const trackingNo = prompt('Tracking № (трек-номер):', 'AZ' + Math.floor(Math.random() * 1e8));
    await api.post(`/logistics/po/${poId}/shipment`, { carrier, trackingNo });
    loadShip(poId);
  };
  const addEvent = async (poId: string, status: string) => {
    const location = prompt(`Location for ${status}:`, 'Baku');
    if (location == null) return;
    await api.post(`/logistics/po/${poId}/events`, { status, location });
    loadShip(poId); load();
  };

  return (
    <>
      <h1>{t('my_orders')}</h1>
      <div className="card">
        <table>
          <thead><tr><th>#</th><th>{t('buyer_org')}</th><th>{t('total')}</th><th>{t('status')}</th><th>{t('actions')}</th><th>{t('logistics')}</th></tr></thead>
          <tbody>
            {orders.map((p) => {
              const next = PO_SUPPLIER_TRANSITIONS[p.status];
              const s = ship[p.id];
              return (
                <tr key={p.id}>
                  <td>{p.po_no}</td>
                  <td>{p.buyer_name}</td>
                  <td>{fmtMoney(p.total_minor, p.currency)}</td>
                  <td><span className={`badge ${p.status}`}>{p.status}</span></td>
                  <td>{next && <button className="btn small" onClick={() => advance(p.id, next)}>→ {next}</button>}</td>
                  <td>
                    {s === undefined && <button className="btn small ghost" onClick={() => loadShip(p.id)}>🚚</button>}
                    {s && !s.shipment && ['CONFIRMED', 'PACKED', 'SHIPPED'].includes(p.status) && (
                      <button className="btn small" onClick={() => startShipment(p.id)}>{t('create_shipment')}</button>
                    )}
                    {s && s.shipment && (
                      <div style={{ fontSize: 12 }}>
                        <b>{s.shipment.carrier}</b> · {s.shipment.tracking_no} · <span className={`badge ${s.shipment.status}`}>{s.shipment.status}</span>
                        <div className="hint">{s.events.map((e: any) => `${e.status}@${e.location ?? '—'}`).join(' → ')}</div>
                        <select style={{ width: 150, marginTop: 4 }} value="" onChange={(e) => e.target.value && addEvent(p.id, e.target.value)}>
                          <option value="">+ {t('history')}…</option>
                          {SHIPMENT_STATUSES.map((st) => <option key={st} value={st}>{st}</option>)}
                        </select>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
