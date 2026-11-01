import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';
import { api, fmtDateTime, fmtMoney, getToken } from '../../api/client';
import { useI18n } from '../../i18n';
import { useAuth } from '../../auth/auth';
import { AuctionPanel } from '../../components/AuctionPanel';
import { QnaCard } from '../../components/QnaCard';
import { BidDocs } from '../../components/BidDocs';
import { Badge } from '../../components/Badge';
import { ProcedureChip } from '../../components/ProcedureChip';
import { useDialogs } from '../../components/Dialogs';
import { isDenied, ListState } from '../../components/ListState';

export default function EventDetail() {
  const { id } = useParams();
  const { t, lang } = useI18n();
  const { session } = useAuth();
  const { notify, notifyError, ask } = useDialogs();
  const [ev, setEv] = useState<any>(null);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [inviteOrg, setInviteOrg] = useState('');
  const [aiLot, setAiLot] = useState('');
  const [scores, setScores] = useState<Record<string, Record<string, number>>>({});
  const [ai, setAi] = useState<any>(null);

  const [evFailed, setEvFailed] = useState(false);
  const load = useCallback(
    () => { setEvFailed(false); return api.get(`/events/${id}`).then((r) => setEv(r.data)).catch(() => setEvFailed(true)); },
    [id],
  );
  // This fills the invite-supplier select on a live tender. The registry sits behind a
  // licence, and being denied it means there is genuinely nobody to invite from here;
  // any other failure said the same thing while the directory was simply unreachable.
  const [suppliersFailed, setSuppliersFailed] = useState(false);
  const loadSuppliers = useCallback(() => {
    setSuppliersFailed(false);
    api.get('/suppliers/directory').then((r) => setSuppliers(r.data))
      .catch((e: any) => { if (!isDenied(e)) setSuppliersFailed(true); });
  }, []);
  useEffect(() => { load(); loadSuppliers(); }, [load, loadSuppliers]);

  // Follow-up chains: reminder status per invited supplier (email → … → WhatsApp).
  const [fups, setFups] = useState<any[]>([]);
  const [fuPlan, setFuPlan] = useState<any>(null);
  const [fuOpenRow, setFuOpenRow] = useState<string | null>(null); // expanded send history
  const [fuEditing, setFuEditing] = useState(false);
  const [fuDraft, setFuDraft] = useState<Array<{ channel: string; afterHours: number }>>([]);
  const loadFups = useCallback(
    () => api.get(`/events/${id}/followups`).then((r) => setFups(r.data)).catch(() => setFups([])),
    [id],
  );
  useEffect(() => {
    loadFups();
    api.get('/settings/followup-plan').then((r) => setFuPlan(r.data)).catch(() => setFuPlan(null));
  }, [loadFups]);

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
    catch (e: any) { notifyError(e); }
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
    } catch (e: any) { notifyError(e); }
  };

  const doEvaluate = async () => {
    // criteria are the ones locked on the event before opening — we submit only scores
    const list = (ev.bids ?? []).filter((b: any) => b.state === 'OPENED');
    if (list.some((b: any) => (ev.evaluation_criteria ?? []).some((c: any) => !Number.isFinite(scores[b.id]?.[c.key])))) { notify(t('score_hint'), 'info'); return; }
    await act('evaluate', {
      scores: list.flatMap((b: any) => (ev.evaluation_criteria ?? []).map((c: any) => ({
        bidId:b.id,key:c.key,score:scores[b.id]?.[c.key] ?? NaN,
      }))),
    });
  };

  // Award needs a justification when the winner isn't the top-ranked or is the sole bid.
  // Cancelling now ABORTS the award. The native prompt returned null on Cancel and the
  // `?? undefined` below sent the award anyway, so backing out of the question awarded the
  // tender — the one thing on this page that cannot be undone without a written reason.
  const awardBid = async (lotId: string, bidId: string) => {
    const justification = await ask({
      title: t('award_justification_prompt'), label: t('justification'),
      hint: t('award_justification_hint'), confirmLabel: t('award'),
    });
    if (justification === null) return;
    try {
      await api.post(`/events/${id}/award`, { lotId, bidId, justification: justification || undefined });
      load();
    } catch (e: any) { notifyError(e); }
  };
  const disqualify = async (bidId: string) => {
    const reason = await ask({
      title: t('disqualify_prompt'), label: t('reason'), required: true, minLength: 3,
      hint: t('disqualify_hint'), confirmLabel: t('disqualify'),
    });
    if (!reason) return;
    try { await api.post(`/events/${id}/bids/${bidId}/disqualify`, { reason }); load(); }
    catch (e: any) { notifyError(e); }
  };
  const cancelAward = async (lotId: string) => {
    const reason = await ask({
      title: t('cancel_award_prompt'), label: t('reason'), required: true, minLength: 3,
      hint: t('cancel_award_hint'), confirmLabel: t('cancel_award'), danger: true,
    });
    if (!reason) return;
    try { await api.post(`/events/${id}/cancel-award`, { lotId, reason }); load(); }
    catch (e: any) { notifyError(e); }
  };

  const weightedByBid = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of ev?.scores ?? []) m.set(s.bid_id, (m.get(s.bid_id) ?? 0) + Number(s.weighted));
    return m;
  }, [ev]);

  const askAi = async () => {
    try { setAi((await api.get(`/events/${id}/ai-recommendation?lotId=${aiLot || ev.lots[0]?.id}&language=${lang}`)).data); }
    catch (e: any) { notifyError(e); }
  };

  // Until the event is here this page is only a spinner, and a failed load used to
  // leave that spinner on screen for ever instead of saying what happened.
  if (!ev) return <div className="card"><ListState of={{ loading: !evFailed, failed: evFailed, reload: load }} /></div>;
  const lot = ev.lots?.[0];
  const activeAwards = (ev.awards ?? []).filter((a: any) => !a.cancelled_at);
  const winningBidIds = new Set(activeAwards.map((a: any) => a.winning_bid_id));
  const selectedAiLotId = aiLot || lot?.id;
  const aiLotAwarded = activeAwards.some((a: any) => a.lot_id === selectedAiLotId);
  const isReverse = ev.type === 'AUCTION' || ev.format === 'REVERSE';
  const isRfi = ev.type === 'RFI';
  const canAi = ['EVALUATION', 'AWARDED'].includes(ev.status) && !isRfi;
  // The actions column of the bids table is empty in every state but EVALUATION (and for a
  // bid that was disqualified with a reason), yet it took its share of the width in all of
  // them — a heading over nothing, on the screen where the widths matter most.
  // Scores exist only where there IS a formal evaluation: an auction is decided on price
  // alone and an RFI is never scored, so in both the column promised a scale out of 100
  // that does not exist there and printed «—» down every row.
  const showScores = !isReverse && !isRfi;
  const showBidActions = (ev.bids ?? []).some((b: any) =>
    (ev.status === 'EVALUATION' && !isReverse && !isRfi && b.state === 'OPENED')
    || (b.state === 'DISQUALIFIED' && b.disqualified_reason));

  return (
    <>
      {/* a reload that failed after the page was drawn: the figures below are stale */}
      <ListState of={[{ loading: false, failed: evFailed, reload: load },
        { loading: false, failed: suppliersFailed, reload: loadSuppliers }]} />
      <h1>
        {/* The list draws the procedure as «🔒 RFQ» with a tip explaining what a sealed
            tender is; the card drew the bare enum in a pill. One component now, both screens. */}
        {ev.title} <ProcedureChip type={ev.type} format={ev.format} />{' '}
        <Badge status={ev.status} />
      </h1>
      <div className="card">
        {/* «Срок: 8/12/2026 · INVITED · AZN» — a date, a word straight out of the database in
            bold, and a lone currency code, with nothing saying what either of the last two
            was. Every fact carries its own name now, and the visibility is said in words
            about who may bid rather than as an enum. */}
        <div className="fact-row">
          <div className="fact">
            <span className="fact-k">{t('deadline')}</span>
            <span className="fact-v">{fmtDateTime(ev.close_at)}</span>
          </div>
          <div className="fact" data-tip={t(`vis_${ev.visibility}_tip`)}>
            <span className="fact-k">{t('visibility')}</span>
            <span className="fact-v">{t(`vis_${ev.visibility}`)}</span>
          </div>
          <div className="fact">
            <span className="fact-k">{t('eval_currency')}</span>
            <span className="fact-v">{ev.evaluation_currency}</span>
          </div>
        </div>
        <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {ev.status === 'DRAFT' && <button className="btn" data-tip={t('tip_publish')} onClick={() => act('publish')}>{t('publish')}</button>}
          {ev.status === 'CLOSED' && ev.format === 'SEALED' && (
            <button className="btn" data-tip={t('tip_open_bids')} onClick={() => act('open')}>{t('open_bids')}</button>
          )}
          {ev.status === 'CLOSED' && ev.format === 'REVERSE' && (
            <button className="btn" data-tip={t('tip_finalize')} onClick={() => act('auction/finalize')}>{t('finalize')}</button>
          )}
          <button className="btn ghost" data-tip={t('tip_ocds')} onClick={openOcds}>{t('ocds')}</button>
          {(ev.awards ?? []).filter((a: any) => !a.cancelled_at).map((a: any) => (
            <button key={a.id} className="btn" data-tip={t('tip_make_contract')} onClick={async () => {
              try {
                const c = await api.post(`/contracts/from-award/${a.id}`);
                await api.post(`/contracts/${c.data.id}/activate`);
                window.location.href = '/buyer/contracts';
              } catch (e: any) { notifyError(e); }
            }}>{t('make_contract')} · {ev.lots.find((l: any) => l.id === a.lot_id)?.title}</button>
          ))}
        </div>
        {/* OCDS is three letters that mean nothing to a procurement officer in Baku unless
            somebody writes them out. The hover tip has done so since wave 1; this is the
            visible line, because that button is the only place the acronym ever appears. */}
        <div className="hint" style={{ marginTop: 8 }}>{t('ocds_hint')}</div>
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

      {(['PUBLISHED', 'OPEN'].includes(ev.status) || fups.some((f: any) => f.enrolled)) && (() => {
        const bidding = ['PUBLISHED', 'OPEN'].includes(ev.status);
        const isAdmin = session?.org.role === 'BUYER_ADMIN';
        const chIco = (c: string) => (c === 'WHATSAPP' ? '📱' : '✉️');
        const chName = (c: string) => t(`ch_${c}`);
        const hoursTo = (iso: string) => Math.max(1, Math.round((new Date(iso).getTime() - Date.now()) / 3600_000));
        const planSteps: Array<{ channel: string; afterHours: number }> = fuPlan?.steps ?? [];
        const eligible = fups.filter((f: any) => !f.enrolled && !f.has_bid);
        const fuAct = async (fn: () => Promise<unknown>) => {
          try { await fn(); loadFups(); } catch (e: any) {
            if (e.response?.data?.code==='DELIVERY_ALREADY_CONFIRMED') { loadFups(); notify(t('delivery_already_confirmed'), 'info'); }
            else notifyError(e);
          }
        };
        // One visual step chip: icon + channel + when; state colours the chip.
        const StepChip = ({ s, state, hint }: { s: any; state: 'done' | 'next' | 'todo' | 'off'; hint?: string }) => (
          <span className="chip" data-tip={hint} style={{
            marginRight: 4,
            opacity: state === 'off' ? 0.35 : state === 'todo' ? 0.55 : 1,
            borderColor: state === 'next' ? 'var(--accent2)' : undefined,
            background: state === 'done' ? 'var(--ok-bg, #e7f6ec)' : undefined,
          }}>
            {state === 'done' ? '✓ ' : ''}{chIco(s.channel)} {state === 'todo' || state === 'next' ? `+${s.afterHours} ${t('hours_short')}` : chName(s.channel)}
          </span>
        );
        return (
          <div className="card">
            <h3>⏰ {t('followups')}</h3>
            <p className="hint" style={{ marginTop: 2 }}>{t('followups_desc')}</p>

            {/* The org-wide chain plan, visible before anything is enrolled — so the
                buyer sees exactly WHAT will happen. Admin edits it inline. */}
            <div style={{ margin: '8px 0 12px' }}>
              <span className="hint" style={{ marginRight: 8 }}>{t('followups_plan')}:</span>
              {!fuEditing && planSteps.map((s, i) => (
                <span key={i} className="chip" style={{ marginRight: 4 }}
                  data-tip={`${i + 1}. ${chName(s.channel)} — +${s.afterHours} ${t('hours_short')}`}>
                  {chIco(s.channel)} +{s.afterHours} {t('hours_short')}
                </span>
              ))}
              {!fuEditing && isAdmin && (
                <button className="btn small ghost" style={{ marginLeft: 6 }}
                  onClick={() => { setFuDraft(planSteps.map((s) => ({ ...s }))); setFuEditing(true); }}>
                  ✎ {t('followups_edit')}
                </button>
              )}
              {fuEditing && (
                <div className="fu-editor">
                  {fuDraft.map((s, i) => (
                    <div className="fu-step" key={i}>
                      <span className="fu-step-no">{i + 1}</span>
                      <select value={s.channel} onChange={(e) => setFuDraft(fuDraft.map((x, j) => j === i ? { ...x, channel: e.target.value } : x))}>
                        <option value="EMAIL">✉️ {t('ch_EMAIL')}</option>
                        <option value="WHATSAPP">📱 {t('ch_WHATSAPP')}</option>
                      </select>
                      <span className="fu-delay">
                        {t('fu_after_pre')}
                        <input type="number" min={1} max={2160} value={s.afterHours}
                          onChange={(e) => setFuDraft(fuDraft.map((x, j) => j === i ? { ...x, afterHours: Number(e.target.value) } : x))} />
                        {t('fu_after_post')}
                      </span>
                      <button className="fu-del" data-tip={t('followups_remove_step')}
                        onClick={() => setFuDraft(fuDraft.filter((_, j) => j !== i))}>✕</button>
                    </div>
                  ))}
                  <div className="fu-actions">
                    <button className="btn small ghost" disabled={fuDraft.length >= 10}
                      onClick={() => setFuDraft([...fuDraft, { channel: 'EMAIL', afterHours: 24 }])}>＋ {t('followups_add_step')}</button>
                    <button className="btn small" disabled={!fuDraft.length}
                      onClick={() => fuAct(async () => {
                        const r = await api.put('/settings/followup-plan', { steps: fuDraft });
                        setFuPlan(r.data); setFuEditing(false);
                      })}>{t('followups_save')}</button>
                    <button className="btn small ghost" onClick={() => setFuEditing(false)}>{t('followups_cancel')}</button>
                  </div>
                </div>
              )}
            </div>

            {fups.length === 0 ? (
              <p className="hint">{t('followups_none_invited')}</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>{t('supplier_org')}</th><th>{t('status')}</th>
                    <th>{t('followups_plan')}</th><th>{t('actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {fups.map((f: any) => {
                    const steps: any[] = f.enrolled ? (f.steps ?? []) : planSteps;
                    const msgs: any[] = f.messages ?? [];
                    const open = fuOpenRow === f.supplier_org_id;
                    return (
                      <Fragment key={f.supplier_org_id}>
                        <tr>
                          <td>{f.supplier_name}</td>
                          <td>
                            {f.has_bid && !f.enrolled && <span className="badge is-good">✓ {t('fu_has_bid')}</span>}
                            {!f.has_bid && !f.enrolled && <span className="badge is-neutral">{t('fu_NOT_ENROLLED')}</span>}
                            {f.enrolled && (
                              <span className={`badge ${f.status === 'RESPONDED' ? 'is-good' : f.status === 'ACTIVE' ? 'is-progress' : 'is-bad'} ${f.status}`}
                                data-tip={t(`tip_fu_${f.status}`) !== `tip_fu_${f.status}` ? t(`tip_fu_${f.status}`) : undefined}>
                                {f.status === 'RESPONDED' ? '✓ ' : ''}{t(`fu_${f.status}`)}
                              </span>
                            )}
                          </td>
                          <td>
                            {steps.map((s: any, i: number) => {
                              const done = f.enrolled && i < f.current_step;
                              const isNext = f.enrolled && f.status === 'ACTIVE' && i === f.current_step;
                              const off = f.enrolled && f.status !== 'ACTIVE' && i >= f.current_step;
                              const sentMsg = msgs.find((m: any) => m.step_no === i);
                              const hint = done && sentMsg
                                ? `${chName(s.channel)} · ${fmtDateTime(sentMsg.at)} · ${sentMsg.recipient}`
                                : isNext && f.next_run_at
                                  ? t('fu_next_in').replace('{h}', String(hoursTo(f.next_run_at)))
                                  : `${chName(s.channel)} — +${s.afterHours}${t('hours_short')}`;
                              return <StepChip key={i} s={s} hint={hint} state={done ? 'done' : isNext ? 'next' : off ? 'off' : 'todo'} />;
                            })}
                            {f.enrolled && f.status === 'ACTIVE' && f.next_run_at && (
                              <span className="hint" style={{ marginLeft: 4 }}>
                                → {t('fu_next_in').replace('{h}', String(hoursTo(f.next_run_at)))}
                              </span>
                            )}
                            {f.sent_count > 0 && (
                              <button className="btn small ghost" style={{ marginLeft: 6 }}
                                onClick={() => setFuOpenRow(open ? null : f.supplier_org_id)}>
                                {t('followups_history')} ({f.sent_count}) {open ? '▴' : '▾'}
                              </button>
                            )}
                          </td>
                          <td>
                            {!f.enrolled && !f.has_bid && bidding && (
                              <button className="btn small" data-tip={t('tip_followups_enroll')}
                                onClick={() => fuAct(() => api.post(`/events/${id}/followups`, { supplierOrgIds: [f.supplier_org_id] }))}>
                                ▶ {t('followups_enroll_one')}
                              </button>
                            )}
                            {(f.jobs ?? []).filter((j:any)=>['BUYER_ADMIN','BUYER_APPROVER'].includes(session?.org.role ?? '') && ['UNKNOWN','FAILED','NOT_CONFIGURED'].includes(j.status)).map((j:any)=><div key={j.id}>
                              <span>{t(`delivery_${j.status}`)} · {j.recipient}</span>
                              <button className="btn small ghost" disabled={j.delivery_confirmed} data-tip={j.delivery_confirmed ? t('delivery_already_confirmed') : undefined} onClick={async ()=>{
                                const reason = await ask({ title: t('delivery_reconcile_reason'), label: t('reason'), required: true, minLength: 10 });
                                if (!reason) return;
                                fuAct(()=>api.post(`/events/${id}/followups/jobs/${j.id}/reconcile`,{decision:'CONFIRMED_NOT_SENT',reason}));
                              }}>{t('delivery_confirm_not_sent')}</button>
                            </div>)}
                            {f.enrolled && f.status === 'ACTIVE' && (
                              <button className="btn small ghost"
                                onClick={() => fuAct(() => api.post(`/events/${id}/followups/${f.supplier_org_id}/stop`))}>
                                ⏹ {t('followups_stop')}
                              </button>
                            )}
                          </td>
                        </tr>
                        {open && (
                          <tr>
                            <td colSpan={4} style={{ background: 'var(--card2, #fafafa)' }}>
                              {msgs.map((m: any, i: number) => (
                                <div key={i} className="hint" style={{ padding: '2px 0' }}>
                                  {chIco(m.channel)} {fmtDateTime(m.at)} → {m.recipient} · {t(`delivery_${m.status}`)}
                                </div>
                              ))}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}

            {bidding && eligible.length > 1 && (
              <button className="btn small" style={{ marginTop: 8 }} data-tip={t('tip_followups_enroll')}
                onClick={() => fuAct(() => api.post(`/events/${id}/followups`, {}))}>
                ▶▶ {t('followups_enroll')} ({eligible.length})
              </button>
            )}
          </div>
        );
      })()}

      {ev.format === 'REVERSE' && <AuctionPanel eventId={id!} />}

      <div className="card">
        <h3>{t('items')} · {t('lots')}</h3>
        {ev.status === 'DRAFT' && (
          <button className="btn small ghost" style={{ marginBottom: 8 }} data-tip={t('tip_add_lot')}
            onClick={async () => {
              const title = await ask({ title: t('lot_new_title'), label: t('title'), required: true,
                defaultValue: `Lot ${ev.lots.length + 1}` });
              if (!title) return;
              try { await api.post(`/events/${id}/lots`, { title }); load(); } catch (e: any) { notifyError(e); }
            }}>
            + {t('lots')}
          </button>
        )}
        <table>
          <thead><tr><th>{t('name')}</th><th>{t('qty')}</th><th className="num">{t('unit_price')} (est.)</th><th>{t('lots')}</th></tr></thead>
          <tbody>
            {ev.items.map((i: any) => (
              <tr key={i.id}>
                <td>{i.name}</td><td>{Number(i.qty)}</td><td className="num">{fmtMoney(i.est_unit_price_minor, ev.evaluation_currency)}</td>
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
              .filter((t2: any) => (ev.bids ?? []).find((b: any) => b.id === t2.bid_id)?.state === 'OPENED')
              .sort((a: any, b: any) => (isReverse ? 0 : (weightedByBid.get(b.bid_id) ?? -1) - (weightedByBid.get(a.bid_id) ?? -1))
                || Number(a.total_minor) - Number(b.total_minor));
            // A price winner is meaningful for a reverse auction. Sealed offers use the
            // current formal evaluation; do not suggest a winner before scoring or on a tie.
            const topScore = totals.length ? weightedByBid.get(totals[0].bid_id) : undefined;
            const uniqueScoreLeader = topScore !== undefined && totals.filter((t2: any) => weightedByBid.get(t2.bid_id) === topScore).length === 1;
            return (
              <div key={l.id} role="group" aria-label={l.title} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                <b>{l.title}</b>{' '}
                {awarded && (
                  <>
                    <span className="badge is-good AWARDED">🏆 {t('st_AWARDED')}</span>{' '}
                    <button className="btn small ghost" data-tip={t('cancel_award_prompt')} onClick={() => cancelAward(l.id)}>✕ {t('cancel_award')}</button>
                    {awarded.justification && <div className="hint" style={{ marginTop: 4 }}>📝 {awarded.justification}</div>}
                  </>
                )}
                {!awarded && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                    {totals.map((t2: any, idx: number) => {
                      const bid = (ev.bids ?? []).find((b: any) => b.id === t2.bid_id);
                      // The ⭐ on the leading offer had nothing to say why it was there.
                      const leader = idx === 0 && (isReverse || uniqueScoreLeader);
                      return (
                        <button key={t2.bid_id} className={`btn small ${leader ? '' : 'ghost'}`}
                          disabled={!isReverse && !weightedByBid.has(t2.bid_id)}
                          data-tip={leader ? t('tip_award_leader') : t('tip_award_bid')}
                          onClick={() => awardBid(l.id, t2.bid_id)}>
                          {bid?.supplier_name} · {fmtMoney(t2.total_minor, ev.evaluation_currency)}{leader ? ' ⭐' : ''}
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
        <h3>{t('bids')} {!ev.amounts_visible && <span className="sealed">🔒 {t('amounts_hidden')}</span>}</h3>
        <table>
          {/* The score heading used the `score` key — the same entry as the «Score» BUTTON
              below the table — so the column was titled with an imperative verb
              («Qiymətləndir», «Оценить»: «go and score it!»), and «89.0» never said out of
              what. Criterion weights sum to exactly 100 and each score is 0–100, so the
              weighted total is out of 100 — said on the heading, explained in its tip. */}
          <thead><tr>
            <th>{t('supplier_org')}</th><th>{t('status')}</th>
            <th className="num">{t('total')}</th><th>{t('delivery_days')}</th>
            {showScores && <th className="num" data-tip={t('score_col_tip')}>{t('score_col')} / 100</th>}
            {showBidActions && <th>{t('actions')}</th>}
          </tr></thead>
          <tbody>
            {(ev.bids ?? []).map((b: any) => (
              <tr key={b.id} style={winningBidIds.has(b.id) ? { outline: '1px solid var(--ok)' } : undefined}>
                <td>
                  {/* A trophy beside the name and a green outline on the row were the only
                      marks the winner carried — neither of them a word. */}
                  {b.supplier_name}
                  {winningBidIds.has(b.id) && (() => {
                    // WHICH lot. On a multi-lot tender two different suppliers each win one,
                    // and the bids table has no lot column — so two rows both marked
                    // «Winner» read as a contradiction. Found by looking at the screenshot
                    // the acceptance run leaves behind; it is invisible in the code.
                    const won = activeAwards.find((a: any) => a.winning_bid_id === b.id);
                    const lot = (ev.lots ?? []).length > 1
                      ? (ev.lots ?? []).find((l: any) => l.id === won?.lot_id)?.title : null;
                    return <> <span className="badge is-good AWARDED">🏆 {t('winner')}{lot ? ` · ${lot}` : ''}</span></>;
                  })()}
                  {b.proposal_text && (
                    <div className="hint" style={{ whiteSpace: 'pre-wrap', maxWidth: 420, marginTop: 4 }}>
                      📝 {b.proposal_text}
                    </div>
                  )}
                  {ev.amounts_visible && <BidDocs bidId={b.id} canUpload={false} />}
                </td>
                <td><Badge status={b.state} /></td>
                <td className="num">{ev.amounts_visible ? fmtMoney(b.total_minor, b.currency) : '🔒'}</td>
                <td>{ev.amounts_visible ? (b.delivery_days ?? '—') : '🔒'}</td>
                {showScores && <td className="num">{weightedByBid.has(b.id) ? weightedByBid.get(b.id)!.toFixed(1) : '—'}</td>}
                {showBidActions && (
                <td>
                  {ev.status === 'EVALUATION' && !isReverse && !isRfi && b.state === 'OPENED' && (
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      {!activeAwards.length && (ev.evaluation_criteria ?? []).map((c: any) => <label key={c.key}>
                        {c.key} · {c.weight}%
                        <input style={{width:64}} type="number" min={0} max={100} required
                          value={scores[b.id]?.[c.key] ?? ''}
                          onChange={e => setScores({...scores,[b.id]:{...scores[b.id],[c.key]:e.target.value === '' ? NaN : Number(e.target.value)}})} />
                      </label>)}
                      {!winningBidIds.has(b.id) && <button className="btn small ghost danger" data-tip={t('disqualify_prompt')} onClick={() => disqualify(b.id)}>⛔ {t('disqualify')}</button>}
                    </span>
                  )}
                  {b.state === 'DISQUALIFIED' && b.disqualified_reason && (
                    <span className="hint" data-tip={b.disqualified_reason}>⛔ {b.disqualified_reason}</span>
                  )}
                </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {ev.status === 'EVALUATION' && !activeAwards.length && !isReverse && !isRfi && (ev.bids ?? []).some((b: any) => b.state === 'OPENED') && (
          <div style={{ marginTop: 12 }}>
            <button className="btn ghost" aria-label={t('score')} data-tip={t('tip_score')} onClick={doEvaluate}>{t('score')}</button>
          </div>
        )}
      </div>

      {canAi && (
        <div className="card" style={{ borderColor: 'var(--accent2)' }}>
          {/* The lot picker used to float BETWEEN two cards, outside both, labelled only by
              an aria-label: a bare dropdown in the gap, belonging to nothing the eye could
              see. It belongs to this card and now sits in it, named. */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0 }}>🤖 {t('ai_reco')}</h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              {ev.lots.length > 1 && (
                <div className="filter-field">
                  <label htmlFor="ai-lot">{t('lots')}</label>
                  <select id="ai-lot" value={aiLot || ev.lots[0]?.id} onChange={e => {setAiLot(e.target.value);setAi(null);}}>
                    {(ev.lots ?? []).map((l: any) => <option key={l.id} value={l.id}>{l.title}</option>)}
                  </select>
                </div>
              )}
              {/* ↻ alone was the whole label once a ranking had been fetched. */}
              <button className="btn small" data-tip={t('tip_ai')} onClick={askAi}>{ai ? `↻ ${t('ai_run')}` : t('ai_run')}</button>
            </div>
          </div>
          {/* A whole card for one button, and nothing on it said what pressing the button
              does — or that what comes back is advice and the choice stays the buyer's. */}
          <p className="hint" style={{ marginTop: 6 }}>{t('ai_reco_hint')}</p>
          {ai && (
            <>
              <div style={{ margin: '10px 0', color: 'var(--accent)' }}>{ai.rationale}</div>
              <table>
                {/* Every one of these four columns is a SCORE out of 100, not an amount
                    and not a number of days: «Price 100» in a column headed «Unit price»
                    reads as a price of one manat. */}
                <thead><tr><th>#</th><th>{t('supplier_org')}</th>
                  <th className="num">{t('crit_price')} / 100</th>
                  <th className="num">{t('crit_delivery')} / 100</th>
                  <th className="num">{t('reliability')} / 100</th>
                  {/* NOT score_col_tip: this total is weighted by the scorer's own three
                      weights, printed under the table, not by the event's locked criteria. */}
                  <th className="num">{t('score_col')} / 100</th>
                  <th></th></tr></thead>
                <tbody>
                  {ai.ranking.map((r: any, i: number) => (
                    <tr key={r.bidId} style={r.bidId === ai.recommendedBidId ? { outline: '1px solid var(--accent2)' } : undefined}>
                      <td>{i + 1}</td>
                      <td>{r.supplierName}{r.bidId === ai.recommendedBidId ? ' 🤖' : ''}
                        <div className="hint">{r.reasons.join(' · ')}</div></td>
                      <td className="num">{r.priceScore}</td>
                      <td className="num">{r.deliveryScore}</td>
                      <td className="num">{r.reliabilityScore}</td>
                      <td className="num"><b>{r.weightedTotal}</b></td>
                      <td>
                        {ev.status === 'EVALUATION' && !aiLotAwarded && selectedAiLotId && (
                          <button className="btn small" data-tip={t('tip_award_bid')} onClick={() => awardBid(selectedAiLotId, r.bidId)}>{t('award')}</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="hint" style={{ marginTop: 6 }}>
                {t('ai_model')}: {ai.model} · {t('crit_price')} {ai.weights.price * 100}% / {t('crit_delivery')} {ai.weights.delivery * 100}% / {t('reliability')} {ai.weights.reliability * 100}%
              </div>
            </>
          )}
        </div>
      )}

      <QnaCard eventId={id!} isBuyer />
    </>
  );
}
