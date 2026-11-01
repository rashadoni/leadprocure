import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtMoney } from '../../api/client';
import { useI18n } from '../../i18n';
import { useDialogs } from '../../components/Dialogs';
import { PO_SUPPLIER_TRANSITIONS, SHIPMENT_STATUSES } from '@leadprocure/shared';
import Pager from '../../components/Pager';
import { Badge } from '../../components/Badge';
import { statusLabel } from '../../components/humanize';
import { Actions } from '../../components/Actions';
import { ListState, useLoad } from '../../components/ListState';

const PAGE_SIZE = 20;


// "Заказы в работе" — the supplier's delivery pipeline. Each PO advances through
// CONFIRMED → PACKED → SHIPPED → DELIVERED; transitions are validated by the DB seam.
export default function Orders() {
  const { t } = useI18n();
  const { notify, notifyError, ask } = useDialogs();
  const nav = useNavigate();
  const [page, setPage] = useState(1);

  const orderList = useLoad(
    () => api.get('/orders', { params: { page, pageSize: PAGE_SIZE } }).then((r) => r.data),
    [page], { items: [] as any[], total: 0 },
  );
  // A failed page change must not leave the PREVIOUS page's rows sitting under the new
  // page number: on failure the alert stands alone.
  const orders: any[] = orderList.failed ? [] : (orderList.data.items ?? []);
  const total: number = orderList.data.total ?? 0;
  const load = () => orderList.reload();

  const [ship, setShip] = useState<Record<string, any>>({});

  const advance = async (id: string, next: string) => {
    try { await api.post(`/orders/${id}/status`, { status: next }); load(); }
    catch (e: any) { notifyError(e); }
  };

  const submitInvoice = async (poId: string) => {
    try {
      const [{ data: po }, { data: rec }] = await Promise.all([
        api.get(`/orders/${poId}`), api.get(`/orders/${poId}/receipts`),
      ]);
      // Use the server's current received-minus-reserved balance. The submit
      // endpoint rechecks it under the PO lock if another invoice wins a race.
      const billable: Record<string, number> = Object.fromEntries(rec.summary.map((s: any) => [s.po_item_id, Number(s.billable)]));
      const items = po.items.filter((i:any) => billable[i.id] > 0).map((i: any) => ({
        poItemId: i.id,
        qty: billable[i.id],
        unitPriceMinor: Number(i.unit_price_minor),
      }));
      if (!items.length) { notify(t('invoice_no_billable'), 'info'); return; }
      await api.post(`/invoices/from-po/${poId}`, { items });
      nav('/supplier/invoices');
    } catch (e: any) { notifyError(e); }
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
    } catch (e: any) { notifyError(e); }
  };

  // All three used to reject unhandled: the shipment simply did not appear, or the
  // timeline did not move, with nothing said.
  const loadShip = async (poId: string) => {
    try {
      const r = await api.get(`/logistics/po/${poId}`);
      setShip((s) => ({ ...s, [poId]: r.data }));
    } catch (e: any) { notifyError(e); }
  };
  const startShipment = async (poId: string) => {
    const carrier = await ask({ title: t('carrier'), required: true, defaultValue: 'AzərPost' });
    if (carrier == null) return;
    const trackingNo = await ask({ title: t('tracking_no'), required: true,
      defaultValue: 'AZ' + Math.floor(Math.random() * 1e8) });
    if (trackingNo == null) return;
    try {
      await api.post(`/logistics/po/${poId}/shipment`, { carrier, trackingNo });
      await loadShip(poId);
    } catch (e: any) { notifyError(e); }
  };
  const addEvent = async (poId: string, status: string) => {
    // «Location for SHIPPED:» was English on all three languages, and the status came out
    // of the enum rather than out of the dictionary.
    const location = await ask({
      title: `${t('shipment_location')} — ${t(`st_${status}`)}`, label: t('shipment_location'),
      required: true, defaultValue: 'Baku',
    });
    if (location == null) return;
    try {
      await api.post(`/logistics/po/${poId}/events`, { status, location });
      await loadShip(poId);
      load();
    } catch (e: any) { notifyError(e); }
  };

  return (
    <>
      <h1>{t('my_orders')}</h1>
      <div className="card">
        <ListState of={orderList} empty={!orders.length} />
        <table>
          <thead><tr><th>#</th><th>{t('buyer_org')}</th><th className="num">{t('total')}</th><th>{t('status')}</th><th>{t('actions')}</th><th>{t('logistics')}</th></tr></thead>
          <tbody>
            {orders.map((p) => {
              const next = PO_SUPPLIER_TRANSITIONS[p.status];
              const s = ship[p.id];
              return (
                <tr key={p.id}>
                  <td className="nowrap">{p.po_no}</td>
                  <td>{p.buyer_name}</td>
                  <td className="num">{fmtMoney(p.total_minor, p.currency)}</td>
                  <td><Badge status={p.status} /></td>
                  <td>
                    <Actions>
                    {next && <button className="btn small" onClick={() => advance(p.id, next)}>→ {t(`po_act_${next}`)}</button>}
                    {['DELIVERED', 'ACCEPTED'].includes(p.status) && (
                      <button className="btn small ghost" onClick={() => submitInvoice(p.id)}>🧾 {t('invoice')}</button>
                    )}
                    {['ISSUED', 'CONFIRMED'].includes(p.status) && (
                      <button className="btn small ghost" onClick={() => loadAmends(p.id)}>✎ {t('amendments')}</button>
                    )}
                    </Actions>
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
                        <Actions>
                          <button className="btn small" onClick={() => decideAmend(p.id, a.id, true)}>✓ {t('accept')}</button>
                          <button className="btn small ghost" onClick={() => decideAmend(p.id, a.id, false)}>✕ {t('reject')}</button>
                        </Actions>
                      </div>
                    ))}
                  </td>
                  <td>
                    {/* was a bare 🚚 — an icon on its own does not say what pressing it does */}
                    {s === undefined && <button className="btn small ghost" data-tip={t('tip_logistics_open')} onClick={() => loadShip(p.id)}>🚚 {t('logistics')}</button>}
                    {s && !s.shipment && ['CONFIRMED', 'PACKED', 'SHIPPED'].includes(p.status) && (
                      <button className="btn small" onClick={() => startShipment(p.id)}>{t('create_shipment')}</button>
                    )}
                    {s && s.shipment && (
                      <div style={{ fontSize: 12 }}>
                        <b>{s.shipment.carrier}</b> · {s.shipment.tracking_no} · <Badge status={s.shipment.status} />
                        {/* `SHIPPED@Baku → CUSTOMS@Baku` — raw status codes joined by an
                            `@`, the one machine text left on this screen after PR #72 put
                            the rest of logistics into words. The dropdown right below it
                            already says the same statuses in the reader's language. */}
                        <div className="hint">{s.events.map((e: any) =>
                          [statusLabel(t, e.status), e.location].filter(Boolean).join(' · ')).join(' → ')}</div>
                        <select style={{ width: 150, marginTop: 4 }} value="" onChange={(e) => e.target.value && addEvent(p.id, e.target.value)}>
                          <option value="">+ {t('history')}…</option>
                          {/* The same rule the API enforces, and only that one: a
                              delivered shipment cannot become an undelivered one, which
                              was two clicks away here. Everything else stays offerable —
                              clearing customs twice or leaving a hub is ordinary freight. */}
                          {SHIPMENT_STATUSES
                            .filter((st) => s.shipment.status !== 'DELIVERED'
                              || st === 'DELIVERED' || st === 'EXCEPTION')
                            // the raw enum used to be the option's label, while the dialog
                            // it opens says the status in words
                            .map((st) => <option key={st} value={st}>{t(`st_${st}`)}</option>)}
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
