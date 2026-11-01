import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate, fmtMoney } from '../../api/client';
import { useAuth } from '../../auth/auth';
import { useI18n } from '../../i18n';
import { useDialogs } from '../../components/Dialogs';
import { PO_BUYER_NEXT } from '@leadprocure/shared';
import Pager from '../../components/Pager';
import { Badge } from '../../components/Badge';
import { Actions } from '../../components/Actions';
import { ListState, useLoad } from '../../components/ListState';

const PAGE_SIZE = 20;

// Of the transitions the API offers a buyer, these two end the order rather than move it
// along. They are the destructive slot of the action cell, wherever the enum lists them.
const STOP_PO = new Set(['CANCELLED', 'REJECTED']);

export default function Contracts() {
  const { t } = useI18n();
  const { notify, notifyError } = useDialogs();
  const { session } = useAuth();
  const [cPage, setCPage] = useState(1);
  const [oPage, setOPage] = useState(1);
  const isBuyerSide = session?.org.kind !== 'SUPPLIER';

  const contractList = useLoad(
    () => api.get('/contracts', { params: { page: cPage, pageSize: PAGE_SIZE } }).then((r) => r.data),
    [cPage], { items: [] as any[], total: 0 },
  );
  const orderList = useLoad(
    () => api.get('/orders', { params: { page: oPage, pageSize: PAGE_SIZE } }).then((r) => r.data),
    [oPage], { items: [] as any[], total: 0 },
  );
  // A failed page change must not leave the PREVIOUS page's rows sitting under the new
  // page number: on failure the alert stands alone.
  const contracts: any[] = contractList.failed ? [] : (contractList.data.items ?? []);
  const orders: any[] = orderList.failed ? [] : (orderList.data.items ?? []);
  const cTotal: number = contractList.data.total ?? 0;
  const oTotal: number = orderList.data.total ?? 0;
  const load = () => { contractList.reload(); orderList.reload(); };

  // Every action here succeeds silently, and two of them put their result on a DIFFERENT
  // screen — a catalog lands in Catalogs, a new PO lands paginated at the bottom. Nothing on
  // the row changes, so a working button reads as a dead one. `note` says what happened, and
  // links to wherever the result went.
  const [note, setNote] = useState<{ text: string; to?: string; toLabel?: string } | null>(null);
  const act = async (fn: () => Promise<any>, done?: (res: any) => { text: string; to?: string; toLabel?: string }) => {
    try {
      const res = await fn();
      load();
      setNote(done ? done(res) : null);
    } catch (e: any) { notifyError(e); }
  };

  // PO amendment (change order): buyer proposes new qty/price per line + reason.
  const [amendFor, setAmendFor] = useState<string | null>(null);
  const [amendItems, setAmendItems] = useState<any[]>([]);
  const [amendVals, setAmendVals] = useState<Record<string, { qty: string; price: string }>>({});
  const [amendReason, setAmendReason] = useState('');

  const openAmend = async (poId: string) => {
    const { data } = await api.get(`/orders/${poId}`);
    setAmendItems(data.items); setAmendVals({}); setAmendReason('');
    setAmendFor(poId);
  };
  const submitAmend = async () => {
    const items = amendItems
      .map((i) => {
        const v = amendVals[i.id];
        if (!v) return null;
        const out: any = { poItemId: i.id };
        if (v.qty !== '' && v.qty !== undefined && Number(v.qty) !== Number(i.qty)) out.qty = Number(v.qty);
        if (v.price !== '' && v.price !== undefined && Math.round(Number(v.price) * 100) !== Number(i.unit_price_minor)) {
          out.unitPriceMinor = Math.round(Number(v.price) * 100);
        }
        return out.qty !== undefined || out.unitPriceMinor !== undefined ? out : null;
      })
      .filter(Boolean);
    if (!items.length) { notify(t('no_items'), 'info'); return; }
    await act(() => api.post(`/orders/${amendFor}/amendments`, { reason: amendReason, items }), () => ({ text: t('note_amend_sent') }));
    setAmendFor(null);
  };

  // Receive all outstanding quantities (partial receipts are supported by the API).
  const receiveAll = async (poId: string) => {
    const { data } = await api.get(`/orders/${poId}/receipts`);
    const remaining = data.summary
      .filter((s: any) => Number(s.received) < Number(s.ordered))
      .map((s: any) => ({ poItemId: s.po_item_id, qty: Number(s.ordered) - Number(s.received) }));
    if (!remaining.length) { notify(t('nothing_to_receive'), 'info'); return; }
    await act(() => api.post(`/orders/${poId}/receipts`, { items: remaining }), () => ({ text: t('note_received') }));
  };

  return (
    <>
      <h1>{t('contracts')}</h1>
      {note && (
        <div className="card note-ok">
          ✓ {note.text}
          {note.to && <> · <Link to={note.to}>{note.toLabel} →</Link></>}
          <button className="btn small ghost" style={{ float: 'right' }} onClick={() => setNote(null)}>✕</button>
        </div>
      )}
      <div className="card">
        <ListState of={contractList} empty={!contracts.length} />
        <table>
          <thead><tr><th>#</th><th>{t('title')}</th><th>{isBuyerSide ? t('supplier_org') : t('buyer_org')}</th><th className="nowrap">{t('validity')}</th><th className="num">{t('total')}</th><th className="num">{t('drawn')}</th><th>{t('status')}</th><th className="num">{t('orders_n')}</th><th>{t('actions')}</th></tr></thead>
          <tbody>
            {contracts.map((c) => {
              const over = Number(c.drawn_minor) > Number(c.total_minor);
              return (
              <tr key={c.id}>
                <td className="nowrap">{c.contract_no}</td>
                <td>{c.title}</td>
                <td>{isBuyerSide ? c.supplier_name : c.buyer_name}</td>
                <td className="hint nowrap">{fmtDate(c.valid_from)} – {fmtDate(c.valid_to)}</td>
                <td className="num">{fmtMoney(c.total_minor, c.currency)}</td>
                <td className="num" style={over ? { color: 'var(--bad, #e5484d)' } : undefined}
                    title={over ? t('over_ceiling') : undefined}>
                  {fmtMoney(c.drawn_minor, c.currency)}{over ? ' ⚠' : ''}
                </td>
                <td><Badge status={c.status} /></td>
                <td className="num">{c.po_count}</td>
                <td>
                  <Actions>
                    {isBuyerSide && c.status === 'DRAFT' && (
                      <button className="btn small" data-tip={t('tip_activate')} onClick={() => act(() => api.post(`/contracts/${c.id}/activate`), () => ({ text: t('note_activated') }))}>{t('activate')}</button>
                    )}
                    {isBuyerSide && c.status === 'ACTIVE' && (
                      <>
                        <button className="btn small" data-tip={t('tip_create_po')} onClick={() => act(() => api.post(`/contracts/${c.id}/orders`), (r) => ({ text: `${t('note_po_made')}: ${r.data.po_no}` }))}>{t('create_po')}</button>
                        <button className="btn small ghost" data-tip={t('tip_catalog_from')} onClick={() => act(() => api.post(`/catalogs/from-contract/${c.id}`), () => ({ text: t('note_catalog_made'), to: '/buyer/catalogs', toLabel: t('catalogs') }))}>📖 {t('catalogs')}</button>
                      </>
                    )}
                  </Actions>
                </td>
              </tr>
            );})}
          </tbody>
        </table>
        <Pager total={cTotal} page={cPage} pageSize={PAGE_SIZE} onPage={setCPage} />
      </div>

      <h1>{t('orders')}</h1>
      <div className="card">
        <ListState of={orderList} empty={!orders.length} />
        <table>
          <thead><tr><th>#</th><th>{isBuyerSide ? t('supplier_org') : t('buyer_org')}</th><th className="nowrap">{t('date')}</th><th className="num">{t('total')}</th><th>{t('status')}</th><th>{t('actions')}</th></tr></thead>
          <tbody>
            {orders.map((p) => (
              <tr key={p.id}>
                <td className="nowrap">{p.po_no}</td>
                <td>{isBuyerSide ? p.supplier_name : p.buyer_name}</td>
                <td className="hint nowrap">{fmtDate(p.created_at)}</td>
                <td className="num">{fmtMoney(p.total_minor, p.currency)}</td>
                <td><Badge status={p.status} /></td>
                <td>
                  {/* Stopping an order is the destructive end of the same status list, so it
                      is split out rather than sitting first because the enum happened to
                      list it first. */}
                  <Actions
                    danger={isBuyerSide && (PO_BUYER_NEXT[p.status] ?? []).filter((n) => STOP_PO.has(n)).map((next) => (
                      <button key={next} className="btn small ghost danger"
                        onClick={() => act(() => api.post(`/orders/${p.id}/status`, { status: next }))}>
                        {t(`po_act_${next}`)}
                      </button>
                    ))}
                  >
                    {isBuyerSide && (PO_BUYER_NEXT[p.status] ?? []).filter((n) => !STOP_PO.has(n)).map((next) => (
                      <button key={next} className="btn small"
                        onClick={() => act(() => api.post(`/orders/${p.id}/status`, { status: next }))}>
                        {t(`po_act_${next}`)}
                      </button>
                    ))}
                    {isBuyerSide && ['SHIPPED', 'DELIVERED'].includes(p.status) && (
                      <button className="btn small" data-tip={t('tip_receive')} onClick={() => receiveAll(p.id)}>📥 {t('receive')}</button>
                    )}
                    {isBuyerSide && ['ISSUED', 'CONFIRMED'].includes(p.status) && (
                      <button className="btn small ghost" data-tip={t('tip_amend')} onClick={() => openAmend(p.id)}>✎ {t('amend')}</button>
                    )}
                  </Actions>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager total={oTotal} page={oPage} pageSize={PAGE_SIZE} onPage={setOPage} />
      </div>

      {amendFor && (
        <div className="card">
          <h3>✎ {t('amendments')}</h3>
          <table>
            <thead><tr><th>{t('name')}</th><th>{t('qty')}</th><th>{t('unit_price')} (AZN)</th></tr></thead>
            <tbody>
              {amendItems.map((i) => (
                <tr key={i.id}>
                  <td>{i.name}</td>
                  <td><input type="number" min={1} style={{ width: 90 }} placeholder={String(i.qty)}
                    value={amendVals[i.id]?.qty ?? ''}
                    onChange={(e) => setAmendVals({ ...amendVals, [i.id]: { qty: e.target.value, price: amendVals[i.id]?.price ?? '' } })} /></td>
                  <td><input type="number" step="0.01" min={0} style={{ width: 120 }}
                    placeholder={(Number(i.unit_price_minor) / 100).toFixed(2)}
                    value={amendVals[i.id]?.price ?? ''}
                    onChange={(e) => setAmendVals({ ...amendVals, [i.id]: { qty: amendVals[i.id]?.qty ?? '', price: e.target.value } })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 10 }}>
            <div style={{ flex: 1 }}><label>{t('reason')}</label>
              <input value={amendReason} onChange={(e) => setAmendReason(e.target.value)} /></div>
            <button className="btn" disabled={amendReason.trim().length < 3} onClick={submitAmend}>{t('send')}</button>
            <button className="btn ghost" onClick={() => setAmendFor(null)}>✕</button>
          </div>
        </div>
      )}
    </>
  );
}
