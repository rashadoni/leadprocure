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
  const [nu, setNu] = useState({ email: '', fullName: '', password: '', role: 'BUYER_USER' });
  const isAdmin = session?.org.role === 'BUYER_ADMIN';

  const load = () => {
    api.get('/settings/users').then((r) => setUsers(r.data));
    api.get('/requests/method-policies').then((r) => setPolicies(r.data));
    api.get('/requests/approval-policies').then((r) => setApprovals(r.data));
  };
  useEffect(load, []);

  const run = async (fn: () => Promise<unknown>) => {
    try { await fn(); load(); } catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };

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
                      {BUYER_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  ) : (
                    <span className="badge INVITED">{u.role}</span>
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
                {BUYER_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <button className="btn">+</button>
          </form>
        )}
      </div>

      <div className="card">
        <h3>{t('method_policy')}</h3>
        <table>
          <thead><tr><th>{t('category')}</th><th>{t('from')}</th><th>{t('to')}</th><th>{t('method')}</th></tr></thead>
          <tbody>
            {policies.map((p) => (
              <tr key={p.id}>
                <td>{p.category}</td>
                <td>{fmtMoney(p.min_amount_minor)}</td>
                <td>{p.max_amount_minor ? fmtMoney(p.max_amount_minor) : '∞'}</td>
                <td><span className="badge INVITED">{p.method}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        {isAdmin && policies.length === 0 && (
          <button className="btn small" style={{ marginTop: 10 }}
            onClick={() => run(() => api.put('/requests/method-policies', {
              policies: [
                { category: '*', minAmountMinor: 0, maxAmountMinor: 5_000_000, method: 'DIRECT' },
                { category: '*', minAmountMinor: 5_000_000, maxAmountMinor: null, method: 'RFQ' },
              ],
            }))}>
            Set default (50k AZN threshold)
          </button>
        )}
      </div>

      <div className="card">
        <h3>{t('approval_chain')}</h3>
        {approvals.length === 0 && <div className="hint">Single-step approval (no chain configured)</div>}
        {approvals.map((p) => (
          <div key={p.id} style={{ padding: '6px 0' }}>
            {fmtMoney(p.min_amount_minor)} – {p.max_amount_minor ? fmtMoney(p.max_amount_minor) : '∞'}:{' '}
            {(p.steps ?? []).sort((a: any, b: any) => a.order - b.order).map((s: any, i: number) => (
              <span key={i} className="badge INVITED" style={{ marginRight: 4 }}>{i + 1}. {s.role}</span>
            ))}
          </div>
        ))}
        {isAdmin && (
          <button className="btn small" style={{ marginTop: 10 }}
            onClick={() => run(() => api.put('/requests/approval-policies', {
              policies: [
                { minAmountMinor: 0, maxAmountMinor: 5_000_000, steps: [{ order: 1, role: 'BUYER_APPROVER' }] },
                { minAmountMinor: 5_000_000, maxAmountMinor: null, steps: [{ order: 1, role: 'BUYER_APPROVER' }, { order: 2, role: 'BUYER_ADMIN' }] },
              ],
            }))}>
            Set default 2-step chain (large = approver → admin)
          </button>
        )}
      </div>
    </>
  );
}
