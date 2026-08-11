import { FormEvent, Fragment, useEffect, useState } from 'react';
import { api, fmtDate, fmtMoney } from '../../api/client';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/auth';
import { useI18n } from '../../i18n';

interface Budget {
  id: string;
  status: 'DRAFT' | 'PENDING' | 'APPROVED' | 'CLOSED';
  name: string;
  category: string;
  periodYear: number;
  departmentId: string | null;
  departmentCode: string | null;
  departmentName: string | null;
  periodType: 'YEAR' | 'QUARTER' | 'MONTH';
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  currency: string;
  amountMinor: number;
  committedMinor: number;
  actualMinor: number;
  usedMinor: number;
  remainingMinor: number;
  utilizationPct: number;
}

// Parse the amount from its DIGITS, not through a float: Number('12.10') * 100 is
// 1209.9999… and Math.round hides it only most of the time. Budgets are money.
function toMinor(input: string): number {
  const [whole = '0', frac = ''] = input.trim().replace(',', '.').split('.');
  const cents = (frac + '00').slice(0, 2);
  const sign = whole.startsWith('-') ? -1 : 1;
  return sign * (Math.abs(Number(whole || 0)) * 100 + Number(cents));
}

const THIS_YEAR = new Date().getFullYear();
const THIS_QUARTER = Math.floor(new Date().getMonth() / 3) + 1;
const THIS_MONTH = new Date().getMonth() + 1;
const empty = {
  name: '', category: '', departmentId: '', periodType: 'YEAR' as Budget['periodType'],
  periodYear: THIS_YEAR, periodQuarter: THIS_QUARTER, periodMonth: THIS_MONTH,
  amount: '', reason: '',
};

