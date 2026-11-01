import { FormEvent, Fragment, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtDate, fmtMoney } from '../../api/client';
import { useAuth } from '../../auth/auth';
import { useI18n } from '../../i18n';
import { useDialogs } from '../../components/Dialogs';
import Pager from '../../components/Pager';
import { Badge } from '../../components/Badge';
import { isDenied, ListState, useLoad } from '../../components/ListState';
import { Actions } from '../../components/Actions';

const PAGE_SIZE = 20;

interface Item { name: string; qty: number; price: string }

export default function Requests() {
  const { t } = useI18n();
  const { notifyError, notify, ask } = useDialogs();
  const { session } = useAuth();
  const nav = useNavigate();
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [items, setItems] = useState<Item[]>([{ name: '', qty: 1, price: '' }]);
  // The form used to be the first thing on the screen, so arriving at «Заявки» showed a
  // blank form and pushed the list of requests — the reason to come here — below the fold.
  // It opens on a worded button now. It does NOT close after a successful create: the
  // owner weighed the extra click against entering requests in a batch, and a form that
  // shut itself every time would charge that click per request instead of once.
  const [formOpen, setFormOpen] = useState(false);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [directFor, setDirectFor] = useState<string | null>(null);
  const [approvedSuppliers, setApprovedSuppliers] = useState<any[]>([]);
  const [cats, setCats] = useState<string[]>([]);
  // Departments (cost centres) — which budget this spend lands on. Only active ones can
  // be picked for new requests; retired ones stay on their historic requests.
  const [deps, setDeps] = useState<any[]>([]);
  const [department, setDepartment] = useState('');
  const [depFilter, setDepFilter] = useState('');
  // These two fill the category and department selects, and the department decides whose
  // budget the spend lands on. A fresh org legitimately has neither (and may be denied
  // them), but a dead request must not quietly leave the author with no choice to make.
  // Both carry only @Roles over the four buyer roles — no licence gate — so on a buyer
  // page every failure of theirs is a real one.
  const [refFailed, setRefFailed] = useState(false);
  // The budget projection shown between the two approval clicks keeps its OWN flag: on one
  // shared boolean a successful projection would have cleared a dead /departments (the
  // page then claims it loaded while the control choosing whose budget pays is broken),
  // and Retry would have re-run the reference reads instead of the projection that failed.
  // Every row whose projection failed, not just the latest: with one id, a retry that
  // succeeded on the second row cleared the alert while the first row's figure was still
  // missing — and that row's preview is already cached, so the next click approves it.
  const [impactFailed, setImpactFailed] = useState<string[]>([]);
  // An org without the budgets licence is denied this and the projection is simply absent.
  // Any other failure means the approver confirms without the figure they were promised.
  const loadImpact = (id: string) => api.get(`/budgets/impact/${id}`)
    .then((r) => {
      setImpact((m) => ({ ...m, [id]: r.data ?? null }));
      setImpactFailed((f) => f.filter((x) => x !== id));
    })
    .catch((e: any) => { if (!isDenied(e)) setImpactFailed((f) => (f.includes(id) ? f : [...f, id])); });
  const loadRefs = () => {
    setRefFailed(false);
    const broken = () => setRefFailed(true);
    api.get('/categories').then((r) => setCats(r.data.map((c: any) => c.code))).catch(broken);
    api.get('/departments').then((r) => setDeps(r.data)).catch(broken);
  };
  useEffect(loadRefs, []);
  const canApprove = ['BUYER_ADMIN', 'BUYER_APPROVER'].includes(session?.org.role ?? '');
  const isFinance = session?.org.role === 'BUYER_FINANCE';
  const isAdmin = session?.org.role === 'BUYER_ADMIN';

  const requests = useLoad(
    () => api.get('/requests', { params: { ...(q ? { q } : {}), ...(depFilter ? { departmentId: depFilter } : {}), page, pageSize: PAGE_SIZE } })
      .then((r) => r.data),
    [q, page, depFilter], { items: [] as any[], total: 0 },
  );
  // A failed page change must not leave the PREVIOUS page's rows sitting under the new
  // page number: on failure the alert stands alone.
  const rows: any[] = requests.failed ? [] : (requests.data.items ?? []);
  const total: number = requests.data.total ?? 0;
  const load = () => requests.reload();

  // Which procedure each row's dropdown is showing, keyed by request id; unset means "the
  // one the method policy resolved".
  //
  // OPEN is the open procedure: the same sealed-price event as RFQ, published to every
  // supplier instead of a named list. It exists because procurement_method bands a request
  // into DIRECT / RFQ / OPEN_TENDER, and OPEN_TENDER had nothing to announce it with — the
  // Method column said OPEN_TENDER while the control beside it offered RFQ, and one click
  // produced an invitation-only tender. For a product sold against UNCITRAL and exporting
  // OCDS (where visibility === 'PUBLIC' is what makes procurementMethod "open") that is the
  // central procedure, so it was reachable on the server and missing from the product.
  const [procedure, setProcedure] = useState<Record<string, string>>({});
  const defaultProcedure = (r: any) =>
    (r.method_resolved === 'OPEN_TENDER' ? 'OPEN'
      : ['RFQ', 'RFP', 'RFI'].includes(r.method_resolved) ? r.method_resolved : 'RFQ');
  const announce = (r: any) => {
    const pick = procedure[r.id] ?? defaultProcedure(r);
    if (pick === 'AUCTION') return makeAuction(r);
    // Only the open procedure publishes to everyone; the other three are addressed to the
    // suppliers the buyer invites, which is what their labels say.
    if (pick === 'OPEN') return makeRfq(r.id, 'RFQ', 'PUBLIC');
    return makeRfq(r.id, pick as 'RFQ' | 'RFP' | 'RFI');
  };

  // The chosen supplier used to be read back out of the DOM by element id at click time.
  const [directSupplier, setDirectSupplier] = useState('');
  const openDirect = async (id: string) => {
    const r = await api.get('/suppliers');
    setApprovedSuppliers(r.data.filter((x: any) => x.status === 'APPROVED'));
    setDirectSupplier('');
    setDirectFor(id);
  };
  const placeDirect = async (requestId: string, supplierOrgId: string) => {
    try {
      await api.post(`/orders/direct/from-request/${requestId}`, { supplierOrgId });
      setDirectFor(null);
      nav('/buyer/contracts');
    } catch (e: any) { notifyError(e); }
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      await api.post('/requests', {
        title,
        ...(category.trim() ? { category: category.trim() } : {}),
        ...(department ? { departmentId: department } : {}),
        items: items
          .filter((i) => i.name)
          .map((i) => ({ name: i.name, qty: Number(i.qty), estUnitPriceMinor: Math.round(Number(i.price) * 100) })),
      });
      setTitle('');
      setCategory('');
      setDepartment('');
      setItems([{ name: '', qty: 1, price: '' }]);
      load();
    } catch (e: any) { setErr(e.response?.data?.message?.toString() ?? t('error_generic')); }
  };

  const act = async (id: string, action: string) => {
    try { await api.post(`/requests/${id}/${action}`); load(); }
    catch (e: any) { notifyError(e); }
  };

  // Cancelling releases the budget commitment, so the reason is required and audited.
  const cancelRequest = async (id: string) => {
    const reason = await ask({
      title: t('cancel_reason_prompt'), label: t('reason'), required: true, minLength: 3,
      hint: t('cancel_request_hint'), confirmLabel: t('cancel_request'), danger: true,
    });
    if (!reason || reason.trim().length < 3) return;
    try { await api.post(`/requests/${id}/cancel`, { reason: reason.trim() }); load(); }
    catch (e: any) { notifyError(e); }
  };

  // Forced look-before-approve: the first click reveals the line items, the second
  // actually approves — nobody waves 36 000 ₼ through without seeing what's in it.
  const [preview, setPreview] = useState<Record<string, any>>({});
  const [impact, setImpact] = useState<Record<string, any>>({});
  const approvalError = (e: any) => {
    switch (e.response?.data?.code) {
      case 'BUDGET_LIMIT_EXCEEDED': return t('bud_approval_blocked');
      case 'BUDGET_OVERRIDE_FORBIDDEN': return t('bud_override_forbidden');
      case 'REQUEST_SELF_APPROVAL_FORBIDDEN': return t('request_self_approval_forbidden');
      default: return e.response?.data?.message?.toString() ?? t('error_generic');
    }
  };
  const approveGuard = async (id: string) => {
    if (!preview[id]) {
      const { data } = await api.get(`/requests/${id}`);
      setPreview((p) => ({ ...p, [id]: data }));
      // what this approval does to the budget — shown before the second click, not after
      loadImpact(id);
      return;
    }
    try {
      await api.post(`/requests/${id}/approve`);
    } catch (e: any) {
      // Only the current server decision can authorize an override, never a cached preview.
      const msg = approvalError(e);
      if (e.response?.status === 403 && e.response.data?.code === 'BUDGET_LIMIT_EXCEEDED'
        && e.response.data.canOverride === true && isAdmin) {
        const reason = await ask({
          title: t('bud_override_prompt'), label: t('reason'), required: true, minLength: 3,
          hint: t('bud_override_hint'), confirmLabel: t('approve'),
        });
        if (!reason || reason.trim().length < 3) return;
        try { await api.post(`/requests/${id}/approve`, { budgetOverrideReason: reason.trim() }); }
        catch (e2: any) { notify(approvalError(e2), 'error'); return; }
      } else { notify(msg, 'error'); return; }
    }
    load();
    setPreview((p) => { const q = { ...p }; delete q[id]; return q; });
    setImpact((m) => { const q = { ...m }; delete q[id]; return q; });
  };

  const makeRfq = async (id: string, type: 'RFQ' | 'RFP' | 'RFI' = 'RFQ', visibility: 'PUBLIC' | 'INVITED' = 'INVITED') => {
    try {
      const closeAt = new Date(Date.now() + 24 * 3600_000).toISOString();
      const ev = await api.post(`/events/from-request/${id}`, { closeAt, visibility, type });
      nav(`/buyer/events/${ev.data.id}`);
    } catch (e: any) { notifyError(e); }
  };

  // Reverse auction: start at the estimate, min decrement = 1% (floor 1 AZN).
  const makeAuction = async (r: any) => {
    try {
      const start = Number(r.estimated_total_minor);
      const ev = await api.post(`/events/reverse/from-request/${r.id}`, {
        closeAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
        visibility: 'INVITED',
        startPriceMinor: start,
        minDecrementMinor: Math.max(Math.round(start / 100), 100),
      });
      nav(`/buyer/events/${ev.data.id}`);
    } catch (e: any) { notifyError(e); }
  };

  return (
    <>
      <h1>{t('requests')}</h1>
      <ListState of={{ loading: false, failed: refFailed, reload: loadRefs }} />
      {!isFinance && !formOpen && (
        <button className="btn" data-testid="req-new" data-tip={t('tip_new_request')}
          onClick={() => setFormOpen(true)} style={{ marginBottom: 12 }}>
          + {t('new_request')}
        </button>
      )}
      {!isFinance && formOpen && <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>{t('new_request')}</h3>
          <button type="button" className="btn small ghost" onClick={() => setFormOpen(false)}>
            ✕ {t('form_hide')}
          </button>
        </div>
        <form onSubmit={create}>
          <div className="row">
            <div style={{ flex: 2 }}><label htmlFor="request-title">{t('title')}</label>
              <input id="request-title" data-testid="req-title" value={title} onChange={(e) => setTitle(e.target.value)} required /></div>
            <div style={{ flex: 1 }}><label htmlFor="request-category">{t('category')}</label>
              {/* category drives the method policy, budgets and per-category analytics */}
              <input id="request-category" data-testid="req-category" value={category} onChange={(e) => setCategory(e.target.value)}
                placeholder="IT, construction…" list="req-categories" />
              <datalist id="req-categories">
                {/* curated categories (Settings) first, plus any already used on requests */}
                {[...new Set([...cats, ...rows.map((r) => r.category).filter((c) => c && c !== '*')])].map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist></div>
            <div style={{ flex: 1 }}><label htmlFor="request-department">{t('department')}</label>
              {/* the department owns the budget this spend is charged to */}
              <select id="request-department" data-testid="req-department" value={department} onChange={(e) => setDepartment(e.target.value)}>
                <option value="">{t('dep_default')}</option>
                {deps.filter((d) => d.is_active).map((d) => (
                  <option key={d.id} value={d.id}>{d.code}{d.name ? ` · ${d.name}` : ''}</option>
                ))}
              </select></div>
          </div>
          <h3>{t('items')}</h3>
          {items.map((it, idx) => (
            <div className="row" key={idx}>
              <div style={{ flex: 3 }}><label htmlFor={`request-item-${idx}-name`}>{t('name')}</label>
                <input id={`request-item-${idx}-name`} data-testid={`item-name-${idx}`} value={it.name} onChange={(e) => setItems(items.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x)))} /></div>
              <div style={{ flex: '0 0 110px' }}><label htmlFor={`request-item-${idx}-qty`}>{t('qty')}</label>
                <input id={`request-item-${idx}-qty`} data-testid={`item-qty-${idx}`} type="number" min={1} value={it.qty} onChange={(e) => setItems(items.map((x, i) => (i === idx ? { ...x, qty: Number(e.target.value) } : x)))} /></div>
              <div style={{ flex: '0 0 170px' }}><label htmlFor={`request-item-${idx}-price`}>{t('unit_price')} (AZN)</label>
                <input id={`request-item-${idx}-price`} data-testid={`item-price-${idx}`} type="number" step="0.01" min={0} value={it.price} onChange={(e) => setItems(items.map((x, i) => (i === idx ? { ...x, price: e.target.value } : x)))} /></div>
            </div>
          ))}
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button type="button" className="btn ghost small" onClick={() => setItems([...items, { name: '', qty: 1, price: '' }])}>+ {t('items')}</button>
            <button className="btn">{t('create')}</button>
          </div>
          {err && <div className="error">{err}</div>}
        </form>
      </div>}
      <div className="card">
        <div style={{ display: 'flex', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
          <input placeholder={`🔎 ${t('title')}…`} value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} style={{ maxWidth: 320 }} />
          <select value={depFilter} onChange={(e) => { setDepFilter(e.target.value); setPage(1); }} style={{ maxWidth: 220 }}>
            <option value="">{t('dep_all')}</option>
            {deps.map((d) => <option key={d.id} value={d.id}>{d.code}</option>)}
          </select>
        </div>
        <div className="hint" style={{ marginBottom: 10 }}>
          {t('legend_procedures')}
          {['BUYER_ADMIN', 'BUYER_APPROVER'].includes(session?.org.role ?? '') && (
            <> · <a href="/buyer/settings">⚖️ {t('method_policy')}</a></>
          )}
        </div>
        <ListState of={[requests,
          { loading: false, failed: impactFailed.length > 0,
            reload: () => impactFailed.forEach((id) => loadImpact(id)) }]}
          empty={!rows.length} />
        <table>
          <thead><tr><th>#</th><th>{t('title')}</th><th>{t('category')}</th><th>{t('department')}</th><th className="nowrap">{t('date')}</th><th>{t('requester')}</th><th className="num">{t('total')}</th><th>{t('status')}</th><th>{t('method')}</th><th>{t('actions')}</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.id}>
              <tr>
                <td className="nowrap">{r.request_no}</td>
                <td>{r.title}</td>
                <td>{r.category && r.category !== '*' ? r.category : '—'}</td>
                <td>{r.department_code ?? '—'}</td>
                <td className="hint nowrap">{fmtDate(r.created_at)}</td>
                <td className="hint">{r.created_by_name ?? '—'}</td>
                <td className="num">{fmtMoney(r.estimated_total_minor, r.currency)}</td>
                <td>
                  <Badge status={r.status} />
                  {r.status === 'SUBMITTED' && r.steps_total > 0 && (
                    <div className="hint">✔ {r.steps_done}/{r.steps_total} · {r.current_role ? t(`role_${r.current_role}`) : '—'}</div>
                  )}
                </td>
                {/* RFQ and DIRECT read as themselves; OPEN_TENDER read as a database
                    code sitting next to a control that now says "open tender" in words. */}
                <td className="nowrap">{r.method_resolved === 'OPEN_TENDER' ? t('open_tender') : (r.method_resolved ?? '—')}</td>
                <td>
                  {/* Cancelling releases the budget this request is holding and demands a
                      written reason, so it is the one destructive action here and sits at the
                      end. Rejecting is not destructive — it is one half of a binary decision —
                      so it stays beside Approve where an approver expects it. */}
                  <Actions
                    danger={r.status === 'APPROVED' && isAdmin && (
                      <button className="btn small ghost danger" data-tip={t('tip_cancel_request')} onClick={() => cancelRequest(r.id)}>
                        {t('cancel')}
                      </button>
                    )}
                  >
                    {r.status === 'DRAFT' && !isFinance && <button className="btn small" data-tip={t('tip_submit')} onClick={() => act(r.id, 'submit')}>{t('submit')}</button>}
                    {r.status === 'SUBMITTED' && (canApprove || (isFinance && r.current_role === 'BUYER_FINANCE')) && (
                      <>
                        <button className="btn small" aria-label={preview[r.id] ? t('confirm_approve') : t('approve')} data-tip={t('tip_approve')} onClick={() => approveGuard(r.id)}>
                          {preview[r.id] ? `✔ ${t('confirm_approve')}` : t('approve')}
                        </button>
                        <button className="btn small ghost" data-tip={t('tip_reject')} onClick={() => act(r.id, 'reject')}>{t('reject')}</button>
                      </>
                    )}
                    {/* One decision, one control. These four are mutually exclusive ways of
                        running the same purchase, and as four equal buttons they read as
                        four commands — which is why they needed a legend underneath to be
                        understood at all. The method policy already resolved the right one,
                        so it is preselected and the common case stays a single click. */}
                    {r.status === 'APPROVED' && r.method_resolved !== 'DIRECT' && canApprove && (
                      <>
                        <select aria-label={t('method_pick')} value={procedure[r.id] ?? defaultProcedure(r)}
                          onChange={(e) => setProcedure((m) => ({ ...m, [r.id]: e.target.value }))}>
                          <option value="RFQ">🔒 RFQ</option>
                          <option value="OPEN">🌐 {t('open_tender')}</option>
                          <option value="RFP">📄 RFP</option>
                          <option value="RFI">❓ RFI</option>
                          <option value="AUCTION">⚡ {t('auction')}</option>
                        </select>
                        <button className="btn small" data-tip={t('tip_announce')} onClick={() => announce(r)}>{t('announce')}</button>
                      </>
                    )}
                    {r.status === 'APPROVED' && r.method_resolved === 'DIRECT' && canApprove && (
                      directFor === r.id ? (
                        <>
                          <select aria-label={t('supplier_org')} value={directSupplier} onChange={(e) => setDirectSupplier(e.target.value)}>
                            <option value="" disabled>{t('supplier_org')}…</option>
                            {approvedSuppliers.map((s) => <option key={s.supplier_org_id} value={s.supplier_org_id}>{s.legal_name}</option>)}
                          </select>
                          <button className="btn small" disabled={!directSupplier}
                            data-tip={directSupplier ? t('tip_place_direct') : t('pick_supplier_first')}
                            onClick={() => placeDirect(r.id, directSupplier)}>{t('confirm')}</button>
                        </>
                      ) : (
                        <button className="btn small" data-tip={t('tip_direct')} onClick={() => openDirect(r.id)}>📦 {t('direct_order')}</button>
                      )
                    )}
                  </Actions>
                </td>
              </tr>
              {preview[r.id] && (
                <tr>
                  <td colSpan={10} style={{ background: 'rgba(79,140,255,0.05)' }}>
                    <b>{t('items')}</b>
                    <table style={{ margin: '6px 0' }}>
                      <thead><tr><th>{t('name')}</th><th>{t('qty')}</th><th>{t('unit_price')}</th><th>{t('total')}</th></tr></thead>
                      <tbody>
                        {preview[r.id].items.map((it: any) => (
                          <tr key={it.id}>
                            <td>{it.name}</td>
                            <td>{Number(it.qty)} {it.uom}</td>
                            <td className="num">{fmtMoney(it.est_unit_price_minor, r.currency)}</td>
                            <td className="num">{fmtMoney(it.est_total_minor, r.currency)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {/* the money question, answered before the approve click, not after */}
                    {impact[r.id] === null && <div className="hint">{t('bud_impact_none')}</div>}
                    {impact[r.id] && (
                      <div style={{ marginBottom: 6 }}>
                        <b>{t('bud_impact')}:</b>{' '}
                        {impact[r.id].departmentCode ? `${impact[r.id].departmentCode} · ` : ''}
                        {impact[r.id].budgetName} ({impact[r.id].periodLabel}) —{' '}
                        {fmtMoney(impact[r.id].projectedUsedMinor, impact[r.id].currency)} /{' '}
                        {fmtMoney(impact[r.id].amountMinor, impact[r.id].currency)}{' '}
                        <span className={impact[r.id].wouldWarn ? 'error' : ''}>
                          ({impact[r.id].projectedPct}%)
                        </span>
                      </div>
                    )}
                    <span className="hint">{t('tip_approve')}</span>
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
          </tbody>
        </table>
        <Pager total={total} page={page} pageSize={PAGE_SIZE} onPage={setPage} />
      </div>
    </>
  );
}
