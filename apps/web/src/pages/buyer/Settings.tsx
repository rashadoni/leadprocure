import { FormEvent, useEffect, useState } from 'react';
import { Explain } from '../../components/Explain';
import { api, fmtMoney } from '../../api/client';
import { useAuth } from '../../auth/auth';
import { useI18n } from '../../i18n';
import { useDialogs } from '../../components/Dialogs';
import { Actions } from '../../components/Actions';
import { BUYER_ROLES } from '@leadprocure/shared';
import { ChannelsCard } from '../../components/ChannelsCard';
import { isDenied, ListState, useLoad } from '../../components/ListState';

export default function Settings() {
  const { t } = useI18n();
  const { notifyError } = useDialogs();
  const { session } = useAuth();
  const userList = useLoad(() => api.get('/settings/users').then((r) => r.data), [], [] as any[]);
  const policyList = useLoad(() => api.get('/requests/method-policies').then((r) => r.data), [], [] as any[]);
  const approvalList = useLoad(() => api.get('/requests/approval-policies').then((r) => r.data), [], [] as any[]);
  const standstillList = useLoad(() => api.get('/events/standstill-policies').then((r) => r.data), [], [] as any[]);
  const users = userList.data;
  const policies = policyList.data;
  const approvals = approvalList.data;
  const standstills = standstillList.data;
  const [cats, setCats] = useState<any[]>([]);
  const [newCat, setNewCat] = useState({ code: '', name: '' });
  const [deps, setDeps] = useState<any[]>([]);
  const [newDep, setNewDep] = useState({ code: '', name: '', parentId: '', ownerUserId: '' });
  const [nu, setNu] = useState({ email: '', fullName: '', password: '', role: 'BUYER_USER' });
  // Budget thresholds are an organisation-wide RULE about approvals, which is what this
  // page is for — they used to sit on the Budgets screen, in the way of the numbers.
  const [policy, setPolicy] = useState<{ warnPct: number; blockPct: number | null; allowOverride: boolean } | null>(null);
  const [policyDraft, setPolicyDraft] = useState<{ warnPct: string; blockPct: string; allowOverride: boolean } | null>(null);
  const [policySaved, setPolicySaved] = useState(false);
  const isAdmin = session?.org.role === 'BUYER_ADMIN';
  const canManageBudgetPolicy = isAdmin || session?.org.role === 'BUYER_FINANCE';

  // Method-policy editor (value bands → procurement method).
  const [mpEditing, setMpEditing] = useState(false);
  const [mpDraft, setMpDraft] = useState<Array<{ category: string; minAzn: number; maxAzn: number | string; method: string }>>([]);
  const MP_COLOR: Record<string, string> = { DIRECT: '#e7f6ec', RFQ: '#eef2ff', OPEN_TENDER: '#fff7ed' };
  const MP_ICO: Record<string, string> = { DIRECT: '📦', RFQ: '🔒', OPEN_TENDER: '🌐' };
  const mLabel = (m: string) => { const l = t(`mt_${m}`); return l === `mt_${m}` ? m : l; };

  // Reference data the page can live without — but only when it is genuinely absent.
  // An org with no budgets licence gets 403 on the policy and renders no threshold card,
  // which is right; a 503 on the same URL used to render exactly the same thing, so the
  // admin read "we don't have budget limits" off a dead request.
  const [refFailed, setRefFailed] = useState(false);
  const loadOptional = () => {
    setRefFailed(false);
    // Only the policy sits behind a licence. /categories and /departments carry nothing
    // but @Roles over the four buyer roles, so on this page every failure of theirs is a
    // real one and there is no denial to exempt.
    const broken = () => setRefFailed(true);
    const quiet = (e: any) => { if (!isDenied(e)) setRefFailed(true); };
    api.get('/categories').then((r) => setCats(r.data)).catch(broken);
    api.get('/departments').then((r) => setDeps(r.data)).catch(broken);
    api.get('/budgets/policy').then((r) => {
      setPolicy(r.data);
      setPolicyDraft({
        warnPct: String(r.data.warnPct),
        blockPct: r.data.blockPct == null ? '' : String(r.data.blockPct),
        allowOverride: r.data.allowOverride,
      });
    }).catch(quiet);
  };
  useEffect(loadOptional, []);
  const load = () => {
    userList.reload(); policyList.reload(); approvalList.reload(); standstillList.reload(); loadOptional();
  };

  const run = async (fn: () => Promise<unknown>) => {
    try { await fn(); load(); } catch (e: any) { notifyError(e); }
  };

  // `PUT /departments/:id` replaces the whole row, and an OMITTED field is read as «cleared»
  // (`dto.ownerUserId ?? null` in departments.module.ts) — so every field this click is not
  // about has to be sent back as it stands. The retire button used to send code, name,
  // parent and isActive and nothing else, which quietly dropped the owner: the department
  // whose head is the one person a budget warning is addressed to went back to notifying
  // the whole organisation, and no screen said so because no screen showed the owner.
  const depPut = (d: any, patch: Record<string, unknown>) => run(() => api.put(`/departments/${d.id}`, {
    code: d.code,
    name: d.name ?? undefined,
    parentId: d.parent_id ?? undefined,
    ownerUserId: d.owner_user_id ?? undefined,
    isActive: d.is_active,
    ...patch,
  }));

  // Who may be made the owner of a department, and what the row says about the one it has.
  // The budget warning is addressed to this person (`departments.owner_user_id` →
  // notify.notifyUser), and `NotifyEmailer.fanOut` mails only ACTIVE users — with a userId
  // that filter does not fall back to the organisation, it empties the recipient list, and
  // `if (!users.length) return` sends nothing at all. So naming a deactivated person does
  // not widen the mail, it stops it, while the column goes on looking filled in.
  //
  // Precisely: the MAIL stops. The in-app row is still written and is read org-wide —
  // `notifications_rls` filters by `recipient_org_id` alone and `GET /notifications` has no
  // recipient clause, so nothing in the product reads `recipient_user_id` today. Saying
  // «nobody is told» here would send the next reader to fix a channel that is not broken.
  //
  // `/settings/users` answers with every membership regardless of status, because the users
  // table above is where a person is read and their role changed; it is only this picker
  // that must not offer them.
  const activeUsers = users.filter((u) => u.status === 'ACTIVE');
  const ownerStatus = (d: any) => users.find((u) => u.id === d.owner_user_id)?.status ?? d.owner_status ?? null;
  const ownerLabel = (name: string, status: string | null) =>
    (status === 'ACTIVE' ? name : `${name} (${t('dep_owner_off')})`);

  // Human-readable role name; falls back to the raw code if no translation exists.
  const roleLabel = (r: string) => { const l = t(`role_${r}`); return l === `role_${r}` ? r : l; };

  // Auth-guarded CSV download (a plain <a> would hit the API without the bearer token).
  const download1c = async () => {
    try {
      const { data } = await api.get('/invoices/export/1c', { responseType: 'blob' });
      const url = URL.createObjectURL(data as Blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'invoices-1c.csv'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e: any) { notifyError(e); }
  };

  // Approval-chain presets the admin can switch between (fixes the "one-shot button").
  const CHAIN_PRESETS: Record<string, { label: string; policies: any[] }> = {
    p0: { label: t('chain_p0'), policies: [] },
    p1: { label: t('chain_p1'), policies: [{ minAmountMinor: 0, maxAmountMinor: null, steps: [{ order: 1, role: 'BUYER_APPROVER' }] }] },
    // Finance in the chain: over the threshold, the controller signs before the spend is
    // allowed. approval_steps already checks the acting user's role, so naming the finance
    // role here is all it takes.
    p3: { label: t('chain_p3'), policies: [
      { minAmountMinor: 0, maxAmountMinor: 5_000_000, steps: [{ order: 1, role: 'BUYER_APPROVER' }] },
      { minAmountMinor: 5_000_000, maxAmountMinor: null, steps: [{ order: 1, role: 'BUYER_APPROVER' }, { order: 2, role: 'BUYER_FINANCE' }] },
    ] },
    p2: { label: t('chain_p2'), policies: [
      { minAmountMinor: 0, maxAmountMinor: 5_000_000, steps: [{ order: 1, role: 'BUYER_APPROVER' }] },
      { minAmountMinor: 5_000_000, maxAmountMinor: null, steps: [{ order: 1, role: 'BUYER_APPROVER' }, { order: 2, role: 'BUYER_ADMIN' }] },
    ] },
    // Three steps, and the reason it is here rather than left to the API: a chain of any
    // length has always worked server-side (`approval_steps` is materialized from whatever
    // `steps` the policy holds, with no cap), but these cards are the ONLY way the product
    // offers to set a chain — so «a chain can be one step or three» was true of the engine
    // and unreachable from the screen. The bands are the ones the money suggests: an
    // approver alone up to the tender threshold, finance above it, and the admin as well
    // once the amount is large enough to want a third pair of eyes. Three steps need three
    // different people, which the segregation-of-duties rule already enforces.
    p4: { label: t('chain_p4'), policies: [
      { minAmountMinor: 0, maxAmountMinor: 5_000_000, steps: [{ order: 1, role: 'BUYER_APPROVER' }] },
      { minAmountMinor: 5_000_000, maxAmountMinor: 50_000_000, steps: [{ order: 1, role: 'BUYER_APPROVER' }, { order: 2, role: 'BUYER_FINANCE' }] },
      { minAmountMinor: 50_000_000, maxAmountMinor: null, steps: [
        { order: 1, role: 'BUYER_APPROVER' }, { order: 2, role: 'BUYER_FINANCE' }, { order: 3, role: 'BUYER_ADMIN' },
      ] },
    ] },
  };
  const setChain = (key: string) => run(() => api.put('/requests/approval-policies', { policies: CHAIN_PRESETS[key].policies }));
  const ROLE_ICO: Record<string, string> = { BUYER_ADMIN: '👑', BUYER_APPROVER: '🖊', BUYER_FINANCE: '💰', BUYER_USER: '👤' };
  // Which preset matches the currently saved chain (normalize camel/snake + ordering).
  const chainSig = (list: any[]) => JSON.stringify(
    (list ?? [])
      .map((p: any) => ({
        min: Number(p.minAmountMinor ?? p.min_amount_minor ?? 0),
        max: (p.maxAmountMinor ?? p.max_amount_minor) == null ? null : Number(p.maxAmountMinor ?? p.max_amount_minor),
        steps: (p.steps ?? []).slice().sort((a: any, b: any) => a.order - b.order).map((s: any) => s.role),
      }))
      .sort((a, b) => a.min - b.min),
  );
  // Only match presets against a chain we actually HAVE. The p0 preset is the empty
  // chain, so a failed GET would badge "no approvals" as the active one, leave it
  // unclickable, and make one click on the real chain a PUT that overwrites it.
  const chainKnown = !approvalList.loading && !approvalList.failed;
  const activeChainKey = chainKnown
    ? Object.entries(CHAIN_PRESETS).find(([, pr]) => chainSig(pr.policies) === chainSig(approvals))?.[0]
    : undefined;

  // Explicit save. These fields can stop spending across the company; saving them on blur,
  // the way they behaved before, was far too quiet for what they do.
  const savePolicy = async () => {
    if (!policyDraft) return;
    try {
      const { data } = await api.put('/budgets/policy', {
        warnPct: Number(policyDraft.warnPct),
        blockPct: policyDraft.blockPct === '' ? null : Number(policyDraft.blockPct),
        allowOverride: policyDraft.allowOverride,
      });
      setPolicy(data);
      setPolicySaved(true);
      setTimeout(() => setPolicySaved(false), 2500);
    } catch (e: any) { notifyError(e); }
  };
  const policyDirty = !!policy && !!policyDraft && (
    Number(policyDraft.warnPct) !== policy.warnPct
    || (policyDraft.blockPct === '' ? null : Number(policyDraft.blockPct)) !== policy.blockPct
    || policyDraft.allowOverride !== policy.allowOverride
  );

  const addUser = (e: FormEvent) => {
    e.preventDefault();
    run(() => api.post('/settings/users', nu)).then(() => setNu({ email: '', fullName: '', password: '', role: 'BUYER_USER' }));
  };

  return (
    <>
      <h1>{t('settings')}</h1>
      {/* Seven unrelated sections one under another, and the only way to the last one was
          the scrollbar. Links, not a sticky rail: the page is long, not deep. A link is
          drawn only for a section that is actually on the page. */}
      <div className="hint" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginBottom: 14 }}>
        <a href="#set-users">{t('users')}</a>
        <a href="#set-categories">{t('cat_hdr')}</a>
        <a href="#set-departments">{t('dep_hdr')}</a>
        {policyDraft && <a href="#set-thresholds">{t('bud_thresholds')}</a>}
        {/* Раздел без ссылки в собственном оглавлении — раздел, до которого не доходят:
            на этой странице восемь карточек, и до новой пришлось бы прокручивать, зная,
            что она там есть. */}
        <a href="#set-standstill">{t('standstill_policy')}</a>
        <a href="#set-method">{t('method_policy')}</a>
        <a href="#set-integrations">{t('integrations')}</a>
        <a href="#set-approval">{t('approval_chain')}</a>
        <a href="#set-channels">{t('channels_hdr')}</a>
      </div>
      <ListState of={[userList, policyList, approvalList, standstillList,
        { loading: false, failed: refFailed, reload: loadOptional }]} />
      <div className="card">
        <h3 id="set-users">{t('users')}</h3>
        <table>
          <thead><tr><th>{t('email')}</th><th>{t('name')}</th><th>{t('role')}</th><th>{t('department')}</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.email}</td>
                <td>{u.full_name}</td>
                <td>
                  {isAdmin && u.id !== session?.user.id ? (
                    <select value={u.role}
                      onChange={(e) => run(() => api.post(`/settings/users/${u.id}/role`, { role: e.target.value }))}>
                      {BUYER_ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
                    </select>
                  ) : (
                    <span className="badge is-info" data-tip={isAdmin && u.id === session?.user.id ? t('role_self_locked') : undefined}>{roleLabel(u.role)}</span>
                  )}
                </td>
                <td>
                  {/* home department = the default on this user's requests */}
                  {isAdmin ? (
                    <select value={u.department_id ?? ''}
                      onChange={(e) => run(() => api.post(`/settings/users/${u.id}/department`, { departmentId: e.target.value || null }))}>
                      <option value="">—</option>
                      {deps.filter((d) => d.is_active || d.id === u.department_id).map((d) => (
                        <option key={d.id} value={d.id}>{d.code}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="hint">{u.department_code ?? '—'}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {isAdmin && (
          <form onSubmit={addUser} className="row" style={{ marginTop: 14, maxWidth: 760 }}>
            <div><label>{t('email')}</label><input type="email" required value={nu.email} onChange={(e) => setNu({ ...nu, email: e.target.value })} /></div>
            <div><label>{t('name')}</label><input required value={nu.fullName} onChange={(e) => setNu({ ...nu, fullName: e.target.value })} /></div>
            <div><label htmlFor="new-user-password">{t('password')}</label>
              <input id="new-user-password" type="password" required minLength={8} value={nu.password}
                onChange={(e) => setNu({ ...nu, password: e.target.value })} /></div>
            <div><label>{t('role')}</label>
              <select value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value })}>
                {BUYER_ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
              </select>
            </div>
            <button className="btn" style={{ flex: 'none' }}>+ {t('add')}</button>
          </form>
        )}
      </div>

      <div className="card">
        <h3 id="set-categories">{t('cat_hdr')}</h3>
        <div className="hint" style={{ marginBottom: 10 }}>{t('cat_hint')}</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: isAdmin ? 12 : 0 }}>
          {cats.length === 0 && <span className="hint">—</span>}
          {cats.map((c) => (
            <span key={c.id} className="badge is-info" data-tip={c.name || undefined}>
              {c.code}{c.name ? ` · ${c.name}` : ''}
              {isAdmin && (
                <button className="btn small ghost" style={{ marginLeft: 6, padding: '0 6px' }}
                  onClick={() => run(() => api.delete(`/categories/${c.id}`))}>{t('delete')}</button>
              )}
            </span>
          ))}
        </div>
        {isAdmin && (
          <form className="row" style={{ maxWidth: 560 }}
            onSubmit={(e) => { e.preventDefault(); if (newCat.code.trim()) run(() => api.post('/categories', newCat)).then(() => setNewCat({ code: '', name: '' })); }}>
            <div><label>{t('cat_code')}</label><input value={newCat.code} onChange={(e) => setNewCat({ ...newCat, code: e.target.value })} placeholder="IT" /></div>
            <div><label>{t('name')}</label><input value={newCat.name} onChange={(e) => setNewCat({ ...newCat, name: e.target.value })} /></div>
            <button className="btn" style={{ flex: 'none' }}>+ {t('add')}</button>
          </form>
        )}
      </div>

      <div className="card">
        <h3 id="set-departments">{t('dep_hdr')}</h3>
        <div className="hint" style={{ marginBottom: 10 }}>{t('dep_hint')}</div>
        <table>
          <thead><tr>
            <th>{t('dep_code')}</th><th>{t('name')}</th><th>{t('dep_parent')}</th>
            {/* The owner is not decoration: the budget warning is addressed to this person
                (`departments.owner_user_id` → notify.notifyUser in modules/budgets), and
                until this column existed the one screen that decides who gets told did not
                say who that was. A department with nobody named says so in words — an empty
                cell reads as «not loaded», and the fallback it stands for is «the whole
                organisation gets the alarm», which is the opposite of nothing. */}
            <th data-testid="dep-owner-col">{t('dep_owner')}</th>
            <th>{t('dep_usage')}</th><th>{t('status')}</th>{isAdmin && <th>{t('actions')}</th>}
          </tr></thead>
          <tbody>
            {deps.length === 0 && <tr><td colSpan={isAdmin ? 7 : 6} className="hint">—</td></tr>}
            {deps.map((d) => (
              <tr key={d.id}>
                <td>{d.code}</td>
                <td>{d.name || '—'}</td>
                <td className="hint">{d.parent_code ?? '—'}</td>
                <td data-testid="dep-owner">
                  {isAdmin ? (
                    <select value={d.owner_user_id ?? ''}
                      onChange={(e) => depPut(d, { ownerUserId: e.target.value || null })}>
                      <option value="">{t('dep_owner_none')}</option>
                      {activeUsers.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                      {/* The owner this row already has, whenever the list above does not
                          offer them. A <select> whose value matches no option falls back to
                          its first one, so without this a department that HAS an owner reads
                          «No owner» — wrong in the other direction, and the natural fix for
                          it (pick somebody) changes who gets told while nobody sees that the
                          row was pointed elsewhere all along.
                          Asked as «not among the people offered», not as «status is not
                          ACTIVE»: those differ exactly while `users` is still in flight.
                          /settings/users and /departments are separate requests and the
                          departments land first, so for that moment every owner is missing
                          from an empty `activeUsers` while `owner_status` says ACTIVE — and
                          the old test rendered no option and showed «No owner» for an owner
                          who is perfectly fine. It is not only a flicker: if /settings/users
                          fails, `users` stays empty and that is the screen the admin keeps.
                          (The owner's own name is shown unmarked there, because
                          `ownerLabel` reads the real status and ACTIVE carries no mark.) */}
                      {d.owner_user_id && !activeUsers.some((u) => u.id === d.owner_user_id) && (
                        <option value={d.owner_user_id}>{ownerLabel(d.owner_name || '—', ownerStatus(d))}</option>
                      )}
                    </select>
                  ) : d.owner_name ? (
                    <span>{ownerLabel(d.owner_name, ownerStatus(d))}</span>
                  ) : (
                    <span className="hint">{t('dep_owner_none')}</span>
                  )}
                </td>
                <td className="hint">{d.usage_count}</td>
                <td>{d.is_active ? <span className="badge is-good">{t('dep_active')}</span> : <span className="badge is-neutral">{t('dep_inactive')}</span>}</td>
                {isAdmin && (
                  <td>
                    {/* retiring beats deleting: a department carrying spend must keep its history */}
                    <Actions
                      danger={(
                        <button className="btn small ghost danger" disabled={d.usage_count > 0}
                          data-tip={d.usage_count > 0 ? t('dep_delete_blocked') : t('tip_delete')}
                          onClick={() => run(() => api.delete(`/departments/${d.id}`))}>🗑 {t('delete')}</button>
                      )}
                    >
                      <button className="btn small ghost" data-tip={d.is_active ? t('dep_deactivate') : t('dep_activate')}
                        onClick={() => depPut(d, { isActive: !d.is_active })}>
                        {d.is_active ? `⏸ ${t('dep_retire')}` : `▶ ${t('dep_restore')}`}
                      </button>
                    </Actions>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {isAdmin && (
          <form className="row" style={{ maxWidth: 760, marginTop: 12 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (!newDep.code.trim()) return;
              run(() => api.post('/departments', {
                code: newDep.code.trim(),
                ...(newDep.name.trim() ? { name: newDep.name.trim() } : {}),
                ...(newDep.parentId ? { parentId: newDep.parentId } : {}),
                ...(newDep.ownerUserId ? { ownerUserId: newDep.ownerUserId } : {}),
              })).then(() => setNewDep({ code: '', name: '', parentId: '', ownerUserId: '' }));
            }}>
            <div><label>{t('dep_code')}</label><input value={newDep.code} onChange={(e) => setNewDep({ ...newDep, code: e.target.value })} placeholder="IT" /></div>
            <div><label>{t('name')}</label><input value={newDep.name} onChange={(e) => setNewDep({ ...newDep, name: e.target.value })} /></div>
            <div><label>{t('dep_parent')}</label>
              <select value={newDep.parentId} onChange={(e) => setNewDep({ ...newDep, parentId: e.target.value })}>
                <option value="">—</option>
                {deps.map((d) => <option key={d.id} value={d.id}>{d.code}</option>)}
              </select></div>
            {/* The owner, asked for at birth. `POST /departments` has always taken
                `ownerUserId`; this form sent code, name and parent only, so every department
                created in the product came into the world unowned and its budget alarm went
                to the whole organisation. The column above could then be filled in, one row
                at a time, by somebody who knew to — and the one screen that decides who gets
                told was the screen that did not ask. Optional on purpose: a department with
                nobody answerable for it is a real state, and the table says so in words
                rather than leaving the cell blank. */}
            <div><label>{t('dep_owner')}</label>
              <select data-testid="dep-new-owner" value={newDep.ownerUserId}
                onChange={(e) => setNewDep({ ...newDep, ownerUserId: e.target.value })}>
                <option value="">{t('dep_owner_none')}</option>
                {activeUsers.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select></div>
            <button className="btn" style={{ flex: 'none' }}>+ {t('add')}</button>
          </form>
        )}

        {isAdmin && mpEditing && (
          <div style={{ marginTop: 8 }}>
            <table>
              <thead><tr><th>{t('category')}</th><th>{t('from')} (AZN)</th><th>{t('to')} (AZN)</th><th>{t('method')}</th><th /></tr></thead>
              <tbody>
                {mpDraft.map((d, i) => (
                  <tr key={i}>
                    <td>
                      <input list="mp-cats" value={d.category} style={{ width: 130 }} placeholder="*"
                        onChange={(e) => setMpDraft(mpDraft.map((x, j) => j === i ? { ...x, category: e.target.value || '*' } : x))} />
                    </td>
                    <td>
                      <input type="number" min={0} value={d.minAzn} style={{ width: 110 }}
                        onChange={(e) => setMpDraft(mpDraft.map((x, j) => j === i ? { ...x, minAzn: Number(e.target.value) } : x))} />
                    </td>
                    <td>
                      <input type="number" min={0} value={d.maxAzn} style={{ width: 110 }} placeholder="∞"
                        onChange={(e) => setMpDraft(mpDraft.map((x, j) => j === i ? { ...x, maxAzn: e.target.value } : x))} />
                    </td>
                    <td>
                      <select value={d.method}
                        onChange={(e) => setMpDraft(mpDraft.map((x, j) => j === i ? { ...x, method: e.target.value } : x))}>
                        <option value="DIRECT">{MP_ICO.DIRECT} {mLabel('DIRECT')}</option>
                        <option value="RFQ">{MP_ICO.RFQ} {mLabel('RFQ')}</option>
                        <option value="OPEN_TENDER">{MP_ICO.OPEN_TENDER} {mLabel('OPEN_TENDER')}</option>
                      </select>
                    </td>
                    <td><button className="btn small ghost" onClick={() => setMpDraft(mpDraft.filter((_, j) => j !== i))}>{t('delete')}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <datalist id="mp-cats">
              <option value="*" />
              {cats.map((c: any) => <option key={c.code} value={c.code} />)}
            </datalist>
            <button className="btn small ghost" onClick={() => {
              const last = mpDraft[mpDraft.length - 1];
              setMpDraft([...mpDraft, { category: last?.category ?? '*', minAzn: Number(last?.maxAzn) || 0, maxAzn: '', method: 'RFQ' }]);
            }}>{t('mp_add_band')}</button>
            <button className="btn small" style={{ marginLeft: 6 }} disabled={!mpDraft.length}
              onClick={() => run(async () => {
                await api.put('/requests/method-policies', {
                  policies: mpDraft.map((d) => ({
                    category: d.category.trim() || '*',
                    minAmountMinor: Math.round(Number(d.minAzn) * 100),
                    maxAmountMinor: d.maxAzn === '' ? null : Math.round(Number(d.maxAzn) * 100),
                    method: d.method,
                  })),
                });
                setMpEditing(false);
              })}>{t('followups_save')}</button>
            <button className="btn small ghost" onClick={() => setMpEditing(false)}>{t('followups_cancel')}</button>
          </div>
        )}
      </div>

      {policyDraft && (
        <div className="card">
          <h3 id="set-thresholds">{t('bud_thresholds')}</h3>
          <div className="hint" style={{ marginBottom: 12 }}><Explain text={t('bud_thresholds_hint')} /></div>
          <div className="row" style={{ alignItems: 'flex-end', maxWidth: 880 }}>
            <div><label htmlFor="bud-warn">{t('bud_warn_label')}</label>
              <input id="bud-warn" type="number" min={1} max={1000} disabled={!canManageBudgetPolicy} value={policyDraft.warnPct}
                onChange={(e) => setPolicyDraft({ ...policyDraft, warnPct: e.target.value })} /></div>
            <div><label htmlFor="bud-block">{t('bud_block_label')}</label>
              <input id="bud-block" type="number" min={1} max={1000} disabled={!canManageBudgetPolicy} placeholder={t('bud_block_off')}
                value={policyDraft.blockPct}
                onChange={(e) => setPolicyDraft({ ...policyDraft, blockPct: e.target.value })} /></div>
            {/* A yes/no question drawn as a dropdown of two: one tick says it in one move. */}
            <div style={{ flex: '0 0 auto' }}>
              <label htmlFor="bud-override" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 9px' }}>
                <input id="bud-override" type="checkbox" style={{ width: 'auto' }}
                  disabled={!canManageBudgetPolicy} checked={policyDraft.allowOverride}
                  onChange={(e) => setPolicyDraft({ ...policyDraft, allowOverride: e.target.checked })} />
                {t('bud_override_label')}
              </label>
            </div>
            {canManageBudgetPolicy && (
              <div style={{ flex: '0 0 auto' }}>
                <button className="btn" disabled={!policyDirty} onClick={savePolicy}
                  data-tip={policyDirty ? undefined : t('nothing_to_save')}>{t('save')}</button>
              </div>
            )}
          </div>
          <div className="hint" style={{ marginTop: 10 }}>
            {policyDraft.blockPct === '' ? t('bud_block_off_hint') : t('bud_block_on_hint')}
            {policySaved && <b style={{ color: 'var(--ok)', marginLeft: 8 }}>✓ {t('saved')}</b>}
          </div>
        </div>
      )}

        {/* Пауза на возражение. Раньше это была переменная окружения — одна на всех
            арендаторов, и «регулируемой закупке ставят 24 часа» было невыполнимо буквально:
            ставили не закупке, а серверу. Срок привязан к МЕТОДУ: открытому тендеру пауза
            нужна, закупке из трёх предложений — нет. */}
        <div className="card" data-testid="set-standstill">
          <h3 id="set-standstill">{t('standstill_policy')}</h3>
          <p className="hint" style={{ marginTop: 2 }}>{t('standstill_policy_desc')}</p>
          <table>
            <thead><tr>
              <th>{t('method')}</th><th className="num">{t('standstill_hours')}</th><th />
            </tr></thead>
            <tbody>
              {/* Только два метода. Прямая закупка не создаёт процедуры вовсе, значит нет
                  ни присуждения, ни паузы: строка на DIRECT принималась бы и не срабатывала
                  ни разу — закупщик поставил бы 48 часов и получил тишину. */}
              {(['OPEN_TENDER', 'RFQ'] as const).map((method) => {
                const cur = standstills.find((p: any) => p.method === method);
                return (
                  <tr key={method}>
                    <td>{mLabel(method)}</td>
                    <td className="num">
                      <input type="number" min={0} max={720} style={{ width: 90 }}
                        data-testid={`standstill-${method}`}
                        defaultValue={cur ? Number(cur.hours) : ''}
                        placeholder={t('standstill_default')}
                        onBlur={(e) => {
                          const raw = e.target.value.trim();
                          const next = standstills
                            .filter((p: any) => p.method !== method)
                            .map((p: any) => ({ method: p.method, hours: Number(p.hours) }));
                          if (raw !== '') next.push({ method, hours: Number(raw) });
                          run(() => api.put('/events/standstill-policies', { policies: next }));
                        }} />
                    </td>
                    <td className="hint">
                      {cur ? (Number(cur.hours) === 0 ? t('standstill_off') : t('standstill_on'))
                        : t('standstill_unset')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {/* Открытость процедуры и длина паузы — две разные настройки, и их сочетание
              имеет смысл, которого не видно ни в одной из них по отдельности. Сказано там,
              где человек ставит число. */}
          <p className="hint" style={{ marginTop: 8 }}>{t('standstill_vs_visibility')}</p>
        </div>
      <div className="card">
        <h3 id="set-method">⚖️ {t('method_policy')}</h3>
        <p className="hint" style={{ marginTop: 2 }}>{t('method_policy_desc')}</p>

        {/* One coloured scale per category: the whole policy is visible at a glance —
            which amounts go straight to an order and where the tender starts. */}
        {Object.entries(
          policies.reduce((g: Record<string, any[]>, p: any) => {
            (g[p.category] = g[p.category] ?? []).push(p); return g;
          }, {}),
        ).map(([cat, bands]) => (
          <div key={cat} style={{ margin: '10px 0' }}>
            <div className="hint" style={{ marginBottom: 4 }}>
              {cat === '*' ? `🌍 ${t('mp_all_categories')}` : `🏷 ${cat}`}
            </div>
            <div className="mp-scale" style={{ display: 'flex', borderRadius: 10, overflow: 'hidden', border: '1px solid #e2e6ea' }}>
              {(bands as any[]).sort((a, b) => Number(a.min_amount_minor) - Number(b.min_amount_minor)).map((p) => (
                <div key={p.id} className="mp-band" style={{
                  flex: 1, padding: '8px 12px', borderRight: '2px solid #fff',
                  background: MP_COLOR[p.method] ?? '#f5f5f5',
                }}>
                  <div style={{ fontWeight: 600 }}>{MP_ICO[p.method] ?? '•'} {mLabel(p.method)}</div>
                  <div className="hint">{fmtMoney(p.min_amount_minor)} — {p.max_amount_minor ? fmtMoney(p.max_amount_minor) : '∞'}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
        {!policyList.loading && !policyList.failed && policies.length === 0 && <p className="hint">— {isAdmin ? t('mp_empty_admin') : t('mp_empty')}</p>}

        {isAdmin && !mpEditing && !policyList.loading && !policyList.failed && (
          <button className="btn small ghost" style={{ marginTop: 6 }}
            onClick={() => {
              // policies is [] here only because the org really has none: a failed load
              // cannot reach this button, so the stock bands below are never mistaken for
              // the org's own and saved over them.
              setMpDraft(policies.length
                ? policies.map((p: any) => ({
                    category: p.category,
                    minAzn: Number(p.min_amount_minor) / 100,
                    maxAzn: p.max_amount_minor == null ? '' : Number(p.max_amount_minor) / 100,
                    method: p.method,
                  }))
                : [
                    { category: '*', minAzn: 0, maxAzn: 500, method: 'DIRECT' },
                    { category: '*', minAzn: 500, maxAzn: '', method: 'RFQ' },
                  ]);
              setMpEditing(true);
            }}>
            ✎ {t('followups_edit')}
          </button>
        )}

        {isAdmin && mpEditing && (
          <div style={{ marginTop: 8 }}>
            <table>
              <thead><tr><th>{t('category')}</th><th>{t('from')} (AZN)</th><th>{t('to')} (AZN)</th><th>{t('method')}</th><th /></tr></thead>
              <tbody>
                {mpDraft.map((d, i) => (
                  <tr key={i}>
                    <td>
                      <input list="mp-cats" value={d.category} style={{ width: 130 }} placeholder="*"
                        onChange={(e) => setMpDraft(mpDraft.map((x, j) => j === i ? { ...x, category: e.target.value || '*' } : x))} />
                    </td>
                    <td>
                      <input type="number" min={0} value={d.minAzn} style={{ width: 110 }}
                        onChange={(e) => setMpDraft(mpDraft.map((x, j) => j === i ? { ...x, minAzn: Number(e.target.value) } : x))} />
                    </td>
                    <td>
                      <input type="number" min={0} value={d.maxAzn} style={{ width: 110 }} placeholder="∞"
                        onChange={(e) => setMpDraft(mpDraft.map((x, j) => j === i ? { ...x, maxAzn: e.target.value } : x))} />
                    </td>
                    <td>
                      <select value={d.method}
                        onChange={(e) => setMpDraft(mpDraft.map((x, j) => j === i ? { ...x, method: e.target.value } : x))}>
                        <option value="DIRECT">{MP_ICO.DIRECT} {mLabel('DIRECT')}</option>
                        <option value="RFQ">{MP_ICO.RFQ} {mLabel('RFQ')}</option>
                        <option value="OPEN_TENDER">{MP_ICO.OPEN_TENDER} {mLabel('OPEN_TENDER')}</option>
                      </select>
                    </td>
                    <td><button className="btn small ghost" onClick={() => setMpDraft(mpDraft.filter((_, j) => j !== i))}>{t('delete')}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <datalist id="mp-cats">
              <option value="*" />
              {cats.map((c: any) => <option key={c.code} value={c.code} />)}
            </datalist>
            <button className="btn small ghost" onClick={() => {
              const last = mpDraft[mpDraft.length - 1];
              setMpDraft([...mpDraft, { category: last?.category ?? '*', minAzn: Number(last?.maxAzn) || 0, maxAzn: '', method: 'RFQ' }]);
            }}>{t('mp_add_band')}</button>
            <button className="btn small" style={{ marginLeft: 6 }} disabled={!mpDraft.length}
              onClick={() => run(async () => {
                await api.put('/requests/method-policies', {
                  policies: mpDraft.map((d) => ({
                    category: d.category.trim() || '*',
                    minAmountMinor: Math.round(Number(d.minAzn) * 100),
                    maxAmountMinor: d.maxAzn === '' ? null : Math.round(Number(d.maxAzn) * 100),
                    method: d.method,
                  })),
                });
                setMpEditing(false);
              })}>{t('followups_save')}</button>
            <button className="btn small ghost" onClick={() => setMpEditing(false)}>{t('followups_cancel')}</button>
          </div>
        )}
      </div>

      <div id="set-channels"><ChannelsCard isAdmin={isAdmin} /></div>

      <div className="card">
        <h3 id="set-integrations">{t('integrations')}</h3>
        <div className="hint" style={{ marginBottom: 10 }}>{t('integ_standards')}</div>
        <button className="btn small ghost" onClick={download1c}>📤 {t('integ_1c')}</button>
      </div>

      <div className="card">
        <h3 id="set-approval">🖊 {t('approval_chain')}</h3>
        <div className="hint" style={{ marginBottom: 4 }}>{t('chain_explain')}</div>
        <div className="hint" style={{ marginBottom: 10 }}>🛡 {t('chain_sod_note')}</div>

        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>{t('chain_current')}</div>
        {/* "nothing requires approval" is a statement about a live control: never say it
            because the request for the chain failed. */}
        {!approvalList.loading && !approvalList.failed && approvals.length === 0 && <div style={{ marginBottom: 8 }}>{t('chain_none')}</div>}
        {approvals
          .slice()
          .sort((a: any, b: any) => Number(a.min_amount_minor) - Number(b.min_amount_minor))
          .map((p) => (
            <div key={p.id} style={{ padding: '6px 0', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <b>{fmtMoney(p.min_amount_minor)} – {p.max_amount_minor ? fmtMoney(p.max_amount_minor) : '∞'}</b>
              <span style={{ color: 'var(--muted)' }}>:</span>
              {(p.steps ?? []).sort((a: any, b: any) => a.order - b.order).map((s: any, i: number, arr: any[]) => (
                <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <span className="badge is-info">{ROLE_ICO[s.role] ?? '👤'} {i + 1} · {roleLabel(s.role)}</span>
                  {i < arr.length - 1 && <span style={{ color: 'var(--muted)' }}>→</span>}
                </span>
              ))}
            </div>
          ))}

        {isAdmin && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>{t('chain_presets')}</div>
            {/* A grid rather than a wrapping flex row. With four cards the row filled and
                nobody noticed; the fifth one wrapped, and a stretched `flex: 1 1 220px` made
                it 340px wide under a row of 234px ones — one card visibly unlike its
                neighbours, which reads as «this one is different» rather than «this one is
                next». Equal columns say what is true: five ways to arrange the same thing. */}
            <div data-testid="chain-presets"
              style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
              {Object.entries(CHAIN_PRESETS).map(([key, preset]) => {
                const active = activeChainKey === key;
                return (
                  <div key={key} role="button" tabIndex={0} data-testid={`chain-preset-${key}`}
                    onClick={() => chainKnown && !active && setChain(key)}
                    onKeyDown={(e) => e.key === 'Enter' && chainKnown && !active && setChain(key)}
                    style={{
                      cursor: active || !chainKnown ? 'default' : 'pointer', minWidth: 0,
                      border: `2px solid ${active ? 'var(--accent, #2f7050)' : '#e2e6ea'}`,
                      background: active ? '#f2faf5' : '#fff', borderRadius: 10, padding: '10px 12px',
                    }}>
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>
                      {preset.label} {active && <span className="badge is-good" style={{ marginLeft: 4 }}>✓ {t('chain_active')}</span>}
                    </div>
                    {preset.policies.length === 0 && <div className="hint">{t('chain_p0_desc')}</div>}
                    {preset.policies.map((b: any, i: number) => (
                      <div key={i} className="hint" style={{ padding: '2px 0' }}>
                        {fmtMoney(b.minAmountMinor)} – {b.maxAmountMinor ? fmtMoney(b.maxAmountMinor) : '∞'}:{' '}
                        {b.steps.map((s: any) => `${ROLE_ICO[s.role] ?? '👤'} ${roleLabel(s.role)}`).join(' → ')}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