export default function Budgets() {
  const { t } = useI18n();
  const { session } = useAuth();
  const isAdmin = session?.org.role === 'BUYER_ADMIN';
  const [rows, setRows] = useState<Budget[]>([]);
  const [form, setForm] = useState({ ...empty });
  const [editId, setEditId] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const [deps, setDeps] = useState<any[]>([]);
  const [unbudgeted, setUnbudgeted] = useState<any[]>([]);
  const [policy, setPolicy] = useState<{ warnPct: number; blockPct: number | null; allowOverride: boolean } | null>(null);
  useEffect(() => { api.get('/departments').then((r) => setDeps(r.data)).catch(() => {}); }, []);
  useEffect(() => { api.get('/budgets/policy').then((r) => setPolicy(r.data)).catch(() => {}); }, []);

  // Period + department filter over the list, all optional.
  const [filter, setFilter] = useState({ periodType: '', year: '', departmentId: '' });
  const load = () => {
    api.get('/budgets', {
      params: {
        ...(filter.periodType ? { periodType: filter.periodType } : {}),
        ...(filter.year ? { year: filter.year } : {}),
        ...(filter.departmentId ? { departmentId: filter.departmentId } : {}),
      },
    }).then((r) => setRows(r.data));
    api.get('/budgets/rollup', {
      params: {
        ...(filter.periodType ? { periodType: filter.periodType } : {}),
        ...(filter.year ? { year: filter.year } : {}),
      },
    }).then((r) => setDepSummary(r.data)).catch(() => setDepSummary([]));
    // approved spend no budget covers — invisible in a per-budget table, so it gets its own panel
    api.get('/budgets/unbudgeted').then((r) => setUnbudgeted(r.data)).catch(() => setUnbudgeted([]));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filter.periodType, filter.year, filter.departmentId]);

  // Per-department rollup: what finance actually opens the page for. Server-side, because
  // "paid" comes from settled invoices — the client only has the budget rows.
  const [depSummary, setDepSummary] = useState<any[]>([]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    const body = {
      name: form.name,
      category: form.category.trim() || '*',
      ...(form.departmentId ? { departmentId: form.departmentId } : {}),
      periodType: form.periodType,
      periodYear: Number(form.periodYear),
      ...(form.periodType === 'QUARTER' ? { periodQuarter: Number(form.periodQuarter) } : {}),
      ...(form.periodType === 'MONTH' ? { periodMonth: Number(form.periodMonth) } : {}),
      amountMinor: toMinor(form.amount),
      currency: 'AZN',
      ...(form.reason.trim() ? { reason: form.reason.trim() } : {}),
    };
    try {
      if (editId) await api.put(`/budgets/${editId}`, body);
      else await api.post('/budgets', body);
      setForm({ ...empty });
      setEditId(null);
      load();
    } catch (e: any) { setErr(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  const edit = (b: Budget) => {
    const month = Number(b.periodStart.slice(5, 7));
    setEditId(b.id);
    setForm({
      name: b.name,
      category: b.category === '*' ? '' : b.category,
      periodType: b.periodType,
      periodYear: Number(b.periodStart.slice(0, 4)),
      periodQuarter: Math.floor((month - 1) / 3) + 1,
      periodMonth: month,
      departmentId: b.departmentId ?? '',
      amount: String(b.amountMinor / 100),
      reason: '', // each change explains itself; never carry the previous reason over
    });
  };
  const remove = async (id: string) => {
    if (!confirm(t('bud_delete_confirm'))) return;
    try { await api.delete(`/budgets/${id}`); load(); }
    catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  // Auth-guarded CSV download (a plain <a> would hit the API without the bearer token).
  const exportCsv = async () => {
    try {
      const { data } = await api.get('/budgets/export', {
        params: {
          ...(filter.periodType ? { periodType: filter.periodType } : {}),
          ...(filter.year ? { year: filter.year } : {}),
          ...(filter.departmentId ? { departmentId: filter.departmentId } : {}),
        },
        responseType: 'blob',
      });
      const url = URL.createObjectURL(data as Blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'budgets.csv'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  // Lifecycle actions. A budget is a document: drafted, submitted, approved by someone
  // else, and finally closed when the period is signed off.
  const act = async (id: string, action: string, body?: Record<string, unknown>) => {
    try { await api.post(`/budgets/${id}/${action}`, body ?? {}); load(); }
    catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };
  const withReason = (id: string, action: string, promptKey: string) => {
    const reason = prompt(t(promptKey));
    if (!reason || reason.trim().length < 3) return;
    act(id, action, { reason: reason.trim() });
  };

  // Drill-down: the documents behind a number, opened inline under the budget row. A
  // controller's first question about any total is "made of what?".
  const [docs, setDocs] = useState<Record<string, any[]>>({});
  const toggleDocs = async (id: string, kind?: 'committed' | 'actual') => {
    if (docs[id]) { setDocs((d) => { const n = { ...d }; delete n[id]; return n; }); return; }
    const { data } = await api.get(`/budgets/${id}/documents`, { params: kind ? { kind } : {} });
    setDocs((d) => ({ ...d, [id]: data }));
  };

  // Revision history, opened inline under the budget row.
  const [history, setHistory] = useState<Record<string, any[]>>({});
  const toggleHistory = async (id: string) => {
    if (history[id]) { setHistory((h) => { const n = { ...h }; delete n[id]; return n; }); return; }
    const { data } = await api.get(`/budgets/${id}/revisions`);
    setHistory((h) => ({ ...h, [id]: data }));
  };

  // Rollover: carry another period's unspent remainder into this budget.
  const rollover = async (targetId: string) => {
    const candidates = rows.filter((b) => b.id !== targetId && b.remainingMinor > 0);
    if (!candidates.length) { alert(t('bud_rollover_none')); return; }
    const pick = prompt(
      `${t('bud_rollover_prompt')}\n\n${candidates.map((b, i) => `${i + 1}. ${b.name} (${b.periodLabel}) — ${fmtMoney(b.remainingMinor, b.currency)}`).join('\n')}`,
    );
    const idx = Number(pick) - 1;
    if (!(idx >= 0 && idx < candidates.length)) return;
    try { await api.post(`/budgets/${targetId}/rollover`, { sourceBudgetId: candidates[idx].id }); load(); }
    catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  return (
    <>
      <h1>{t('budgets')}</h1>
      {isAdmin && (
        <div className="card">
          <form onSubmit={submit} className="row" style={{ alignItems: 'flex-end' }}>
            <div><label>{t('name')}</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
            <div><label>{t('category')} </label>
              <input placeholder="*" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></div>
            <div><label>{t('department')}</label>
              {/* empty = org-wide ceiling; a department budget always wins over it */}
              <select value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })}>
                <option value="">{t('bud_org_wide')}</option>
                {deps.filter((d) => d.is_active || d.id === form.departmentId).map((d) => (
                  <option key={d.id} value={d.id}>{d.code}</option>
                ))}
              </select></div>
            <div><label>{t('period')}</label>
              <select value={form.periodType} onChange={(e) => setForm({ ...form, periodType: e.target.value as Budget['periodType'] })}>
                <option value="YEAR">{t('period_year')}</option>
                <option value="QUARTER">{t('period_quarter')}</option>
                <option value="MONTH">{t('period_month')}</option>
              </select></div>
            <div><label>{t('year')}</label>
              <input type="number" value={form.periodYear} onChange={(e) => setForm({ ...form, periodYear: Number(e.target.value) })} required /></div>
            {form.periodType === 'QUARTER' && (
              <div><label>{t('period_quarter')}</label>
                <select value={form.periodQuarter} onChange={(e) => setForm({ ...form, periodQuarter: Number(e.target.value) })}>
                  {[1, 2, 3, 4].map((qq) => <option key={qq} value={qq}>Q{qq}</option>)}
                </select></div>
            )}
            {form.periodType === 'MONTH' && (
              <div><label>{t('period_month')}</label>
                <select value={form.periodMonth} onChange={(e) => setForm({ ...form, periodMonth: Number(e.target.value) })}>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((mm) => (
                    <option key={mm} value={mm}>{String(mm).padStart(2, '0')}</option>
                  ))}
                </select></div>
            )}
            {/* budgets are AZN-only: foreign-currency orders are reported separately, never
                converted at a guessed rate */}
            <div><label>{t('amount')} (AZN)</label>
              <input type="number" step="0.01" min={0} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required /></div>
            <div><label>{t('reason')}</label>
              {/* goes into the revision ledger, so a changed plan can always be explained */}
              <input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}
                placeholder={editId ? t('bud_reason_ph_edit') : t('bud_reason_ph_new')} /></div>
            <div>
              <button className="btn">{editId ? t('save') : t('create')}</button>
              {editId && <button type="button" className="btn ghost" onClick={() => { setEditId(null); setForm({ ...empty }); }} style={{ marginLeft: 6 }}>✕</button>}
            </div>
          </form>
          {err && <div className="error">{err}</div>}
        </div>
      )}
      {/* The thresholds themselves are an organisation-wide RULE, and they live in Settings
          next to the approval chain. What belongs here is their current state, where it
          takes effect — read-only, one line, with a way to go change it. */}
      {policy && (
        <div className="hint" style={{ marginBottom: 14 }}>
          {t('bud_thresholds')}: {t('bud_warn_pct')} {policy.warnPct}% ·{' '}
          {t('bud_block_pct')} {policy.blockPct == null ? t('bud_block_off') : `${policy.blockPct}%`}
          {isAdmin && <> · <Link to="/buyer/settings">{t('bud_thresholds_edit')}</Link></>}
        </div>
      )}

      {depSummary.length > 0 && (
        <div className="card">
          <h3>{t('bud_by_department')}</h3>
          <table>
            <thead><tr>
              <th>{t('department')}</th><th>{t('amount')}</th><th>{t('committed')}</th><th>{t('actual')}</th>
              <th>{t('paid')}</th><th>{t('remaining')}</th><th>{t('forecast')}</th><th style={{ width: 180 }}>{t('utilization')}</th>
            </tr></thead>
            <tbody>
              {depSummary.map((d) => {
                const over = d.remainingMinor < 0;
                return (
                  <tr key={d.departmentId ?? 'org'}>
                    <td style={{ paddingLeft: 10 + (d.depth ?? 0) * 18 }}>
                      <b>{d.departmentCode ?? t('bud_org_wide')}</b>
                      {/* a parent's figures include its units — say so, or the totals look wrong */}
                      {d.includesChildren && <span className="hint" data-tip={t('bud_rollup_tip')}> ⤵</span>}
                    </td>
                    <td>{fmtMoney(d.amountMinor, d.currency)}</td>
                    <td>{fmtMoney(d.committedMinor, d.currency)}</td>
                    <td>{fmtMoney(d.actualMinor, d.currency)}</td>
                    {/* settlement of orders already counted as actual — shown beside, never summed in */}
                    <td className="hint" data-tip={t('paid_hint')}>{fmtMoney(d.paidMinor, d.currency)}</td>
                    <td className={over ? 'error' : ''}>{fmtMoney(d.remainingMinor, d.currency)}</td>
                    {/* where the period lands at the current rate — the question that follows "how much is left" */}
                    <td className={d.forecastOverMinor > 0 ? 'error' : 'hint'} data-tip={t('forecast_hint')}>
                      {fmtMoney(d.forecastMinor, d.currency)}
                      {d.forecastOverMinor > 0 && <span> · +{fmtMoney(d.forecastOverMinor, d.currency)}</span>}
                    </td>
                    <td>
                      <div className="budget-bar">
                        <div className={`budget-fill ${over ? 'over' : ''}`} style={{ width: `${Math.min(100, d.utilizationPct)}%` }} />
                      </div>
                      <span className="hint">{d.utilizationPct}%{over ? ` · ${t('budget_over')}` : ''}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          <select value={filter.periodType} onChange={(e) => setFilter({ ...filter, periodType: e.target.value })} style={{ maxWidth: 200 }}>
            <option value="">{t('period_all')}</option>
            <option value="YEAR">{t('period_year')}</option>
            <option value="QUARTER">{t('period_quarter')}</option>
            <option value="MONTH">{t('period_month')}</option>
          </select>
          <input type="number" placeholder={t('year')} value={filter.year}
            onChange={(e) => setFilter({ ...filter, year: e.target.value })} style={{ maxWidth: 140 }} />
          <select value={filter.departmentId} onChange={(e) => setFilter({ ...filter, departmentId: e.target.value })} style={{ maxWidth: 220 }}>
            <option value="">{t('dep_all')}</option>
            {deps.map((d) => <option key={d.id} value={d.id}>{d.code}</option>)}
          </select>
          <button className="btn ghost small" onClick={exportCsv}>⤓ CSV</button>
          {isAdmin && (
            <>
              {/* Bulk entry: thirty department budgets through a one-row form is what pushes
                  finance back into a spreadsheet. Everything lands as a draft. */}
              <button className="btn ghost small" data-tip={t('bud_import_tip')}
                onClick={() => document.getElementById('bud-import')?.click()}>⤒ {t('bud_import')}</button>
              <input id="bud-import" type="file" accept=".csv,text/csv" style={{ display: 'none' }}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  try {
                    const res = await api.post('/budgets/import', { csv: await file.text() });
                    alert(`${t('bud_imported')}: ${res.data.imported}`);
                    load();
                  } catch (err: any) { alert(err.response?.data?.message?.toString() ?? 'Error'); }
                }} />
            </>
          )}
        </div>
        <table>
          <thead><tr>
            <th>{t('name')}</th><th>{t('status')}</th><th>{t('category')}</th><th>{t('department')}</th><th>{t('period')}</th>
            <th>{t('amount')}</th><th>{t('committed')}</th><th>{t('actual')}</th><th>{t('remaining')}</th>
            <th style={{ width: 180 }}>{t('utilization')}</th>{isAdmin && <th>{t('actions')}</th>}
          </tr></thead>
          <tbody>
            {rows.map((b) => {
              const over = b.remainingMinor < 0;
              return (
                <Fragment key={b.id}>
                <tr>
                  <td>{b.name}</td>
                  <td><span className={`badge ${b.status}`} data-tip={t(`bud_st_${b.status}`)}>{t(`bud_status_${b.status}`)}</span></td>
                  <td>{b.category === '*' ? '—' : b.category}</td>
                  <td data-tip={b.departmentName || undefined}>{b.departmentCode ?? t('bud_org_wide')}</td>
                  <td data-tip={`${b.periodStart} → ${b.periodEnd}`}>{b.periodLabel}</td>
                  <td>{fmtMoney(b.amountMinor, b.currency)}</td>
                  <td data-tip={t('drill_hint')}>
                    <button className="linklike" onClick={() => toggleDocs(b.id, 'committed')}>{fmtMoney(b.committedMinor, b.currency)}</button>
                  </td>
                  <td data-tip={t('drill_hint')}>
                    <button className="linklike" onClick={() => toggleDocs(b.id, 'actual')}>{fmtMoney(b.actualMinor, b.currency)}</button>
                  </td>
                  <td className={over ? 'error' : ''}>{fmtMoney(b.remainingMinor, b.currency)}</td>
                  <td>
                    <div className="budget-bar">
                      <div className={`budget-fill ${over ? 'over' : ''}`} style={{ width: `${Math.min(100, b.utilizationPct)}%` }} />
                    </div>
                    <span className="hint">{b.utilizationPct}%{over ? ` · ${t('budget_over')}` : ''}</span>
                  </td>
                  {isAdmin && (
                    <td>
                      {b.status === 'DRAFT' && (
                        <>
                          <button className="btn small ghost" data-tip={t('tip_edit')} onClick={() => edit(b)}>✎</button>{' '}
                          <button className="btn small" data-tip={t('bud_submit_tip')} onClick={() => act(b.id, 'submit')}>{t('submit')}</button>{' '}
                        </>
                      )}
                      {b.status === 'PENDING' && (
                        <>
                          <button className="btn small" data-tip={t('bud_approve_tip')} onClick={() => act(b.id, 'approve')}>{t('approve')}</button>{' '}
                          <button className="btn small ghost" data-tip={t('bud_reject_tip')} onClick={() => withReason(b.id, 'reject', 'bud_reject_prompt')}>{t('reject')}</button>{' '}
                          <button className="btn small ghost" data-tip={t('bud_recall_tip')} onClick={() => act(b.id, 'recall')}>↩</button>{' '}
                        </>
                      )}
                      {b.status === 'APPROVED' && (
                        <>
                          <button className="btn small ghost" data-tip={t('bud_revise_tip')} onClick={() => edit(b)}>✎</button>{' '}
                          <button className="btn small ghost" data-tip={t('bud_close_tip')} onClick={() => act(b.id, 'close')}>🔒</button>{' '}
                        </>
                      )}
                      {b.status === 'CLOSED' && (
                        <button className="btn small ghost" data-tip={t('bud_reopen_tip')} onClick={() => withReason(b.id, 'reopen', 'bud_reopen_prompt')}>🔓</button>
                      )}{' '}
                      <button className="btn small ghost" data-tip={t('bud_history')} onClick={() => toggleHistory(b.id)}>🕘</button>{' '}
                      <button className="btn small ghost" data-tip={t('bud_rollover')} onClick={() => rollover(b.id)}>↪</button>{' '}
                      {b.status === 'DRAFT' && (
                        <button className="btn small ghost" data-tip={t('tip_delete')} onClick={() => remove(b.id)}>🗑</button>
                      )}
                    </td>
                  )}
                </tr>
                {docs[b.id] && (
                  <tr>
                    <td colSpan={isAdmin ? 11 : 10} style={{ background: 'rgba(4,120,87,0.04)' }}>
                      <b>{t('drill_title')}</b>
                      {docs[b.id].length === 0 && <div className="hint">—</div>}
                      {docs[b.id].length > 0 && (
                        <table style={{ margin: '6px 0' }}>
                          <thead><tr>
                            <th>#</th><th>{t('title')}</th><th>{t('category')}</th><th>{t('department')}</th>
                            <th>{t('date')}</th><th>{t('amount')}</th>
                          </tr></thead>
                          <tbody>
                            {docs[b.id].map((d: any) => (
                              <tr key={`${d.kind}-${d.id}`}>
                                <td>{d.docNo}</td>
                                <td>{d.title ?? t('bud_calloff')}</td>
                                <td>{d.category ?? '—'}</td>
                                <td>{d.departmentCode ?? '—'}</td>
                                <td className="hint">{fmtDate(d.datedAt)}</td>
                                <td>{fmtMoney(d.amountMinor, b.currency)}<span className="hint"> · {t(`drill_${d.bucket}`)}</span></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </td>
                  </tr>
                )}
                {history[b.id] && (
                  <tr>
                    <td colSpan={isAdmin ? 11 : 10} style={{ background: 'rgba(79,140,255,0.05)' }}>
                      <b>{t('bud_history')}</b>
                      <table style={{ margin: '6px 0' }}>
                        <thead><tr>
                          <th>{t('date')}</th><th>{t('amount')}</th><th>{t('bud_delta')}</th>
                          <th>{t('reason')}</th><th>{t('requester')}</th>
                        </tr></thead>
                        <tbody>
                          {history[b.id].map((r: any) => (
                            <tr key={r.id}>
                              <td className="hint">{fmtDate(r.createdAt)}</td>
                              <td>{fmtMoney(r.amountAfterMinor, b.currency)}</td>
                              <td className={r.deltaMinor != null && r.deltaMinor < 0 ? 'error' : ''}>
                                {r.deltaMinor == null ? '—' : `${r.deltaMinor > 0 ? '+' : ''}${fmtMoney(r.deltaMinor, b.currency)}`}
                              </td>
                              <td>{r.reason ?? '—'}</td>
                              <td className="hint">{r.createdByName ?? '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={isAdmin ? 11 : 10} className="hint">—</td></tr>}
          </tbody>
        </table>
      </div>

      {unbudgeted.length > 0 && (
        <div className="card">
          <h3>⚠ {t('bud_unbudgeted')}</h3>
          <div className="hint" style={{ marginBottom: 10 }}>{t('bud_unbudgeted_hint')}</div>
          <table>
            <thead><tr>
              <th>#</th><th>{t('title')}</th><th>{t('category')}</th><th>{t('department')}</th>
              <th>{t('date')}</th><th>{t('amount')}</th><th>{t('currency')}</th>
            </tr></thead>
            <tbody>
              {unbudgeted.map((u) => (
                <tr key={u.id ?? u.requestId}>
                  <td>{u.docNo ?? u.requestNo}</td>
                  {/* an ORDER row is a catalog call-off: no request, no title, no category */}
                  <td>{u.title ?? (u.kind === 'ORDER' ? t('bud_calloff') : '—')}</td>
                  <td>{u.category ?? '—'}</td>
                  <td>{u.departmentCode ?? '—'}</td>
                  <td className="hint">{fmtDate(u.approvedAt)}</td>
                  <td>{fmtMoney(u.amountMinor, u.currency)}</td>
                  {/* a non-AZN order can never hit an AZN budget — that is why it is here */}
                  <td className={u.currency !== 'AZN' ? 'error' : 'hint'}>{u.currency}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
