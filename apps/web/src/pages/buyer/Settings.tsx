import { FormEvent, useEffect, useState } from 'react';
import { api, fmtMoney } from '../../api/client';
import { useAuth } from '../../auth/auth';
import { useI18n } from '../../i18n';
import { BUYER_ROLES } from '@leadprocure/shared';

export default function Settings() {
  const { t } = useI18n();
  const { session } = useAuth();
  const [users, setUsers] = useState<any[]>([]);
  const [policies, setPolicies] = useState<any[]>([]);
  const [approvals, setApprovals] = useState<any[]>([]);
  const [cats, setCats] = useState<any[]>([]);
  const [newCat, setNewCat] = useState({ code: '', name: '' });
  const [nu, setNu] = useState({ email: '', fullName: '', password: '', role: 'BUYER_USER' });
  const isAdmin = session?.org.role === 'BUYER_ADMIN';

  // Method-policy editor (value bands → procurement method).
  const [mpEditing, setMpEditing] = useState(false);
  const [mpDraft, setMpDraft] = useState<Array<{ category: string; minAzn: number; maxAzn: number | string; method: string }>>([]);
  const MP_COLOR: Record<string, string> = { DIRECT: '#e7f6ec', RFQ: '#eef2ff', OPEN_TENDER: '#fff7ed' };
  const MP_ICO: Record<string, string> = { DIRECT: '📦', RFQ: '🔒', OPEN_TENDER: '🌐' };
  const mLabel = (m: string) => { const l = t(`mt_${m}`); return l === `mt_${m}` ? m : l; };

  const load = () => {
    api.get('/settings/users').then((r) => setUsers(r.data));
    api.get('/requests/method-policies').then((r) => setPolicies(r.data));
    api.get('/requests/approval-policies').then((r) => setApprovals(r.data));
    api.get('/categories').then((r) => setCats(r.data)).catch(() => {});
  };
  useEffect(load, []);

  const run = async (fn: () => Promise<unknown>) => {
    try { await fn(); load(); } catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };

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
    } catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  // Approval-chain presets the admin can switch between (fixes the "one-shot button").
  const CHAIN_PRESETS: Record<string, { label: string; policies: any[] }> = {
    p0: { label: t('chain_p0'), policies: [] },
    p1: { label: t('chain_p1'), policies: [{ minAmountMinor: 0, maxAmountMinor: null, steps: [{ order: 1, role: 'BUYER_APPROVER' }] }] },
    p2: { label: t('chain_p2'), policies: [
      { minAmountMinor: 0, maxAmountMinor: 5_000_000, steps: [{ order: 1, role: 'BUYER_APPROVER' }] },
      { minAmountMinor: 5_000_000, maxAmountMinor: null, steps: [{ order: 1, role: 'BUYER_APPROVER' }, { order: 2, role: 'BUYER_ADMIN' }] },
    ] },
  };
  const setChain = (key: string) => run(() => api.put('/requests/approval-policies', { policies: CHAIN_PRESETS[key].policies }));
  const ROLE_ICO: Record<string, string> = { BUYER_ADMIN: '👑', BUYER_APPROVER: '🖊', BUYER_USER: '👤' };
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
  const activeChainKey = Object.entries(CHAIN_PRESETS).find(([, pr]) => chainSig(pr.policies) === chainSig(approvals))?.[0];

  const addUser = (e: FormEvent) => {
    e.preventDefault();
    run(() => api.post('/settings/users', nu)).then(() => setNu({ email: '', fullName: '', password: '', role: 'BUYER_USER' }));
  };

  return (
    <>
      <h1>{t('settings')}</h1>
      <div className="card">
        <h3>{t('users')}</h3>
        <table>
          <thead><tr><th>{t('email')}</th><th>{t('name')}</th><th>{t('role')}</th></tr></thead>
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
                    <span className="badge INVITED">{roleLabel(u.role)}</span>
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
            <div><label>{t('password')}</label><input required minLength={8} value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} /></div>
            <div><label>{t('role')}</label>
              <select value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value })}>
                {BUYER_ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
              </select>
            </div>
            <button className="btn">+</button>
          </form>
        )}
      </div>

      <div className="card">
        <h3>{t('cat_hdr')}</h3>
        <div className="hint" style={{ marginBottom: 10 }}>{t('cat_hint')}</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: isAdmin ? 12 : 0 }}>
          {cats.length === 0 && <span className="hint">—</span>}
          {cats.map((c) => (
            <span key={c.id} className="badge INVITED" data-tip={c.name || undefined}>
              {c.code}{c.name ? ` · ${c.name}` : ''}
              {isAdmin && (
                <button className="btn small ghost" style={{ marginLeft: 6, padding: '0 6px' }}
                  onClick={() => run(() => api.delete(`/categories/${c.id}`))}>✕</button>
              )}
            </span>
          ))}
        </div>
        {isAdmin && (
          <form className="row" style={{ maxWidth: 560 }}
            onSubmit={(e) => { e.preventDefault(); if (newCat.code.trim()) run(() => api.post('/categories', newCat)).then(() => setNewCat({ code: '', name: '' })); }}>
            <div><label>{t('cat_code')}</label><input value={newCat.code} onChange={(e) => setNewCat({ ...newCat, code: e.target.value })} placeholder="IT" /></div>
            <div><label>{t('name')}</label><input value={newCat.name} onChange={(e) => setNewCat({ ...newCat, name: e.target.value })} /></div>
            <button className="btn">+</button>
          </form>
        )}
      </div>

      <div className="card">
        <h3>⚖️ {t('method_policy')}</h3>
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
            <div style={{ display: 'flex', borderRadius: 10, overflow: 'hidden', border: '1px solid #e2e6ea' }}>
              {(bands as any[]).sort((a, b) => Number(a.min_amount_minor) - Number(b.min_amount_minor)).map((p) => (
                <div key={p.id} style={{
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
        {policies.length === 0 && <p className="hint">— {isAdmin ? t('mp_empty_admin') : t('mp_empty')}</p>}

        {isAdmin && !mpEditing && (
          <button className="btn small ghost" style={{ marginTop: 6 }}
            onClick={() => {
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
                    <td><button className="btn small ghost" onClick={() => setMpDraft(mpDraft.filter((_, j) => j !== i))}>✕</button></td>
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

      <div className="card">
        <h3>{t('integrations')}</h3>
        <div className="hint" style={{ marginBottom: 10 }}>{t('integ_standards')}</div>
        <button className="btn small ghost" onClick={download1c}>📤 {t('integ_1c')}</button>
      </div>

      <div className="card">
        <h3>🖊 {t('approval_chain')}</h3>
        <div className="hint" style={{ marginBottom: 4 }}>{t('chain_explain')}</div>
        <div className="hint" style={{ marginBottom: 10 }}>🛡 {t('chain_sod_note')}</div>

        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>{t('chain_current')}</div>
        {approvals.length === 0 && <div style={{ marginBottom: 8 }}>{t('chain_none')}</div>}
        {approvals
          .slice()
          .sort((a: any, b: any) => Number(a.min_amount_minor) - Number(b.min_amount_minor))
          .map((p) => (
            <div key={p.id} style={{ padding: '6px 0', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <b>{fmtMoney(p.min_amount_minor)} – {p.max_amount_minor ? fmtMoney(p.max_amount_minor) : '∞'}</b>
              <span style={{ color: 'var(--muted)' }}>:</span>
              {(p.steps ?? []).sort((a: any, b: any) => a.order - b.order).map((s: any, i: number, arr: any[]) => (
                <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <span className="badge INVITED">{ROLE_ICO[s.role] ?? '👤'} {i + 1} · {roleLabel(s.role)}</span>
                  {i < arr.length - 1 && <span style={{ color: 'var(--muted)' }}>→</span>}
                </span>
              ))}
            </div>
          ))}

        {isAdmin && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>{t('chain_presets')}</div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {Object.entries(CHAIN_PRESETS).map(([key, preset]) => {
                const active = activeChainKey === key;
                return (
                  <div key={key} role="button" tabIndex={0}
                    onClick={() => !active && setChain(key)}
                    onKeyDown={(e) => e.key === 'Enter' && !active && setChain(key)}
                    style={{
                      cursor: active ? 'default' : 'pointer', minWidth: 220, flex: '1 1 220px', maxWidth: 340,
                      border: `2px solid ${active ? 'var(--accent, #2f7050)' : '#e2e6ea'}`,
                      background: active ? '#f2faf5' : '#fff', borderRadius: 10, padding: '10px 12px',
                    }}>
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>
                      {preset.label} {active && <span className="badge APPROVED" style={{ marginLeft: 4 }}>✓ {t('chain_active')}</span>}
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
