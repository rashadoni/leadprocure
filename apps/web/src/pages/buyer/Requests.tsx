import { FormEvent, Fragment, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtDate, fmtMoney } from '../../api/client';
import { useAuth } from '../../auth/auth';
import { useI18n } from '../../i18n';
import Pager from '../../components/Pager';
import { Badge } from '../../components/Badge';

const PAGE_SIZE = 20;

interface Item { name: string; qty: number; price: string }

export default function Requests() {
  const { t } = useI18n();
  const { session } = useAuth();
  const nav = useNavigate();
  const [rows, setRows] = useState<any[]>([]);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [items, setItems] = useState<Item[]>([{ name: '', qty: 1, price: '' }]);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [directFor, setDirectFor] = useState<string | null>(null);
  const [approvedSuppliers, setApprovedSuppliers] = useState<any[]>([]);
  const [cats, setCats] = useState<string[]>([]);
  // Departments (cost centres) — which budget this spend lands on. Only active ones can
  // be picked for new requests; retired ones stay on their historic requests.
  const [deps, setDeps] = useState<any[]>([]);
  const [department, setDepartment] = useState('');
  const [depFilter, setDepFilter] = useState('');
  useEffect(() => { api.get('/categories').then((r) => setCats(r.data.map((c: any) => c.code))).catch(() => {}); }, []);
  useEffect(() => { api.get('/departments').then((r) => setDeps(r.data)).catch(() => {}); }, []);
  const canApprove = ['BUYER_ADMIN', 'BUYER_APPROVER'].includes(session?.org.role ?? '');
  const isFinance = session?.org.role === 'BUYER_FINANCE';
  const isAdmin = session?.org.role === 'BUYER_ADMIN';

  const load = () => api.get('/requests', { params: { ...(q ? { q } : {}), ...(depFilter ? { departmentId: depFilter } : {}), page, pageSize: PAGE_SIZE } })
    .then((r) => { setRows(r.data.items); setTotal(r.data.total); });
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [q, page, depFilter]);

  const openDirect = async (id: string) => {
    const r = await api.get('/suppliers');
    setApprovedSuppliers(r.data.filter((x: any) => x.status === 'APPROVED'));
    setDirectFor(id);
  };
  const placeDirect = async (requestId: string, supplierOrgId: string) => {
    try {
      await api.post(`/orders/direct/from-request/${requestId}`, { supplierOrgId });
      setDirectFor(null);
      nav('/buyer/contracts');
    } catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
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
    } catch (e: any) { setErr(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  const act = async (id: string, action: string) => {
    try { await api.post(`/requests/${id}/${action}`); load(); }
    catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  // Cancelling releases the budget commitment, so the reason is required and audited.
  const cancelRequest = async (id: string) => {
    const reason = prompt(t('cancel_reason_prompt'));
    if (!reason || reason.trim().length < 3) return;
    try { await api.post(`/requests/${id}/cancel`, { reason: reason.trim() }); load(); }
    catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  // Forced look-before-approve: the first click reveals the line items, the second
  // actually approves — nobody waves 36 000 ₼ through without seeing what's in it.
  const [preview, setPreview] = useState<Record<string, any>>({});
  const [impact, setImpact] = useState<Record<string, any>>({});
  const approveGuard = async (id: string) => {
    if (!preview[id]) {
      const { data } = await api.get(`/requests/${id}`);
      setPreview((p) => ({ ...p, [id]: data }));
      // what this approval does to the budget — shown before the second click, not after
      api.get(`/budgets/impact/${id}`)
        .then((r) => setImpact((m) => ({ ...m, [id]: r.data ?? null })))
        .catch(() => {});
      return;
    }
    try {
      await api.post(`/requests/${id}/approve`);
    } catch (e: any) {
      // 403 = a budget block threshold; an admin may push through with a written reason
      const msg = e.response?.data?.message?.toString() ?? 'Error';
      if (e.response?.status === 403 && isAdmin && impact[id]?.wouldBlock) {
        const reason = prompt(`${msg}\n\n${t('bud_override_prompt')}`);
        if (!reason || reason.trim().length < 3) return;
        try { await api.post(`/requests/${id}/approve`, { budgetOverrideReason: reason.trim() }); }
        catch (e2: any) { alert(e2.response?.data?.message?.toString() ?? 'Error'); return; }
      } else { alert(msg); return; }
    }
    load();
    setPreview((p) => { const q = { ...p }; delete q[id]; return q; });
    setImpact((m) => { const q = { ...m }; delete q[id]; return q; });
  };

  const makeRfq = async (id: string, type: 'RFQ' | 'RFP' | 'RFI' = 'RFQ') => {
    try {
      const closeAt = new Date(Date.now() + 24 * 3600_000).toISOString();
      const ev = await api.post(`/events/from-request/${id}`, { closeAt, visibility: 'INVITED', type });
      nav(`/buyer/events/${ev.data.id}`);
    } catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
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
    } catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  return (
    <>
      <h1>{t('requests')}</h1>
      {!isFinance && <div className="card">
        <form onSubmit={create}>
          <div className="row">
            <div style={{ flex: 2 }}><label htmlFor="request-title">{t('title')}</label>
              <input id="request-title" data-testid="req-title" value={title} onChange={(e) => setTitle(e.target.value)} required /></div>
            <div style={{ flex: 1 }}><label>{t('category')}</label>
              {/* category drives the method policy, budgets and per-category analytics */}
              <input data-testid="req-category" value={category} onChange={(e) => setCategory(e.target.value)}
                placeholder="IT, construction…" list="req-categories" />
              <datalist id="req-categories">
                {/* curated categories (Settings) first, plus any already used on requests */}
                {[...new Set([...cats, ...rows.map((r) => r.category).filter((c) => c && c !== '*')])].map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist></div>
            <div style={{ flex: 1 }}><label>{t('department')}</label>
              {/* the department owns the budget this spend is charged to */}
              <select data-testid="req-department" value={department} onChange={(e) => setDepartment(e.target.value)}>
                <option value="">{t('dep_default')}</option>
                {deps.filter((d) => d.is_active).map((d) => (
                  <option key={d.id} value={d.id}>{d.code}{d.name ? ` · ${d.name}` : ''}</option>
                ))}
              </select></div>
          </div>
          <h3>{t('items')}</h3>
          {items.map((it, idx) => (
            <div className="row" key={idx}>
              <div><label htmlFor={`request-item-${idx}-name`}>{t('name')}</label>
                <input id={`request-item-${idx}-name`} data-testid={`item-name-${idx}`} value={it.name} onChange={(e) => setItems(items.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x)))} /></div>
              <div><label htmlFor={`request-item-${idx}-qty`}>{t('qty')}</label>
                <input id={`request-item-${idx}-qty`} data-testid={`item-qty-${idx}`} type="number" min={1} value={it.qty} onChange={(e) => setItems(items.map((x, i) => (i === idx ? { ...x, qty: Number(e.target.value) } : x)))} /></div>
              <div><label htmlFor={`request-item-${idx}-price`}>{t('unit_price')} (AZN)</label>
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
        <table>
          <thead><tr><th>#</th><th>{t('title')}</th><th>{t('category')}</th><th>{t('department')}</th><th>{t('date')}</th><th>{t('requester')}</th><th>{t('total')}</th><th>{t('status')}</th><th>{t('method')}</th><th>{t('actions')}</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.id}>
              <tr>
                <td>{r.request_no}</td>
                <td>{r.title}</td>
                <td>{r.category && r.category !== '*' ? r.category : '—'}</td>
                <td>{r.department_code ?? '—'}</td>
                <td className="hint">{fmtDate(r.created_at)}</td>
                <td className="hint">{r.created_by_name ?? '—'}</td>
                <td>{fmtMoney(r.estimated_total_minor, r.currency)}</td>
                <td>
                  <Badge status={r.status} />
                  {r.status === 'SUBMITTED' && r.steps_total > 0 && (
                    <div className="hint">✔ {r.steps_done}/{r.steps_total} · {r.current_role}</div>
                  )}
                </td>
                <td>{r.method_resolved ?? '—'}</td>
                <td>
                  {r.status === 'DRAFT' && !isFinance && <button className="btn small" data-tip={t('tip_submit')} onClick={() => act(r.id, 'submit')}>{t('submit')}</button>}{' '}
                  {r.status === 'SUBMITTED' && (canApprove || (isFinance && r.current_role === 'BUYER_FINANCE')) && (
                    <>
                      <button className="btn small" data-tip={t('tip_approve')} onClick={() => approveGuard(r.id)}>
                        {preview[r.id] ? `✔ ${t('confirm_approve')}` : t('approve')}
                      </button>{' '}
                      <button className="btn small ghost" data-tip={t('tip_reject')} onClick={() => act(r.id, 'reject')}>{t('reject')}</button>
                    </>
                  )}
                  {/* an abandoned approval keeps holding budget until it is cancelled */}
                  {r.status === 'APPROVED' && isAdmin && (
                    <button className="btn small ghost" data-tip={t('tip_cancel_request')} onClick={() => cancelRequest(r.id)}>
                      {t('cancel')}
                    </button>
                  )}{' '}
                  {r.status === 'APPROVED' && r.method_resolved !== 'DIRECT' && canApprove && (
                    <>
                      <button className="btn small" data-tip={t('tip_rfq')} onClick={() => makeRfq(r.id)}>RFQ 🔒</button>{' '}
                      <button className="btn small ghost" data-tip={t('tip_rfp')} onClick={() => makeRfq(r.id, 'RFP')}>RFP 📄</button>{' '}
                      <button className="btn small ghost" data-tip={t('tip_rfi')} onClick={() => makeRfq(r.id, 'RFI')}>RFI ❓</button>{' '}
                      <button className="btn small ghost" data-tip={t('tip_auction')} onClick={() => makeAuction(r)}>{t('auction')} ⚡</button>
                    </>
                  )}
                  {r.status === 'APPROVED' && r.method_resolved === 'DIRECT' && canApprove && (
                    directFor === r.id ? (
                      <span style={{ display: 'inline-flex', gap: 6 }}>
                        <select id={`sup-${r.id}`} defaultValue="">
                          <option value="" disabled>{t('supplier_org')}…</option>
                          {approvedSuppliers.map((s) => <option key={s.supplier_org_id} value={s.supplier_org_id}>{s.legal_name}</option>)}
                        </select>
                        <button className="btn small" onClick={() => {
                          const v = (document.getElementById(`sup-${r.id}`) as HTMLSelectElement).value;
                          if (v) placeDirect(r.id, v);
                        }}>OK</button>
                      </span>
                    ) : (
                      <button className="btn small" data-tip={t('tip_direct')} onClick={() => openDirect(r.id)}>{t('direct_order')} 📦</button>
                    )
                  )}
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
                            <td>{fmtMoney(it.est_unit_price_minor, r.currency)}</td>
                            <td>{fmtMoney(it.est_total_minor, r.currency)}</td>
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
