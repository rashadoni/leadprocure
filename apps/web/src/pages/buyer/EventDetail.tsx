import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';
import { api, fmtMoney, getToken } from '../../api/client';
import { useI18n } from '../../i18n';

export default function EventDetail() {
  const { id } = useParams();
  const { t } = useI18n();
  const [ev, setEv] = useState<any>(null);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [inviteOrg, setInviteOrg] = useState('');
  const [scores, setScores] = useState<Record<string, { price: number; delivery: number }>>({});

  const load = useCallback(() => api.get(`/events/${id}`).then((r) => setEv(r.data)), [id]);
  useEffect(() => { load(); api.get('/suppliers/directory').then((r) => setSuppliers(r.data)); }, [load]);

  // Live updates: statuses/counters arrive over WS; amounts only ever via REST.
  useEffect(() => {
    const base = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000') as string;
    const s: Socket = io(`${base}/rt`, { auth: { token: getToken() }, transports: ['websocket'] });
    s.emit('join', id);
    const refresh = () => load();
    s.on('event.status', refresh);
    s.on('bid.activity', refresh);
    s.on('event.awarded', refresh);
    return () => { s.disconnect(); };
  }, [id, load]);

  const act = async (action: string, body?: any) => {
    try { await api.post(`/events/${id}/${action}`, body ?? {}); load(); }
    catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  // The OCDS endpoint is auth-guarded; a plain <a href> opens a tab without the
  // bearer token (→ 401). Fetch through the authorized client and hand the user
  // the JSON as a downloadable blob instead.
  const openOcds = async () => {
    try {
      const { data } = await api.get(`/events/${id}/ocds`);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ocds-${id}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  const doEvaluate = async () => {
    const list = (ev.bids ?? []).filter((b: any) => b.state === 'OPENED');
    await act('evaluate', {
      criteria: [{ key: 'price', weight: 70 }, { key: 'delivery', weight: 30 }],
      scores: list.flatMap((b: any) => [
        { bidId: b.id, key: 'price', score: scores[b.id]?.price ?? 50 },
        { bidId: b.id, key: 'delivery', score: scores[b.id]?.delivery ?? 50 },
      ]),
    });
  };

  const weightedByBid = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of ev?.scores ?? []) m.set(s.bid_id, (m.get(s.bid_id) ?? 0) + Number(s.weighted));
    return m;
  }, [ev]);

  if (!ev) return <div className="center">…</div>;
  const lot = ev.lots?.[0];
  const awardedBidId = ev.awards?.[0]?.winning_bid_id;

  return (
    <>
      <h1>
        {ev.title} <span className={`badge ${ev.status}`}>{ev.status}</span>
      </h1>
      <div className="card">
        <b>{t('deadline')}:</b> {new Date(ev.close_at).toLocaleString()} · <b>{ev.visibility}</b> · {ev.evaluation_currency}
        <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
          {ev.status === 'DRAFT' && <button className="btn" onClick={() => act('publish')}>{t('publish')}</button>}
          {ev.status === 'CLOSED' && <button className="btn" onClick={() => act('open')}>{t('open_bids')}</button>}
          <button className="btn ghost" onClick={openOcds}>{t('ocds')}</button>
          {ev.status === 'AWARDED' && ev.awards?.[0] && (
            <button className="btn" onClick={async () => {
              try {
                const c = await api.post(`/contracts/from-award/${ev.awards[0].id}`);
                await api.post(`/contracts/${c.data.id}/activate`).catch(() => {});
                window.location.href = '/buyer/contracts';
              } catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
            }}>{t('make_contract')}</button>
          )}
        </div>
        {['DRAFT', 'OPEN'].includes(ev.status) && (
          <div className="row" style={{ marginTop: 12, maxWidth: 480 }}>
            <div>
              <label>{t('invite')}</label>
              <select value={inviteOrg} onChange={(e) => setInviteOrg(e.target.value)}>
                <option value="">—</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.legal_name}</option>)}
              </select>
            </div>
            <button className="btn" disabled={!inviteOrg} onClick={() => act('invite', { supplierOrgId: inviteOrg })}>{t('invite')}</button>
          </div>
        )}
      </div>

      <div className="card">
        <h3>{t('items')}</h3>
        <table>
          <thead><tr><th>{t('name')}</th><th>{t('qty')}</th><th>Est. {t('unit_price')}</th></tr></thead>
          <tbody>
            {ev.items.map((i: any) => (
              <tr key={i.id}><td>{i.name}</td><td>{Number(i.qty)}</td><td>{fmtMoney(i.est_unit_price_minor, ev.evaluation_currency)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Bids {!ev.amounts_visible && <span className="sealed">🔒 {t('amounts_hidden')}</span>}</h3>
        <table>
          <thead><tr><th>{t('supplier_org')}</th><th>{t('status')}</th><th>{t('total')}</th><th>Delivery</th><th>Score</th><th>{t('actions')}</th></tr></thead>
          <tbody>
            {(ev.bids ?? []).map((b: any) => (
              <tr key={b.id} style={awardedBidId === b.id ? { outline: '1px solid var(--ok)' } : undefined}>
                <td>{b.supplier_name}{awardedBidId === b.id ? ' 🏆' : ''}</td>
                <td><span className={`badge ${b.state}`}>{b.state}</span></td>
                <td>{ev.amounts_visible ? fmtMoney(b.total_minor, b.currency) : '🔒'}</td>
                <td>{ev.amounts_visible ? (b.delivery_days ?? '—') : '🔒'}</td>
                <td>{weightedByBid.has(b.id) ? weightedByBid.get(b.id)!.toFixed(1) : '—'}</td>
                <td>
                  {ev.status === 'EVALUATION' && b.state === 'OPENED' && (
                    <span style={{ display: 'inline-flex', gap: 6 }}>
                      <input style={{ width: 64 }} type="number" placeholder="price" min={0} max={100}
                        onChange={(e) => setScores({ ...scores, [b.id]: { ...(scores[b.id] ?? { delivery: 50 }), price: Number(e.target.value) } })} />
                      <input style={{ width: 64 }} type="number" placeholder="deliv" min={0} max={100}
                        onChange={(e) => setScores({ ...scores, [b.id]: { ...(scores[b.id] ?? { price: 50 }), delivery: Number(e.target.value) } })} />
                      {!awardedBidId && lot && (
                        <button className="btn small" onClick={() => act('award', { lotId: lot.id, bidId: b.id })}>{t('award')}</button>
                      )}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {ev.status === 'EVALUATION' && (ev.bids ?? []).some((b: any) => b.state === 'OPENED') && (
          <div style={{ marginTop: 12 }}>
            <button className="btn ghost" onClick={doEvaluate}>{t('score')} (70% price / 30% delivery)</button>
          </div>
        )}
      </div>
    </>
  );
}
