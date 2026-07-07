import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, fmtDateTime, fmtMoney } from '../../api/client';
import { useI18n } from '../../i18n';
import { AuctionPanel } from '../../components/AuctionPanel';
import { QnaCard } from '../../components/QnaCard';
import { BidDocs } from '../../components/BidDocs';
import { Badge } from '../../components/Badge';

export default function SupplierEvent() {
  const { id } = useParams();
  const { t } = useI18n();
  const [ev, setEv] = useState<any>(null);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [deliveryDays, setDeliveryDays] = useState('14');
  const [proposalText, setProposalText] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(() => api.get(`/events/${id}`).then((r) => setEv(r.data)), [id]);
  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    setMsg('');
    try {
      const items = ev.items
        .filter((i: any) => prices[i.id])
        .map((i: any) => ({ eventItemId: i.id, unitPriceMinor: Math.round(Number(prices[i.id]) * 100) }));
      if (ev.format === 'REVERSE') {
        const res = await api.post(`/events/${id}/auction/bids`, { items });
        setMsg(`OK · ${fmtMoney(res.data.total_minor, ev.evaluation_currency)}${res.data.extended ? ' · ⏱ +ext' : ''}`);
      } else if (ev.type === 'RFI') {
        const res = await api.post(`/events/${id}/bid`, { proposalText });
        setMsg(`OK · sha256 ${res.data.payload_sha256.slice(0, 16)}…`);
      } else {
        const res = await api.post(`/events/${id}/bid`, {
          items, deliveryDays: Number(deliveryDays),
          ...(ev.type === 'RFP' ? { proposalText } : {}),
        });
        setMsg(`OK · sha256 ${res.data.payload_sha256.slice(0, 16)}…`);
      }
      load();
    } catch (e: any) { setMsg(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  const withdraw = async () => {
    try { await api.post(`/events/${id}/withdraw`); load(); }
    catch (e: any) { setMsg(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  if (!ev) return <div className="center">…</div>;
  const total = ev.items.reduce(
    (s: number, i: any) => s + (Number(prices[i.id] || 0) * Number(i.qty)), 0,
  );
  // Award outcome for THIS supplier: any lot awarded to my bid = won.
  const won = ev.status === 'AWARDED' && ev.my_bid
    && (ev.lots ?? []).some((l: any) => l.awarded_bid_id === ev.my_bid.id);
  const lost = ev.status === 'AWARDED' && !won && !!ev.my_bid;
  const canBid = ['PUBLISHED', 'OPEN'].includes(ev.status);

  return (
    <>
      <h1>{ev.title} <Badge status={ev.status} /></h1>
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
      <div className="card">
        <b>{t('buyer_org')}:</b> {ev.buyer_name} · <b>{t('deadline')}:</b> {fmtDateTime(ev.close_at)}
        {ev.my_bid && (
          <div style={{ marginTop: 8 }}>
            {t('my_bid')}: <Badge status={ev.my_bid.state} />{' '}
            {ev.my_bid.payload && <>· {fmtMoney(ev.my_bid.payload.total_minor, ev.my_bid.payload.currency)}</>}
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

      {canBid && (
      <div className="card">
        <h3>
          {ev.type === 'RFI' ? `❓ RFI — ${t('response_text')}`
            : <>{t('items')} — {ev.format === 'REVERSE' ? `⚡ ${t('place_bid')}` : t('bid')}</>}
        </h3>
        {ev.type !== 'RFI' && (
          <table>
            {/* no buyer estimate here — publishing it to bidders anchors their prices */}
            <thead><tr><th>{t('name')}</th><th>{t('qty')}</th><th>{t('unit_price')} (AZN)</th></tr></thead>
            <tbody>
              {ev.items.map((i: any) => (
                <tr key={i.id}>
                  <td>{i.name}</td>
                  <td>{Number(i.qty)}</td>
                  <td>
                    <input style={{ width: 130 }} type="number" step="0.01" min="0" value={prices[i.id] ?? ''}
                      disabled={ev.status !== 'OPEN'}
                      onChange={(e) => setPrices({ ...prices, [i.id]: e.target.value })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {(ev.type === 'RFP' || ev.type === 'RFI') && (
          <div style={{ marginTop: 10 }}>
            <label>{ev.type === 'RFI' ? t('response_text') : t('proposal_text')}</label>
            <textarea rows={5} style={{ width: '100%' }} value={proposalText}
              disabled={ev.status !== 'OPEN'}
              onChange={(e) => setProposalText(e.target.value)} />
          </div>
        )}
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
          <button className="btn" disabled={ev.status !== 'OPEN' || ((ev.type === 'RFP' || ev.type === 'RFI') && proposalText.trim().length < 3)} onClick={submit}>
            {ev.format === 'REVERSE' ? `⚡ ${t('place_bid')}` : `🔒 ${ev.type === 'RFI' ? t('send') : t('bid')}`}
          </button>
        </div>
        {msg && <div className="hint">{msg}</div>}
        {ev.format !== 'REVERSE' && <div className="hint">🔒 {t('amounts_hidden')}</div>}
      </div>
      )}

      <QnaCard eventId={id!} isBuyer={false} />
    </>
  );
}
