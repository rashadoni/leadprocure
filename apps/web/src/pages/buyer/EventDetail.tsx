import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';
import { api, fmtMoney, getToken } from '../../api/client';
import { useI18n } from '../../i18n';
import { AuctionPanel } from '../../components/AuctionPanel';
import { QnaCard } from '../../components/QnaCard';
import { BidDocs } from '../../components/BidDocs';
import { Badge } from '../../components/Badge';

export default function EventDetail() {
  const { id } = useParams();
  const { t } = useI18n();
  const [ev, setEv] = useState<any>(null);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [inviteOrg, setInviteOrg] = useState('');
  const [scores, setScores] = useState<Record<string, { price: number; delivery: number }>>({});
  const [ai, setAi] = useState<any>(null);

  const load = useCallback(() => api.get(`/events/${id}`).then((r) => setEv(r.data)), [id]);
  useEffect(() => { load(); api.get('/suppliers/directory').then((r) => setSuppliers(r.data)); }, [load]);

  // Follow-up chains: reminder status per invited supplier (email → … → WhatsApp).
  const [fups, setFups] = useState<any[]>([]);
  const loadFups = useCallback(
    () => api.get(`/events/${id}/followups`).then((r) => setFups(r.data)).catch(() => setFups([])),
    [id],
  );
  useEffect(() => { loadFups(); }, [loadFups]);

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
    // criteria are the ones locked on the event before opening — we submit only scores
    const list = (ev.bids ?? []).filter((b: any) => b.state === 'OPENED');
    await act('evaluate', {
      scores: list.flatMap((b: any) => [
        { bidId: b.id, key: 'price', score: scores[b.id]?.price ?? 50 },
        { bidId: b.id, key: 'delivery', score: scores[b.id]?.delivery ?? 50 },
      ]),
    });
  };

  // Award needs a justification when the winner isn't the top-ranked or is the sole bid.
  const awardBid = async (lotId: string, bidId: string) => {
    const justification = window.prompt(t('award_justification_prompt')) ?? undefined;
    try {
      await api.post(`/events/${id}/award`, { lotId, bidId, justification });
      load();
    } catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };
  const disqualify = async (bidId: string) => {
    const reason = window.prompt(t('disqualify_prompt'));
    if (!reason) return;
    try { await api.post(`/events/${id}/bids/${bidId}/disqualify`, { reason }); load(); }
    catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };
  const cancelAward = async (lotId: string) => {
    const reason = window.prompt(t('cancel_award_prompt'));
    if (!reason) return;
    try { await api.post(`/events/${id}/cancel-award`, { lotId, reason }); load(); }
    catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  const weightedByBid = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of ev?.scores ?? []) m.set(s.bid_id, (m.get(s.bid_id) ?? 0) + Number(s.weighted));
    return m;
  }, [ev]);

  const askAi = async () => {
    try { setAi((await api.get(`/events/${id}/ai-recommendation`)).data); }
    catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  if (!ev) return <div className="center">…</div>;
  const lot = ev.lots?.[0];
  const awardedBidId = ev.awards?.[0]?.winning_bid_id;
  const isRfi = ev.type === 'RFI';
  const canAi = ['EVALUATION', 'AWARDED'].includes(ev.status) && !isRfi;

  return (
    <>
      <h1>
        {ev.title} <span className="badge INVITED">{ev.type}</span>{' '}
        <Badge status={ev.status} />
      </h1>
      <div className="card">
        <b>{t('deadline')}:</b> {new Date(ev.close_at).toLocaleString()} · <b>{ev.visibility}</b> · {ev.evaluation_currency}
        <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
          {ev.status === 'DRAFT' && <button className="btn" data-tip={t('tip_publish')} onClick={() => act('publish')}>{t('publish')}</button>}
          {ev.status === 'CLOSED' && ev.format === 'SEALED' && (
            <button className="btn" data-tip={t('tip_open_bids')} onClick={() => act('open')}>{t('open_bids')}</button>
          )}
          {ev.status === 'CLOSED' && ev.format === 'REVERSE' && (
            <button className="btn" data-tip={t('tip_finalize')} onClick={() => act('auction/finalize')}>{t('finalize')}</button>
          )}
          <button className="btn ghost" data-tip={t('tip_ocds')} onClick={openOcds}>{t('ocds')}</button>
          {ev.status === 'AWARDED' && ev.awards?.[0] && (
            <button className="btn" data-tip={t('tip_make_contract')} onClick={async () => {
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
            <button className="btn" disabled={!inviteOrg} data-tip={t('tip_supplier_invite')} onClick={() => act('invite', { supplierOrgId: inviteOrg })}>{t('invite')}</button>
          </div>
        )}
      </div>

      {(['PUBLISHED', 'OPEN'].includes(ev.status) || fups.length > 0) && (
        <div className="card">
          <h3>⏰ {t('followups')}</h3>
          {['PUBLISHED', 'OPEN'].includes(ev.status) && (
            <button className="btn small" style={{ marginBottom: 8 }} data-tip={t('tip_followups_enroll')}
              onClick={async () => {
                try { await api.post(`/events/${id}/followups`, {}); loadFups(); }
                catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
              }}>
              {t('followups_enroll')}
            </button>
          )}
          {fups.length === 0 ? (
            <p style={{ color: 'var(--muted, #6b7280)' }}>{t('followups_empty')}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t('supplier_org')}</th><th>{t('status')}</th><th>{t('followups_step')}</th>
                  <th>{t('followups_next')}</th><th>{t('followups_sent')}</th><th>{t('actions')}</th>
                </tr>
              </thead>
              <tbody>
                {fups.map((f: any) => (
                  <tr key={f.id}>
                    <td>{f.supplier_name}</td>
                    <td><Badge status={t(`fu_${f.status}`)} cls={f.status === 'RESPONDED' ? 'APPROVED' : f.status === 'ACTIVE' ? 'INVITED' : 'REJECTED'} /></td>
                    <td>{f.current_step}/{f.total_steps}</td>
                    <td>{f.next_run_at ? new Date(f.next_run_at).toLocaleString() : '—'}</td>
                    <td>{f.sent_count}</td>
                    <td>
                      {f.status === 'ACTIVE' && (
                        <button className="btn small ghost" onClick={async () => {
                          try { await api.post(`/events/${id}/followups/${f.supplier_org_id}/stop`); loadFups(); }
                          catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
                        }}>{t('followups_stop')}</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {ev.format === 'REVERSE' && <AuctionPanel eventId={id!} />}

      <div className="card">
        <h3>{t('items')} · {t('lots')}</h3>
        {ev.status === 'DRAFT' && (
          <button className="btn small ghost" style={{ marginBottom: 8 }} data-tip={t('tip_add_lot')}
            onClick={async () => { const title = prompt(`${t('lots')}:`, `Lot ${ev.lots.length + 1}`); if (title) { await api.post(`/events/${id}/lots`, { title }); load(); } }}>
            + {t('lots')}
          </button>
        )}
        <table>
          <thead><tr><th>{t('name')}</th><th>{t('qty')}</th><th>{t('unit_price')} (est.)</th><th>{t('lots')}</th></tr></thead>
          <tbody>
            {ev.items.map((i: any) => (
              <tr key={i.id}>
                <td>{i.name}</td><td>{Number(i.qty)}</td><td>{fmtMoney(i.est_unit_price_minor, ev.evaluation_currency)}</td>
                <td>
                  {ev.status === 'DRAFT' && ev.lots.length > 1 ? (
                    <select value={i.lot_id ?? ''} onChange={async (e) => { await api.put(`/events/${id}/items/${i.id}/lot`, { lotId: e.target.value }); load(); }}>
                      {ev.lots.map((l: any) => <option key={l.id} value={l.id}>{l.title}</option>)}
                    </select>
                  ) : (
                    ev.lots.find((l: any) => l.id === i.lot_id)?.title ?? '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {['EVALUATION', 'AWARDED'].includes(ev.status) && !isRfi && ev.lots.length > 0 && (
        <div className="card" style={{ borderColor: 'var(--ok)' }}>
          <h3>{t('award')} · {t('lots')}</h3>
          {ev.lots.map((l: any) => {
            const awarded = (ev.awards ?? []).find((a: any) => a.lot_id === l.id && !a.cancelled_at);
            const totals = (ev.lot_bid_totals ?? [])
              .filter((t2: any) => t2.lot_id === l.id)
              .filter((t2: any) => (ev.bids ?? []).find((b: any) => b.id === t2.bid_id)?.state !== 'DISQUALIFIED')
              .sort((a: any, b: any) => Number(a.total_minor) - Number(b.total_minor));
            return (
              <div key={l.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                <b>{l.title}</b>{' '}
                {awarded && (
                  <>
                    <span className="badge AWARDED">🏆 {t('st_AWARDED')}</span>{' '}
                    <button className="btn small ghost" data-tip={t('cancel_award_prompt')} onClick={() => cancelAward(l.id)}>✕ {t('cancel_award')}</button>
                    {awarded.justification && <div className="hint" style={{ marginTop: 4 }}>📝 {awarded.justification}</div>}
                  </>
                )}
                {!awarded && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                    {totals.map((t2: any, idx: number) => {
                      const bid = (ev.bids ?? []).find((b: any) => b.id === t2.bid_id);
                      return (
                        <button key={t2.bid_id} className={`btn small ${idx === 0 ? '' : 'ghost'}`}
                          data-tip={t('tip_award_bid')} onClick={() => awardBid(l.id, t2.bid_id)}>
                          {bid?.supplier_name} · {fmtMoney(t2.total_minor, ev.evaluation_currency)}{idx === 0 ? ' ⭐' : ''}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="card">
        <h3>Bids {!ev.amounts_visible && <span className="sealed">🔒 {t('amounts_hidden')}</span>}</h3>
        <table>
          <thead><tr><th>{t('supplier_org')}</th><th>{t('status')}</th><th>{t('total')}</th><th>{t('delivery_days')}</th><th>{t('score')}</th><th>{t('actions')}</th></tr></thead>
          <tbody>
            {(ev.bids ?? []).map((b: any) => (
              <tr key={b.id} style={awardedBidId === b.id ? { outline: '1px solid var(--ok)' } : undefined}>
                <td>
                  {b.supplier_name}{awardedBidId === b.id ? ' 🏆' : ''}
                  {b.proposal_text && (
                    <div className="hint" style={{ whiteSpace: 'pre-wrap', maxWidth: 420, marginTop: 4 }}>
                      📝 {b.proposal_text}
                    </div>
                  )}
                  {ev.amounts_visible && <BidDocs bidId={b.id} canUpload={false} />}
                </td>
                <td><Badge status={b.state} /></td>
                <td>{ev.amounts_visible ? fmtMoney(b.total_minor, b.currency) : '🔒'}</td>
                <td>{ev.amounts_visible ? (b.delivery_days ?? '—') : '🔒'}</td>
                <td>{weightedByBid.has(b.id) ? weightedByBid.get(b.id)!.toFixed(1) : '—'}</td>
                <td>
                  {ev.status === 'EVALUATION' && !isRfi && b.state === 'OPENED' && (
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      <input style={{ width: 64 }} type="number" placeholder={t('crit_price')} data-tip={t('score_hint')} min={0} max={100}
                        onChange={(e) => setScores({ ...scores, [b.id]: { ...(scores[b.id] ?? { delivery: 50 }), price: Number(e.target.value) } })} />
                      <input style={{ width: 64 }} type="number" placeholder={t('crit_delivery')} data-tip={t('score_hint')} min={0} max={100}
                        onChange={(e) => setScores({ ...scores, [b.id]: { ...(scores[b.id] ?? { price: 50 }), delivery: Number(e.target.value) } })} />
                      <button className="btn small ghost" data-tip={t('disqualify')} onClick={() => disqualify(b.id)}>⛔</button>
                    </span>
                  )}
                  {b.state === 'DISQUALIFIED' && b.disqualified_reason && (
                    <span className="hint" title={b.disqualified_reason}>⛔ {b.disqualified_reason}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {ev.status === 'EVALUATION' && !isRfi && (ev.bids ?? []).some((b: any) => b.state === 'OPENED') && (
          <div style={{ marginTop: 12 }}>
            <button className="btn ghost" data-tip={t('tip_score')} onClick={doEvaluate}>{t('score')} (70% price / 30% delivery)</button>
          </div>
        )}
      </div>

      {canAi && (
        <div className="card" style={{ borderColor: 'var(--accent2)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>🤖 {t('ai_reco')}</h3>
            <button className="btn small" data-tip={t('tip_ai')} onClick={askAi}>{ai ? '↻' : t('ai_run')}</button>
          </div>
          {ai && (
            <>
              <div style={{ margin: '10px 0', color: 'var(--accent)' }}>{ai.rationale}</div>
              <table>
                <thead><tr><th>#</th><th>{t('supplier_org')}</th><th>{t('unit_price')}</th><th>{t('delivery_days')}</th><th>{t('reliability')}</th><th>{t('score')}</th><th></th></tr></thead>
                <tbody>
                  {ai.ranking.map((r: any, i: number) => (
                    <tr key={r.bidId} style={r.bidId === ai.recommendedBidId ? { outline: '1px solid var(--accent2)' } : undefined}>
                      <td>{i + 1}</td>
                      <td>{r.supplierName}{r.bidId === ai.recommendedBidId ? ' 🤖' : ''}
                        <div className="hint">{r.reasons.join(' · ')}</div></td>
                      <td>{r.priceScore}</td>
                      <td>{r.deliveryScore}</td>
                      <td>{r.reliabilityScore}</td>
                      <td><b>{r.weightedTotal}</b></td>
                      <td>
                        {ev.status === 'EVALUATION' && !awardedBidId && lot && (
                          <button className="btn small" data-tip={t('tip_award_bid')} onClick={() => awardBid(lot.id, r.bidId)}>{t('award')}</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="hint" style={{ marginTop: 6 }}>
                {t('ai_model')}: {ai.model} · price {ai.weights.price * 100}% / delivery {ai.weights.delivery * 100}% / reliability {ai.weights.reliability * 100}%
              </div>
            </>
          )}
        </div>
      )}

      <QnaCard eventId={id!} isBuyer />
    </>
  );
}
