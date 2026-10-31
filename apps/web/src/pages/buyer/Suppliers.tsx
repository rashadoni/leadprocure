import { useState } from 'react';
import { api } from '../../api/client';
import { useAuth } from '../../auth/auth';
import { useI18n } from '../../i18n';
import { Badge } from '../../components/Badge';
import { ListState, useLoad } from '../../components/ListState';

export default function Suppliers() {
  const { t } = useI18n();
  const { session } = useAuth();
  // Every write on this page — invite, approve, block, rate, open a verification case —
  // takes BUYER_ADMIN or BUYER_APPROVER. They were all drawn for everyone, so a plain
  // user got a row of buttons that answer 403; a button that always fails is worse than
  // no button.
  const canManage = ['BUYER_ADMIN', 'BUYER_APPROVER'].includes(session?.org.role ?? '');
  const registry = useLoad(() => api.get('/suppliers').then((r) => r.data), [], [] as any[]);
  const directory = useLoad(() => api.get('/suppliers/directory').then((r) => r.data), [], [] as any[]);
  const reload = () => { registry.reload(); directory.reload(); };

  // A write that fails must say so: these used to reject unhandled, leaving the row
  // unchanged with no explanation.
  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); reload(); }
    catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };
  const invite = (orgId: string) => act(() => api.post(`/suppliers/${orgId}/invite`));
  const setStatus = (relId: string, status: string) =>
    act(() => api.post(`/suppliers/relationships/${relId}/status`, { status }));

  const [scores, setScores] = useState<Record<string, any>>({});
  const loadScore = async (orgId: string) => {
    const r = await api.get(`/suppliers/${orgId}/scorecard`);
    setScores((s) => ({ ...s, [orgId]: r.data.averages }));
  };
  const rate = async (orgId: string) => {
    const raw = prompt('OTIF score 0-100:', '90');
    if (raw == null) return;
    try {
      await api.post(`/suppliers/${orgId}/scorecard`, { metric: 'OTIF', score: Number(raw) });
      await loadScore(orgId);
    } catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };
  const openVerification = async (supplierOrgId: string) => {
    try {
      await api.post('/verification/cases', { supplierOrgId });
      alert(t('verification') + ' →');
    } catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  const inRegistry = new Set(registry.data.map((r) => r.supplier_org_id));

  return (
    <>
      <h1>{t('suppliers')}</h1>
      <div className="card">
        <h3>{t('registry')}</h3>
        <ListState of={registry} empty={!registry.data.length} />
        <table>
          <thead><tr><th>{t('company')}</th><th>VÖEN</th><th>{t('status')}</th><th>{t('actions')}</th></tr></thead>
          <tbody>
            {registry.data.map((r) => (
              <tr key={r.id}>
                <td>{r.legal_name}</td>
                <td>{r.voen ?? '—'}</td>
                <td><Badge status={r.status} /></td>
                <td>
                  {canManage && <>
                    {r.status !== 'APPROVED' && <button className="btn small" data-tip={t('tip_supplier_approve')} onClick={() => setStatus(r.id, 'APPROVED')}>{t('approve')}</button>}{' '}
                    {r.status !== 'BLOCKED' && <button className="btn small ghost" data-tip={t('tip_supplier_block')} onClick={() => setStatus(r.id, 'BLOCKED')}>{t('block')}</button>}{' '}
                    <button className="btn small ghost" data-tip={t('tip_scorecard')} onClick={() => rate(r.supplier_org_id)}>★ {t('scorecard')}</button>{' '}
                    <button className="btn small ghost" data-tip={t('tip_verify_open')} onClick={() => openVerification(r.supplier_org_id)}>🛡</button>
                  </>}
                  {scores[r.supplier_org_id] && (
                    <span className="hint" style={{ marginLeft: 6 }}>
                      {scores[r.supplier_org_id].map((a: any) => `${a.metric}:${a.avg_score}`).join(' ')}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h3>{t('directory')}</h3>
        <ListState of={directory} empty={!directory.data.length} />
        <table>
          <thead><tr><th>{t('company')}</th><th>VÖEN</th><th>{t('category')}</th><th></th></tr></thead>
          <tbody>
            {directory.data.map((s) => (
              <tr key={s.id}>
                <td>{s.legal_name}</td>
                <td>{s.voen ?? '—'}</td>
                <td>{(s.categories ?? []).join(', ')}</td>
                <td>{canManage && !inRegistry.has(s.id) && <button className="btn small" data-tip={t('tip_supplier_invite')} onClick={() => invite(s.id)}>{t('invite')}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
