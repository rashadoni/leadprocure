import { Link, useParams } from 'react-router-dom';
import { api, fmtDate, fmtDateTime, fmtMoney } from '../api/client';
import { useI18n } from '../i18n';
import { useAuth } from '../auth/auth';
import { Badge } from '../components/Badge';
import { statusLabel, amendedQty, amendedPrice } from '../components/humanize';
import { ListState, useLoad } from '../components/ListState';

// The order's own page. Until it existed the PO number was printed in four places — the
// invoice ledger, the buyer's orders table, the logistics board, the supplier's pipeline —
// and led nowhere: there was no screen behind it. Two things were therefore not visible
// anywhere in the product at all, however long you looked: **what was actually ordered**
// (`purchase_order_items` was returned by the API and rendered by nobody) and **how the
// order got to its present status** (`po_status_history`, same). This page is where the
// number leads, and those two are its substance.
//
// One page for both sides, like Contracts: an order is one document with two readers, and
// the difference between what they see is decided by RLS and by the role, not by having two
// components drift apart. The buyer-only facts (the request that started it, the department
// it is charged to) come back NULL for the supplier from the policies themselves — see
// `getOrder` in contracts.module.ts.
//
// Read-only on purpose. Every action on an order — advancing status, receiving goods,
// invoicing, proposing and deciding amendments — already lives on the list it belongs to,
// with the state rules and the dialogs around it. Duplicating that here would mean two
// places to keep right, and the audit finding this page answers was «the number leads
// nowhere», not «the actions are hard to reach».
// The one place that knows where an order's page is. Four tables print the number and all
// four need the reader's own side in the path; spelling the ternary out in each of them is
// how one of them ends up pointing at the other party's route after a refactor.
export const orderHref = (isBuyerSide: boolean, poId: string) =>
  `${isBuyerSide ? '/buyer' : '/supplier'}/orders/${poId}`;

