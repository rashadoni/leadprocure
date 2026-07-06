import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtMoney } from '../../api/client';
import { useI18n } from '../../i18n';
import { PO_SUPPLIER_TRANSITIONS, SHIPMENT_STATUSES } from '@leadprocure/shared';
import Pager from '../../components/Pager';
import { Badge } from '../../components/Badge';

const PAGE_SIZE = 20;

// "Заказы в работе" — the supplier's delivery pipeline. Each PO advances through
// CONFIRMED → PACKED → SHIPPED → DELIVERED; transitions are validated by the DB seam.
export default function Orders() {
  const { t } = useI18n();
  const nav = useNavigate();
  const [orders, setOrders] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  const load = () => api.get('/orders', { params: { page, pageSize: PAGE_SIZE } })
    .then((r) => { setOrders(r.data.items); setTotal(r.data.total); });
  useEffect(() => { load(); }, [page]);

  const [ship, setShip] = useState<Record<string, any>>({});

  const advance = async (id: string, next: string) => {
    try { await api.post(`/orders/${id}/status`, { status: next }); load(); }
    catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  const submitInvoice = async (poId: string) => {
    try {
      const [{ data: po }, { data: rec }] = await Promise.all([
        api.get(`/orders/${poId}`), api.get(`/orders/${poId}/receipts`),
      ]);
      const received: Record<string, number> = Object.fromEntries(rec.summary.map((s: any) => [s.po_item_id, Number(s.received)]));
      const items = po.items.map((i: any) => ({
        poItemId: i.id,
        qty: received[i.id] > 0 ? received[i.id] : Number(i.qty),
        unitPriceMinor: Number(i.unit_price_minor),
      }));
      await api.post(`/invoices/from-po/${poId}`, { items });
      nav('/supplier/invoices');
    } catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  // Pending amendments (change orders) proposed by the buyer — supplier decides.
  const [amends, setAmends] = useState<Record<string, any[]>>({});
  const loadAmends = async (poId: string) => {
    const r = await api.get(`/orders/${poId}/amendments`);
    setAmends((s) => ({ ...s, [poId]: r.data }));
  };
  const decideAmend = async (poId: string, amendmentId: string, accept: boolean) => {
    try {
      await api.post(`/orders/${poId}/amendments/${amendmentId}/decision`, { accept });
      await loadAmends(poId); load();
    } catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
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
                  <td><Badge status={p.status} /></td>
                  <td>
                    {next && <button className="btn small" onClick={() => advance(p.id, next)}>→ {next}</button>}{' '}
                    {['DELIVERED', 'ACCEPTED'].includes(p.status) && (
                      <button className="btn small ghost" onClick={() => submitInvoice(p.id)}>🧾 {t('invoice')}</button>
                    )}{' '}
                    {['ISSUED', 'CONFIRMED'].includes(p.status) && (
                      <button className="btn small ghost" onClick={() => loadAmends(p.id)}>✎ {t('amendments')}</button>
                    )}
                    {(amends[p.id] ?? []).filter((a) => a.status === 'PROPOSED').map((a) => (
                      <div key={a.id} className="card" style={{ marginTop: 8, padding: 10 }}>
                        <div className="hint">✎ {t('amendments')} #{a.amendment_no} · {a.reason}</div>
                        {a.changes.map((c: any) => (
                          <div key={c.poItemId} style={{ fontSize: 12, margin: '4px 0' }}>
                            {c.name}: {c.oldQty} → <b>{c.newQty}</b> × {fmtMoney(c.oldUnitPriceMinor)} → <b>{fmtMoney(c.newUnitPriceMinor)}</b>
                          </div>
                        ))}
                        <div style={{ fontSize: 12, marginBottom: 6 }}>
                          {t('total')}: {fmtMoney(a.old_total_minor)} → <b>{fmtMoney(a.new_total_minor)}</b>
                        </div>
                        <button className="btn small" onClick={() => decideAmend(p.id, a.id, true)}>✓ {t('accept')}</button>{' '}
                        <button className="btn small ghost" onClick={() => decideAmend(p.id, a.id, false)}>✕ {t('reject')}</button>
                      </div>
                    ))}
                  </td>
                  <td>
                    {s === undefined && <button className="btn small ghost" title={t('logistics')} onClick={() => loadShip(p.id)}>🚚</button>}
                    {s && !s.shipment && ['CONFIRMED', 'PACKED', 'SHIPPED'].includes(p.status) && (
                      <button className="btn small" onClick={() => startShipment(p.id)}>{t('create_shipment')}</button>
                    )}
                    {s && s.shipment && (
                      <div style={{ fontSize: 12 }}>
                        <b>{s.shipment.carrier}</b> · {s.shipment.tracking_no} · <Badge status={s.shipment.status} />
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
        <Pager total={total} page={page} pageSize={PAGE_SIZE} onPage={setPage} />
      </div>
    </>
  );
}
