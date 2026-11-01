import { FormEvent, Fragment, useEffect, useRef, useState } from 'react';
import { api, fmtDate, fmtMoney } from '../../api/client';
import { statusGroup } from '../../components/Badge';
import { Actions } from '../../components/Actions';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/auth';
import { useI18n } from '../../i18n';
import { useDialogs } from '../../components/Dialogs';
import { isDenied, ListState } from '../../components/ListState';

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
  const { notify, notifyError, ask, confirm } = useDialogs();
  const { session } = useAuth();
  const canManagePlans = ['BUYER_ADMIN', 'BUYER_FINANCE'].includes(session?.org.role ?? '');
  const canReadOrgReports = ['BUYER_ADMIN', 'BUYER_FINANCE', 'BUYER_APPROVER'].includes(session?.org.role ?? '');
  const [rows, setRows] = useState<Budget[]>([]);
  const [form, setForm] = useState({ ...empty });
  const [editId, setEditId] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const [deps, setDeps] = useState<any[]>([]);
  const [unbudgeted, setUnbudgeted] = useState<any[]>([]);
  const [policy, setPolicy] = useState<{ warnPct: number; blockPct: number | null; allowOverride: boolean } | null>(null);
  // Choosing no department writes an ORG-WIDE plan, which is a different plan from a
  // departmental one — so an empty select must never be a dead read. /departments has no
  // licence gate, hence no exemption; the policy does, hence one.
  const [refFailed, setRefFailed] = useState(false);
  const loadRefs = () => {
    setRefFailed(false);
    api.get('/departments').then((r) => setDeps(r.data)).catch(() => setRefFailed(true));
    api.get('/budgets/policy').then((r) => setPolicy(r.data))
      .catch((e: any) => { if (!isDenied(e)) setRefFailed(true); });
  };
  useEffect(loadRefs, []);

  // Period + department filter over the list, all optional.
  const [filter, setFilter] = useState({ periodType: '', year: '', departmentId: '' });
  const activeFilter = useRef(filter);
  activeFilter.current = filter;
  const loadVersion = useRef(0);
  const [reportLoading, setReportLoading] = useState(true);
  const [reportError, setReportError] = useState(false);
  // Per-department rollup is server-side; paid spend is not derivable from plan rows.
  const [depSummary, setDepSummary] = useState<any[]>([]);
  const load = async () => {
    const version = ++loadVersion.current;
    // A completed mutation may still hold an older render's load callback.
    // Always reload the filters currently displayed on screen.
    const selected = activeFilter.current;
    const period = {
      ...(selected.periodType ? { periodType: selected.periodType } : {}),
      ...(selected.year ? { year: selected.year } : {}),
    };
    setReportLoading(true); setReportError(false);
    setRows([]); setDepSummary([]); setUnbudgeted([]);
    const results = await Promise.allSettled([
      api.get('/budgets', { params: { ...period, ...(selected.departmentId ? { departmentId: selected.departmentId } : {}) } }),
      api.get('/budgets/rollup', { params: period }),
      // BUYER_USER can read scoped plans/rollup, but not the org-wide spend report.
      canReadOrgReports ? api.get('/budgets/unbudgeted') : Promise.resolve({ data: [] }),
    ]);
    if (version !== loadVersion.current) return;
    if (results.some(result => result.status === 'rejected')) {
      setReportError(true); setReportLoading(false); return;
    }
    const [plans, rollup, outside] = results as PromiseFulfilledResult<{ data: any[] }>[];
    setRows(plans.value.data); setDepSummary(rollup.value.data); setUnbudgeted(outside.value.data);
    setReportLoading(false);
  };
  useEffect(() => {
    void load();
    return () => { loadVersion.current++; }; // invalidate on filter change/unmount
    /* eslint-disable-next-line */
  }, [filter.periodType, filter.year, filter.departmentId, canReadOrgReports]);

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
    } catch (e: any) { setErr(e.response?.data?.message?.toString() ?? t('error_generic')); }
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
    if (!await confirm({ title: t('bud_delete_confirm'), hint: t('bud_delete_hint'), danger: true, confirmLabel: t('delete') })) return;
    try { await api.delete(`/budgets/${id}`); load(); }
    catch (e: any) { notifyError(e); }
  };

  // Auth-guarded CSV download (a plain <a> would hit the API without the bearer token).
  // Two files, two jobs: 'budgets.csv' is the whole picture for a person, 'budgets-1c.csv'
  // is the plan by month and dimension for the accounting system to import.
  const download = async (path: string, name: string) => {
    if (!canReadOrgReports || reportLoading || reportError) return;
    try {
      const { data } = await api.get(path, {
        params: {
          ...(filter.periodType ? { periodType: filter.periodType } : {}),
          ...(filter.year ? { year: filter.year } : {}),
          ...(filter.departmentId ? { departmentId: filter.departmentId } : {}),
        },
        responseType: 'blob',
      });
      const url = URL.createObjectURL(data as Blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e: any) { notifyError(e); }
  };
  const exportCsv = () => download('/budgets/export', 'budgets.csv');
  const export1c = () => download('/budgets/export/1c', 'budgets-1c.csv');

  // Lifecycle actions. A budget is a document: drafted, submitted, approved by someone
  // else, and finally closed when the period is signed off.
  const act = async (id: string, action: string, body?: Record<string, unknown>) => {
    try { await api.post(`/budgets/${id}/${action}`, body ?? {}); load(); }
    catch (e: any) { notifyError(e); }
  };
  const withReason = async (id: string, action: string, promptKey: string) => {
    const reason = await ask({ title: t(promptKey), label: t('reason'), required: true, hint: t('bud_reason_hint') });
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

  // Monthly phasing: the shape of the plan over the period. Editing is deliberately a
  // whole-set operation — shares only mean anything when they add to 100%, so the row keeps
  // a running total in front of the reader and refuses to save until it lands.
  const [phasing, setPhasing] = useState<Record<string, any>>({});
  const togglePhasing = async (id: string) => {
    if (phasing[id]) { setPhasing((p) => { const n = { ...p }; delete n[id]; return n; }); return; }
    const { data } = await api.get(`/budgets/${id}/phasing`);
    setPhasing((p) => ({ ...p, [id]: data }));
  };
  const setShare = (id: string, month: string, pct: string) => {
    setPhasing((p) => {
      const cur = p[id];
      const bp = Math.round(Number(pct.replace(',', '.') || 0) * 100);
      return {
        ...p,
        [id]: {
          ...cur,
          months: cur.months.map((m: any) => (m.month === month
            ? { ...m, shareBp: bp, amountMinor: Math.round((cur.amountMinor * bp) / 10000) }
            : m)),
        },
      };
    });
  };
  const savePhasing = async (id: string, months: any[] | null) => {
    try {
      const { data } = await api.put(`/budgets/${id}/phasing`, {
        months: months ? months.map((m) => ({ month: m.month, shareBp: m.shareBp })) : [],
      });
      setPhasing((p) => ({ ...p, [id]: data }));
      load();
    } catch (e: any) { notifyError(e); }
  };

  // Rollover: carry another period's unspent remainder into this budget.
  const rollover = async (targetId: string) => {
    const candidates = rows.filter((b) => b.id !== targetId && b.remainingMinor > 0);
    if (!candidates.length) { notify(t('bud_rollover_none'), 'info'); return; }
    const sourceBudgetId = await ask({
      title: t('bud_rollover_pick'), label: t('budgets'), hint: t('bud_rollover_hint'),
      options: candidates.map((b) => ({
        value: b.id,
        label: `${b.name} (${b.periodLabel}) — ${fmtMoney(b.remainingMinor, b.currency)}`,
      })),
    });
    if (!sourceBudgetId) return;
    try { await api.post(`/budgets/${targetId}/rollover`, { sourceBudgetId }); load(); }
    catch (e: any) { notifyError(e); }
  };

  // The column's name and its explanation come from the basis the ROWS declare, not from
  // an assumption here: if the endpoint ever started reporting the other settlement measure
  // the wording would move with it instead of quietly lying. One wording per meaning,
  // shared with /buyer/analytics — see PAID_BASES in @leadprocure/shared. Only read where
  // the rollup renders, which is only when there is a row.
  const paidBasis = `paid_basis_${depSummary[0]?.paidBasis}`;
  // `tip` explains the figure on hover — short, because it sits on every row and the bubble
  // is 240px wide; `note` is the visible line under the table that names the other page.
  const paidBasisTip = `paid_basis_tip_${depSummary[0]?.paidBasis}`;
  const paidBasisNote = `paid_basis_note_${depSummary[0]?.paidBasis}`;

  return (
    <>
      <h1>{t('budgets')}</h1>
      <ListState of={{ loading: false, failed: refFailed, reload: loadRefs }} />
      {canManagePlans && (
        <div className="card">
          {/* This row and the filter row below carry the same three controls — period, year,
              department — and looked identical, so there was no telling which one created a
              plan and which one narrowed the list. Both say what they are now. */}
          <h3 style={{ marginTop: 0 }}>{editId ? t('bud_revise') : t('bud_new_plan')}</h3>
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
          {canManagePlans && <> · <Link to="/buyer/settings">{t('bud_thresholds_edit')}</Link></>}
        </div>
      )}

      {depSummary.length > 0 && (
        <div className="card" data-testid="budget-rollup">
          <h3>{t('bud_by_department')}</h3>
          <table>
            <thead><tr>
              <th>{t('department')}</th><th className="num">{t('amount')}</th><th className="num">{t('committed')}</th><th className="num">{t('actual')}</th>
              {/* Not the invoice figure on /buyer/analytics: a different measure, so it
                  carries its own name — taken from the basis the endpoint declares rather
                  than hard-coded here. See PAID_BASES in @leadprocure/shared.
                  No VAT label, and that is correct: this figure is on the same basis as
                  the columns to its left — each order's own vat_mode — so it needs no
                  separate one. The analytics tile keeps its «incl. VAT» because it reports
                  the invoice as billed. */}
              <th className="num">{t(paidBasis)}</th><th className="num">{t('remaining')}</th><th className="num">{t('forecast')}</th><th style={{ width: 180 }}>{t('utilization')}</th>
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
                    <td className="num">{fmtMoney(d.amountMinor, d.currency)}</td>
                    <td className="num">{fmtMoney(d.committedMinor, d.currency)}</td>
                    <td className="num">{fmtMoney(d.actualMinor, d.currency)}</td>
                    {/* settlement of orders already counted as actual — shown beside, never summed in */}
                    <td className="hint num" data-tip={t(paidBasisTip)}>{fmtMoney(d.paidMinor, d.currency)}</td>
                    <td className={`num ${over ? 'error' : ''}`}>{fmtMoney(d.remainingMinor, d.currency)}</td>
                    {/* where the period lands at the current rate — the question that follows "how much is left" */}
                    <td className={`num ${d.forecastOverMinor > 0 ? 'error' : 'hint'}`} data-tip={t('forecast_hint')}>
                      {fmtMoney(d.forecastMinor, d.currency)}
                      {d.forecastOverMinor > 0 && <span> · +{fmtMoney(d.forecastOverMinor, d.currency)}</span>}
                    </td>
                    <td>
                      <div className="budget-bar">
                        <div className={`budget-fill ${over ? 'over' : ''}`} style={{ width: `${Math.min(100, d.utilizationPct)}%` }} />
                      </div>
                      <span className="hint">{d.utilizationPct}%{over ? ` · ${t('budget_over')}` : ''}</span>
                      {/* pace: spent versus what the plan says should be spent by now. A bare
                          utilization figure never says whether 80% is early or late. */}
                      <div className={d.paceDeltaPct > 0 ? 'error' : 'hint'} style={{ fontSize: 11 }}
                        data-tip={d.phased ? t('bud_pace_phased_tip') : t('bud_pace_tip')}>
                        {t('bud_pace')} {d.elapsedPct}%{d.phased ? ' 📅' : ''}
                        {/* the gap between spent and planned-by-now, in points of the same
                            scale as the two figures beside it — it used to be a bare number */}
                        {d.paceDeltaPct !== 0 && <> · {d.paceDeltaPct > 0 ? '+' : ''}{d.paceDeltaPct}%</>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {/* Two screens report settled invoices and deliberately report different numbers.
              A finance reader comparing them must find the reason on the page, not file it
              as a defect. */}
          <div className="hint" style={{ marginTop: 10 }}>{t(paidBasisNote)}</div>
        </div>
      )}

      <div className="card">
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="hint" style={{ whiteSpace: 'nowrap' }}>{t('filters')}</span>
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
          {canReadOrgReports && <>
            <button className="btn ghost small" disabled={reportLoading || reportError} onClick={exportCsv}>⤓ CSV</button>
            <button className="btn ghost small" disabled={reportLoading || reportError} data-tip={t('bud_1c_tip')} onClick={export1c}>📤 {t('bud_1c')}</button>
          </>}
          {canManagePlans && (
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
                    notify(`${t('bud_imported')}: ${res.data.imported}`, 'ok');
                    load();
                  } catch (err: any) { notifyError(err); }
                }} />
            </>
          )}
        </div>
        {reportLoading && <div role="status">…</div>}
        {reportError && <div role="alert" className="state-error">{t('budget_load_error')}{' '}
          <button className="btn ghost small" onClick={() => void load()}>{t('analytics_retry')}</button>
        </div>}
        {!reportLoading && !reportError && <table data-testid="budget-list">
          <thead><tr>
            <th>{t('name')}</th><th>{t('status')}</th><th>{t('category')}</th><th>{t('department')}</th><th>{t('period')}</th>
            <th className="num">{t('amount')}</th><th className="num">{t('committed')}</th><th className="num">{t('actual')}</th><th className="num">{t('remaining')}</th>
            <th style={{ width: 180 }}>{t('utilization')}</th>{canManagePlans && <th>{t('actions')}</th>}
          </tr></thead>
          <tbody>
            {rows.map((b) => {
              const over = b.remainingMinor < 0;
              return (
                <Fragment key={b.id}>
                <tr>
                  <td>{b.name}</td>
                  <td><span className={`badge ${statusGroup(b.status)} ${b.status}`} data-tip={t(`bud_st_${b.status}`)}>{t(`bud_status_${b.status}`)}</span></td>
                  <td>{b.category === '*' ? '—' : b.category}</td>
                  <td data-tip={b.departmentName || undefined}>{b.departmentCode ?? t('bud_org_wide')}</td>
                  <td data-tip={`${b.periodStart} → ${b.periodEnd}`}>{b.periodLabel}</td>
                  <td className="num">{fmtMoney(b.amountMinor, b.currency)}</td>
                  <td className="num" data-tip={t('drill_hint')}>
                    <button className="linklike" onClick={() => toggleDocs(b.id, 'committed')}>{fmtMoney(b.committedMinor, b.currency)}</button>
                  </td>
                  <td className="num" data-tip={t('drill_hint')}>
                    <button className="linklike" onClick={() => toggleDocs(b.id, 'actual')}>{fmtMoney(b.actualMinor, b.currency)}</button>
                  </td>
                  <td className={`num ${over ? 'error' : ''}`}>{fmtMoney(b.remainingMinor, b.currency)}</td>
                  <td>
                    <div className="budget-bar">
                      <div className={`budget-fill ${over ? 'over' : ''}`} style={{ width: `${Math.min(100, b.utilizationPct)}%` }} />
                    </div>
                    <span className="hint">{b.utilizationPct}%{over ? ` · ${t('budget_over')}` : ''}</span>
                  </td>
                  {canManagePlans && (
                    <td>
                      {/* Six wordless emoji in a 2×3 block, which rearranged itself whenever a
                          labelled button joined them. Every one of them says what it does now,
                          and deleting the plan sits apart at the end. */}
                      <Actions
                        dense
                        danger={b.status === 'DRAFT' && (
                          <button className="btn small ghost danger" data-tip={t('tip_delete')} onClick={() => remove(b.id)}>🗑 {t('delete')}</button>
                        )}
                      >
                        {b.status === 'DRAFT' && (
                          <>
                            <button className="btn small" data-tip={t('bud_submit_tip')} onClick={() => act(b.id, 'submit')}>{t('submit')}</button>
                            <button className="btn small ghost" data-tip={t('tip_edit')} onClick={() => edit(b)}>✎ {t('edit')}</button>
                          </>
                        )}
                        {b.status === 'PENDING' && (
                          <>
                            <button className="btn small" data-tip={t('bud_approve_tip')} onClick={() => act(b.id, 'approve')}>{t('approve')}</button>
                            <button className="btn small ghost" data-tip={t('bud_reject_tip')} onClick={() => withReason(b.id, 'reject', 'bud_reject_prompt')}>{t('reject')}</button>
                            <button className="btn small ghost" data-tip={t('bud_recall_tip')} onClick={() => act(b.id, 'recall')}>↩ {t('bud_recall')}</button>
                          </>
                        )}
                        {b.status === 'APPROVED' && (
                          <>
                            <button className="btn small ghost" data-tip={t('bud_revise_tip')} onClick={() => edit(b)}>✎ {t('bud_revise')}</button>
                            <button className="btn small ghost" data-tip={t('bud_close_tip')} onClick={() => act(b.id, 'close')}>🔒 {t('bud_close')}</button>
                          </>
                        )}
                        {b.status === 'CLOSED' && (
                          <button className="btn small ghost" data-tip={t('bud_reopen_tip')} onClick={() => withReason(b.id, 'reopen', 'bud_reopen_prompt')}>🔓 {t('bud_reopen')}</button>
                        )}
                        <button className="btn small ghost" data-tip={t('bud_history')} onClick={() => toggleHistory(b.id)}>🕘 {t('bud_history_label')}</button>
                        <button className="btn small ghost" data-tip={t('bud_phasing_tip')} onClick={() => togglePhasing(b.id)}>📅 {t('bud_phasing')}</button>
                        <button className="btn small ghost" data-tip={t('bud_rollover')} onClick={() => rollover(b.id)}>↪ {t('bud_rollover_label')}</button>
                      </Actions>
                    </td>
                  )}
                </tr>
                {docs[b.id] && (
                  <tr>
                    <td colSpan={canManagePlans ? 11 : 10} style={{ background: 'rgba(4,120,87,0.04)' }}>
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
                                <td className="hint nowrap">{fmtDate(d.datedAt)}</td>
                                <td className="num">{fmtMoney(d.amountMinor, b.currency)}<span className="hint"> · {t(`drill_${d.bucket}`)}</span></td>
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
                    <td colSpan={canManagePlans ? 11 : 10} style={{ background: 'rgba(79,140,255,0.05)' }}>
                      <b>{t('bud_history')}</b>
                      <table style={{ margin: '6px 0' }}>
                        <thead><tr>
                          <th>{t('date')}</th><th className="num">{t('amount')}</th><th>{t('bud_delta')}</th>
                          <th>{t('reason')}</th><th>{t('requester')}</th>
                        </tr></thead>
                        <tbody>
                          {history[b.id].map((r: any) => (
                            <tr key={r.id}>
                              <td className="hint nowrap">{fmtDate(r.createdAt)}</td>
                              <td className="num">{fmtMoney(r.amountAfterMinor, b.currency)}</td>
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
                {phasing[b.id] && (() => {
                  const ph = phasing[b.id];
                  const totalBp = ph.months.reduce((n: number, m: any) => n + m.shareBp, 0);
                  const balanced = totalBp === 10000;
                  return (
                    <tr>
                      <td colSpan={canManagePlans ? 11 : 10} style={{ background: 'rgba(234,179,8,0.06)' }}>
                        <b>{t('bud_phasing')}</b>
                        <div className="hint" style={{ margin: '4px 0 8px' }}>{t('bud_phasing_hint')}</div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          {ph.months.map((m: any) => (
                            <div key={m.month} style={{ minWidth: 96 }}>
                              <div className="hint">{m.month}</div>
                              <input type="number" step="0.01" min="0" max="100" style={{ width: 92 }}
                                value={String(m.shareBp / 100)}
                                disabled={!canManagePlans || b.status === 'CLOSED'}
                                onChange={(e) => setShare(b.id, m.month, e.target.value)} />
                              <div className="hint">{fmtMoney(m.amountMinor, b.currency)}</div>
                            </div>
                          ))}
                        </div>
                        <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                          <span className={balanced ? 'hint' : 'error'}>
                            {t('bud_phasing_total')}: {(totalBp / 100).toFixed(2)}%
                          </span>
                          {canManagePlans && b.status !== 'CLOSED' && (
                            <>
                              <button className="btn small" disabled={!balanced}
                                onClick={() => savePhasing(b.id, ph.months)}>{t('save')}</button>
                              {ph.phased && (
                                <button className="btn small ghost" data-tip={t('bud_phasing_clear_tip')}
                                  onClick={() => savePhasing(b.id, null)}>{t('bud_phasing_clear')}</button>
                              )}
                            </>
                          )}
                          {!ph.phased && <span className="hint">· {t('bud_phasing_even')}</span>}
                        </div>
                      </td>
                    </tr>
                  );
                })()}
                </Fragment>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={canManagePlans ? 11 : 10} className="hint">—</td></tr>}
          </tbody>
        </table>}
      </div>

      {unbudgeted.length > 0 && (
        <div className="card">
          <h3>⚠ {t('bud_unbudgeted')}</h3>
          <div className="hint" style={{ marginBottom: 10 }}>{t('bud_unbudgeted_hint')}</div>
          <table>
            <thead><tr>
              <th>#</th><th>{t('title')}</th><th>{t('category')}</th><th>{t('department')}</th>
              <th>{t('date')}</th><th className="num">{t('amount')}</th><th>{t('currency')}</th>
            </tr></thead>
            <tbody>
              {unbudgeted.map((u) => (
                <tr key={u.id ?? u.requestId}>
                  <td>{u.docNo ?? u.requestNo}</td>
                  {/* an ORDER row is a catalog call-off: no request, no title, no category */}
                  <td>{u.title ?? (u.kind === 'ORDER' ? t('bud_calloff') : '—')}</td>
                  <td>{u.category ?? '—'}</td>
                  <td>{u.departmentCode ?? '—'}</td>
                  <td className="hint nowrap">{fmtDate(u.approvedAt)}</td>
                  <td className="num">{fmtMoney(u.amountMinor, u.currency)}</td>
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