export default function OrderDetail() {
  const { id } = useParams();
  const { t } = useI18n();
  const { session } = useAuth();
  const isBuyerSide = session?.org.kind !== 'SUPPLIER';

  const order = useLoad(() => api.get(`/orders/${id}`).then((r) => r.data), [id], null as any);
  // Ordered / received / billable per line. The same endpoint the supplier's invoice button
  // uses, so the figures a reader sees here are the ones the invoice will be built from.
  const rec = useLoad(() => api.get(`/orders/${id}/receipts`).then((r) => r.data), [id],
    { summary: [] as any[], receipts: [] as any[] });
  const amends = useLoad(() => api.get(`/orders/${id}/amendments`).then((r) => r.data), [id], [] as any[]);
  // Logistics sits behind a licence feature and a role: a 403 here is «not for you», and
  // ListState keeps that one quiet (isDenied) instead of reporting a broken page.
  const ship = useLoad(() => api.get(`/logistics/po/${id}`).then((r) => r.data), [id], null as any);

  const po = order.data;
  // Until the order is here the page is a single line, and a failed load says so rather
  // than leaving a spinner that never resolves.
  if (!po) return <div className="card"><ListState of={order} /></div>;

  const received: Record<string, any> = Object.fromEntries((rec.data.summary ?? []).map((s: any) => [s.po_item_id, s]));
  const items: any[] = po.items ?? [];
  const history: any[] = po.history ?? [];
  const proposed = (amends.data ?? []).filter((a: any) => a.status === 'PROPOSED');
  const backTo = isBuyerSide ? '/buyer/contracts' : '/supplier/orders';

  return (
    <>
      {/* a reload that failed after the page was drawn: the figures below are stale */}
      <ListState of={[order, rec, amends]} />
      <h1>
        {po.po_no} <Badge status={po.status} />
      </h1>
      <div className="card">
        <div className="fact-row">
          {/* The counterparty, named as what it is to the reader — the buyer's order has a
              supplier on the other end and the supplier's has a buyer, and printing both
              would make the reader work out which one is themselves. */}
          <div className="fact">
            <span className="fact-k">{isBuyerSide ? t('supplier_org') : t('buyer_org')}</span>
            <span className="fact-v">{isBuyerSide ? po.supplier_name : po.buyer_name}</span>
          </div>
          <div className="fact">
            <span className="fact-k">{t('total')}</span>
            <span className="fact-v">{fmtMoney(po.total_minor, po.currency)}</span>
          </div>
          <div className="fact">
            <span className="fact-k">{t('po_created')}</span>
            <span className="fact-v">{fmtDate(po.created_at)}</span>
          </div>
          {po.issued_at && (
            <div className="fact">
              <span className="fact-k">{t('po_issued')}</span>
              <span className="fact-v">{fmtDate(po.issued_at)}</span>
            </div>
          )}
          {po.department_code && (
            <div className="fact">
              <span className="fact-k">{t('department')}</span>
              <span className="fact-v">{po.department_name || po.department_code}</span>
            </div>
          )}
        </div>

        {/* Where the order came from. A direct purchase and a catalogue call-off have no
            contract and no request behind them — that chain genuinely breaks, which is why
            `request_id` is denormalized on the order — so each line appears only when there
            is something to say. The tender is the one link with a page behind it; the
            contract and the request are named, not linked, because their screens are lists
            and a link into a list that cannot scroll to the row is a worse answer than
            plain text. */}
        {(po.contract_no || po.request_no) && (
          <div className="fact-row" style={{ marginTop: 12 }}>
            {po.contract_no && (
              <div className="fact">
                <span className="fact-k">{t('from_contract')}</span>
                <span className="fact-v">{po.contract_no}{po.contract_title ? ` · ${po.contract_title}` : ''}</span>
              </div>
            )}
            {po.request_no && (
              <div className="fact">
                <span className="fact-k">{t('from_request')}</span>
                <span className="fact-v">{po.request_no}{po.request_title ? ` · ${po.request_title}` : ''}</span>
              </div>
            )}
            {po.event_id && (
              <div className="fact">
                <span className="fact-k">{t('from_tender')}</span>
                <span className="fact-v">
                  <Link to={`${isBuyerSide ? '/buyer' : '/supplier'}/events/${po.event_id}`}>{t('open_item')}</Link>
                </span>
              </div>
            )}
          </div>
        )}
        {po.note && <p className="hint" style={{ marginTop: 12 }}>{po.note}</p>}
        <p style={{ marginTop: 14 }}><Link to={backTo}>← {t(isBuyerSide ? 'contracts' : 'my_orders')}</Link></p>
      </div>

      {/* What was ordered — the thing the product could not show at all before this page. */}
      <div className="card">
        <h3>{t('order_lines')}</h3>
        {!items.length && <p className="hint state-empty" data-testid="list-empty">{t('no_items')}</p>}
        {!!items.length && (
          <table data-testid="order-lines">
            <thead>
              <tr>
                <th className="nowrap">#</th>
                <th className="grow">{t('title')}</th>
                <th className="num">{t('ord_qty')}</th>
                {/* Received and still-billable stand next to the ordered figure because the
                    question they answer is a comparison: a line ordered 10 and received 4 is
                    the only thing a reader wants to find on this screen. */}
                <th className="num">{t('rec_qty')}</th>
                <th className="num">{t('bill_qty')}</th>
                <th>{t('uom')}</th>
                <th className="num">{t('unit_price')}</th>
                <th className="num">{t('total')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => {
                const s = received[i.id];
                const short = s && Number(s.received) < Number(s.ordered);
                return (
                  <tr key={i.id}>
                    <td className="nowrap">{i.line_no}</td>
                    <td className="grow">{i.name}</td>
                    <td className="num">{Number(i.qty)}</td>
                    {/* Amber, not red: a part-received line is the normal middle of a
                        delivery, not a fault. Red here would cry on every open order. */}
                    <td className={`num${short ? ' warn-num' : ''}`}>{s ? Number(s.received) : 0}</td>
                    <td className="num hint">{s ? Number(s.billable) : 0}</td>
                    <td>{i.uom}</td>
                    <td className="num">{fmtMoney(i.unit_price_minor, po.currency)}</td>
                    <td className="num">{fmtMoney(i.line_total_minor, po.currency)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* How it got here. Status alone says where the order is; this says who moved it and
          when, which is the question that follows it on every disputed delivery. */}
      <div className="card">
        <h3>{t('history')}</h3>
        {!history.length && <p className="hint state-empty">{t('no_items')}</p>}
        {!!history.length && (
          <table data-testid="order-history">
            <thead><tr><th className="nowrap">{t('po_created')}</th><th>{t('status')}</th><th className="grow">{t('reason')}</th></tr></thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td className="nowrap">{fmtDateTime(h.created_at)}</td>
                  <td>
                    {/* The step, not just where it landed: «ISSUED → CONFIRMED» read as
                        two statuses in words is the sentence a reader is after. */}
                    {h.from_status && <span className="hint">{statusLabel(t, h.from_status)} → </span>}
                    <Badge status={h.to_status} />
                  </td>
                  <td className="grow">{h.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {!!proposed.length && (
        <div className="card">
          <h3>{t('amendments')}</h3>
          {proposed.map((a: any) => (
            <div key={a.id} style={{ marginBottom: 10 }}>
              <div className="hint">#{a.amendment_no} · {a.reason}</div>
              {(a.changes ?? []).map((c: any) => (
                <div key={c.poItemId} style={{ fontSize: 12, margin: '4px 0' }}>
                  {c.name}:{' '}
                  {amendedQty(c) && <>{c.oldQty} → <b>{c.newQty}</b></>}
                  {amendedQty(c) && amendedPrice(c) && ' · '}
                  {amendedPrice(c) && <>{fmtMoney(c.oldUnitPriceMinor, po.currency)} → <b>{fmtMoney(c.newUnitPriceMinor, po.currency)}</b></>}
                </div>
              ))}
              <div style={{ fontSize: 12 }}>
                {t('total')}: {fmtMoney(a.old_total_minor, po.currency)} → <b>{fmtMoney(a.new_total_minor, po.currency)}</b>
              </div>
            </div>
          ))}
          {/* Deciding stays where it was — on the supplier's own list, next to the order it
              changes; this card exists so the buyer's side can see a proposal is pending.
              The buyer is told where the answer will come from; the supplier is not sent
              back to the page they just came from. */}
          {isBuyerSide && <p className="hint">{t('amendments_decide_elsewhere')}</p>}
        </div>
      )}

      <div className="card">
        <h3>{t('logistics')}</h3>
        <ListState of={ship} />
        {!ship.loading && !ship.failed && !ship.data?.shipment && <p className="hint state-empty">{t('no_shipment')}</p>}
        {ship.data?.shipment && (
          <>
            <div className="fact-row">
              <div className="fact">
                <span className="fact-k">{t('carrier')}</span>
                <span className="fact-v">{ship.data.shipment.carrier}</span>
              </div>
              <div className="fact">
                <span className="fact-k">{t('tracking_no')}</span>
                <span className="fact-v">{ship.data.shipment.tracking_no}</span>
              </div>
              <div className="fact">
                <span className="fact-k">{t('status')}</span>
                <span className="fact-v"><Badge status={ship.data.shipment.status} /></span>
              </div>
            </div>
            {/* Words and a place, never `SHIPPED@Baku`: the same rule the supplier's board
                was taught in PR #72. */}
            <p className="hint" style={{ marginTop: 10 }}>
              {(ship.data.events ?? []).map((e: any) =>
                [statusLabel(t, e.status), e.location].filter(Boolean).join(' · ')).join(' → ')}
            </p>
          </>
        )}
      </div>
    </>
  );
}
