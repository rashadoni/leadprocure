import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, fmtDateTime, fmtMoney } from '../../api/client';
import { useI18n } from '../../i18n';
import { AuctionPanel } from '../../components/AuctionPanel';
import { QnaCard } from '../../components/QnaCard';
import { BidDocs } from '../../components/BidDocs';
import { Badge } from '../../components/Badge';
import { ProcedureChip } from '../../components/ProcedureChip';
import { ListState } from '../../components/ListState';
import { refusalText } from '../../components/refusal';

export default function SupplierEvent() {
  const { id } = useParams();
  const { t } = useI18n();
  const [ev, setEv] = useState<any>(null);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [deliveryDays, setDeliveryDays] = useState('14');
  const [proposalText, setProposalText] = useState('');
  const [msg, setMsg] = useState('');

  const [evFailed, setEvFailed] = useState(false);
  const load = useCallback(
    () => { setEvFailed(false); return api.get(`/events/${id}`).then((r) => setEv(r.data)).catch(() => setEvFailed(true)); },
    [id],
  );
  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    setMsg('');
    try {
      const items = ev.items
        .filter((i: any) => prices[i.id])
        .map((i: any) => ({ eventItemId: i.id, unitPriceMinor: Math.round(Number(prices[i.id]) * 100) }));
      if (ev.format === 'REVERSE') {
        const res = await api.post(`/events/${id}/auction/bids`, { items });
        setMsg(`${t('bid_received')} · ${fmtMoney(res.data.total_minor, ev.evaluation_currency)}${res.data.extended ? ` · ⏱ ${t('auction_extended')}` : ''}`);
      } else if (ev.type === 'RFI') {
        const res = await api.post(`/events/${id}/bid`, { proposalText });
        setMsg(`${t('bid_received')} · sha256 ${res.data.payload_sha256.slice(0, 16)}…`);
      } else {
        const res = await api.post(`/events/${id}/bid`, {
          items, deliveryDays: Number(deliveryDays),
          ...(ev.type === 'RFP' ? { proposalText } : {}),
        });
        setMsg(`${t('bid_received')} · sha256 ${res.data.payload_sha256.slice(0, 16)}…`);
      }
      load();
    } catch (e: any) { setMsg(refusalText(t, e)); }
  };

  const withdraw = async () => {
    try { await api.post(`/events/${id}/withdraw`); load(); }
    catch (e: any) { setMsg(refusalText(t, e)); }
  };

  // Until the event is here this page is only a spinner, and a failed load used to
  // leave that spinner on screen for ever instead of saying what happened.
  if (!ev) return <div className="card"><ListState of={{ loading: !evFailed, failed: evFailed, reload: load }} /></div>;
  // The supplier's own sealed payload comes back decrypted to them at any status — sealing
  // hides a price from the BUYER and from rival bidders, never from its author.
  const myPrices = new Map<string, number>(
    (ev.my_bid?.payload?.items ?? []).map((i: any) => [i.event_item_id, Number(i.unit_price_minor)]),
  );
  const total = ev.items.reduce(
    (s: number, i: any) => s + (Number(prices[i.id] || 0) * Number(i.qty)), 0,
  );
  // Итоги по лотам: кто победил, за сколько и до какого срока можно возразить. Приходят
  // из `detail()` только участнику — у кого есть своя ставка в этой закупке.
  const results: any[] = ev.results ?? [];
  // Award outcome for THIS supplier: any lot awarded to my bid = won.
  const won = ev.status === 'AWARDED' && ev.my_bid
    && (ev.lots ?? []).some((l: any) => l.awarded_bid_id === ev.my_bid.id);
  const lost = ev.status === 'AWARDED' && !won && !!ev.my_bid;
  const nowMs = Date.now();
  const canBid = ['PUBLISHED', 'OPEN'].includes(ev.status);
  // Nothing priced is nothing to send: the server refuses an empty `items` outright, and a
  // button that is live for a refusal is a button that lies. RFI carries no prices at all —
  // its text is the bid — and RFP needs both.
  const priced = ev.items.some((i: any) => String(prices[i.id] ?? '').trim() !== '');
  const blocked = ev.status !== 'OPEN'
    || (ev.type === 'RFI' ? proposalText.trim().length < 3
      : !priced || (ev.type === 'RFP' && proposalText.trim().length < 3));

  return (
    <>
      {/* a reload that failed after the page was drawn: the figures below are stale */}
      <ListState of={{ loading: false, failed: evFailed, reload: load }} />
      {/* The supplier could not tell a sealed RFQ from a live auction from an RFI by
          looking at the card — only the buyer's side showed the procedure at all. */}
      <h1>{ev.title} <ProcedureChip type={ev.type} format={ev.format} visibility={ev.visibility} /> <Badge status={ev.status} /></h1>
      {won && (
        <div className="card" style={{ borderColor: 'var(--ok)' }}>
          <b>🏆 {t('you_won')}</b>
          <div className="hint">{t('you_won_hint')}</div>
        </div>
      )}
      {lost && (
        <div className="card">
          <b>{t('you_lost')}</b>
          <div className="hint">{t('you_lost_hint')}</div>
        </div>
      )}
      {/* Итоги закупки.
          Раньше участник видел только «выбрана другая заявка» — без имени победителя, без
          суммы и без срока, до которого решение ещё можно оспорить. Это строка, а не итог:
          возразить по ней нечему, и проверяющему показать нечего. */}
      {results.length > 0 && (
        <div className="card" data-testid="sup-results">
          <h3>{t('results_title')}</h3>
          <table>
            <thead><tr>
              <th>{t('results_lot')}</th><th>{t('results_winner')}</th>
              <th className="num">{t('results_amount')}</th>
              <th>{t('results_decided')}</th><th>{t('results_objection_until')}</th>
            </tr></thead>
            <tbody>
              {results.map((r: any) => {
                const until = r.standstill_until ? new Date(r.standstill_until).getTime() : null;
                const open = !!until && !r.standstill_waived_reason && until > nowMs;
                return (
                  <tr key={r.lot_id ?? 'single'} data-testid="sup-results-row">
                    <td>{r.lot_no ? `#${r.lot_no} ${r.lot_title ?? ''}` : (r.lot_title ?? '—')}</td>
                    <td>{r.winner_name ?? '—'}{r.won_by_me && <> — <b>{t('results_you')}</b></>}</td>
                    <td className="num">{fmtMoney(r.winning_total_minor, r.winning_currency ?? ev.evaluation_currency)}</td>
                    <td>{fmtDateTime(r.awarded_at)}</td>
                    <td>
                      {r.standstill_waived_reason
                        ? `${t('results_objection_waived')}: ${r.standstill_waived_reason}`
                        : until ? (open ? fmtDateTime(r.standstill_until) : t('results_objection_over')) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {/* Срок без канала — украшение. Канал в продукте один и он тут же ниже. */}
          {results.some((r: any) => r.standstill_until && !r.standstill_waived_reason
            && new Date(r.standstill_until).getTime() > nowMs) && (
            <div className="hint">{t('results_objection_hint')}</div>
          )}
        </div>
      )}
      <div className="card">
        <b>{t('buyer_org')}:</b> {ev.buyer_name} · <b>{t('deadline')}:</b> {fmtDateTime(ev.close_at)}
        {ev.my_bid && (
          <div style={{ marginTop: 8 }}>
            {t('my_bid')}: <Badge status={ev.my_bid.state} />{' '}
            {ev.type !== 'RFI' && ev.my_bid.payload && <>· {fmtMoney(ev.my_bid.payload.total_minor, ev.my_bid.payload.currency)}</>}
            {ev.my_bid.payload?.proposal_text && (
              <div role="note" aria-label={ev.type === 'RFI' ? t('response_text') : t('proposal_text')} style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>
                {ev.my_bid.payload.proposal_text}
              </div>
            )}
            {ev.my_bid.state === 'SUBMITTED' && ev.status === 'OPEN' && (
              <> · <button className="btn small ghost" onClick={withdraw}>{t('withdraw')}</button></>
            )}
            <div style={{ marginTop: 6 }}>
              <div className="hint">{t('attachments')}</div>
              <BidDocs bidId={ev.my_bid.id} canUpload={ev.status === 'OPEN'} />
            </div>
          </div>
        )}
      </div>

      {ev.format === 'REVERSE' && <AuctionPanel eventId={id!} onChanged={load} />}

      {/* Shown whenever there is anything to show, not only while bidding is open. The whole
          card used to be wrapped in `canBid`, so the moment the deadline passed a supplier
          lost sight of what was being bought AND of what they had priced it at — a closed
          tender was a title, a buyer, a deadline and nothing else. The API has always
          returned the items to suppliers (with the buyer's estimate stripped), so only this
          screen was hiding them. */}
      {(canBid || (ev.type !== 'RFI' && ev.items.length > 0)) && (
      <div className="card">
        <h3>
          {ev.type === 'RFI' ? `❓ RFI — ${t('response_text')}`
            : <>{t('items')}{canBid && <> — {ev.format === 'REVERSE' ? `⚡ ${t('place_bid')}` : t('bid')}</>}</>}
        </h3>
        {ev.type !== 'RFI' && (
          <table>
            {/* no buyer estimate here — publishing it to bidders anchors their prices */}
            <thead><tr><th>{t('name')}</th><th className="num">{t('qty')}</th><th className="num">{t('unit_price')} ({ev.evaluation_currency})</th></tr></thead>
            <tbody>
              {ev.items.map((i: any) => (
                <tr key={i.id}>
                  <td>{i.name}</td>
                  <td className="num">{Number(i.qty)}</td>
                  <td className="num">
                    {canBid ? (
                      <input style={{ width: 130 }} type="number" step="0.01" min="0" value={prices[i.id] ?? ''}
                        disabled={ev.status !== 'OPEN'}
                        onChange={(e) => setPrices({ ...prices, [i.id]: e.target.value })} />
                    ) : (
                      /* After the deadline the input is useless, but the price the supplier
                         actually submitted is theirs to re-read — it comes back decrypted in
                         their own my_bid payload. */
                      myPrices.has(i.id) ? fmtMoney(myPrices.get(i.id)!, ev.my_bid?.payload?.currency ?? ev.evaluation_currency) : '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {(ev.type === 'RFP' || ev.type === 'RFI') && (
          <div style={{ marginTop: 10 }}>
            <label htmlFor="supplier-proposal">{ev.type === 'RFI' ? t('response_text') : t('proposal_text')}</label>
            <textarea id="supplier-proposal" rows={5} style={{ width: '100%' }} value={proposalText}
              disabled={ev.status !== 'OPEN'}
              onChange={(e) => setProposalText(e.target.value)} />
          </div>
        )}
        {canBid && (
        <>
        <div className="row" style={{ marginTop: 12, maxWidth: 480 }}>
          {ev.type !== 'RFI' && (
            <>
              <div>
                <label>{t('delivery_days')}</label>
                <input type="number" min={1} value={deliveryDays} disabled={ev.status !== 'OPEN'}
                  onChange={(e) => setDeliveryDays(e.target.value)} />
              </div>
              <div>
                <label>{t('total')}</label>
                <div style={{ padding: '8px 0', fontWeight: 700 }}>{fmtMoney(Math.round(total * 100), ev.evaluation_currency)}</div>
              </div>
            </>
          )}
          {/* Live on an empty form, with «Сумма 0,00 AZN» printed beside it, the button
              invited a press the server then refused — in English, on an Azerbaijani screen.
              It is now shut until there is something to send, and says why, the way
              «Параметры» already shuts its Save with «изменений нет». */}
          <button className="btn" data-tip={blocked ? t('tip_bid_needs_price') : undefined}
            disabled={blocked} onClick={submit}>
            {ev.format === 'REVERSE' ? `⚡ ${t('place_bid')}` : `🔒 ${ev.type === 'RFI' ? t('send') : t('bid')}`}
          </button>
        </div>
        {msg && <div className="hint">{msg}</div>}
        {ev.format !== 'REVERSE' && <div className="hint">🔒 {t('amounts_hidden')}</div>}
        </>
        )}
      </div>
      )}

      <QnaCard eventId={id!} isBuyer={false} />
    </>
  );
}
