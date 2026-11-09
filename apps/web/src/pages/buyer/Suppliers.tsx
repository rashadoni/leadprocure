import { useState } from 'react';
import { api } from '../../api/client';
import { useAuth } from '../../auth/auth';
import { useI18n } from '../../i18n';
import { useDialogs } from '../../components/Dialogs';
import { Badge } from '../../components/Badge';
import { Actions } from '../../components/Actions';
import { ListState, useLoad } from '../../components/ListState';

export default function Suppliers() {
  const { t } = useI18n();
  const { notify, notifyError, ask } = useDialogs();
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
    catch (e: any) { notifyError(e); }
  };
  const invite = (orgId: string) => act(() => api.post(`/suppliers/${orgId}/invite`));
  const setStatus = (relId: string, status: string) =>
    act(() => api.post(`/suppliers/relationships/${relId}/status`, { status }));

  const [scores, setScores] = useState<Record<string, any>>({});
  const loadScore = async (orgId: string) => {
    try {
      const r = await api.get(`/suppliers/${orgId}/scorecard`);
      setScores((s) => ({ ...s, [orgId]: r.data.averages }));
    } catch (e: any) { notifyError(e); }
  };
  const rate = async (orgId: string) => {
    const raw = await ask({
      title: t('otif_prompt'), hint: t('otif_hint'), type: 'number', integer: true, min: 0, max: 100, defaultValue: '90',
    });
    if (raw == null) return;
    try {
      await api.post(`/suppliers/${orgId}/scorecard`, { metric: 'OTIF', score: Number(raw) });
      await loadScore(orgId);
    } catch (e: any) { notifyError(e); }
  };
  const openVerification = async (supplierOrgId: string) => {
    try {
      await api.post('/verification/cases', { supplierOrgId });
      notify(t('verification_case_created'), 'ok');
    } catch (e: any) { notifyError(e); }
  };

  const inRegistry = new Set(registry.data.map((r) => r.supplier_org_id));

  return (
    <>
      <h1>{t('suppliers')}</h1>
      <div className="card" data-testid="registry-card">
        <h3>{t('registry')}</h3>
        <div className="hint">{t('registry_hint')}</div>
        <ListState of={registry} empty={!registry.data.length} emptyKey="empty_registry" />
        <table>
          <thead><tr><th className="grow">{t('company')}</th><th>VÖEN</th><th>{t('status')}</th><th className="acts">{t('actions')}</th></tr></thead>
          <tbody>
            {registry.data.map((r) => (
              <tr key={r.id}>
                <td>{r.legal_name}</td>
                <td>{r.voen ?? '—'}</td>
                <td><Badge status={r.status} /></td>
                <td>
                  {/* Blocking a supplier cuts them out of every future tender — last, and set
                      apart from approving, which used to sit right next to it. */}
                  {/* No menu here: this table has four columns, so the cell has the room —
                      measured at 1280 it was already one line before any of this work. */}
                  <Actions
                    danger={canManage && r.status !== 'BLOCKED' && (
                      <button className="btn small ghost danger" data-testid="sup-block" data-tip={t('tip_supplier_block')} onClick={() => setStatus(r.id, 'BLOCKED')}>{t('block')}</button>
                    )}
                  >
                  {scores[r.supplier_org_id] && (
                    <span className="hint" style={{ marginRight: 6 }}>
                      {scores[r.supplier_org_id].map((a: any) => `${a.metric}: ${a.avg_score}`).join(' · ')}
                    </span>
                  )}
                  {canManage && <>
                    {r.status !== 'APPROVED' && <button className="btn small" data-testid="sup-approve" data-tip={t('tip_supplier_approve')} onClick={() => setStatus(r.id, 'APPROVED')}>{t('approve')}</button>}
                    {/* was a bare 🛡 */}
                    <button className="btn small ghost" data-testid="sup-verify" data-tip={t('tip_verify_open')} onClick={() => openVerification(r.supplier_org_id)}>🛡 {t('verification')}</button>
                  </>}
                  {/* Rating is an approver's call, but the figures are everyone's to read —
                      and they only ever appeared as a side effect of rating someone. */}
                  <button className="btn small ghost" data-testid="sup-score" data-tip={t('tip_scorecard')}
                    onClick={() => (canManage ? rate(r.supplier_org_id) : loadScore(r.supplier_org_id))}>
                    ★ {t('scorecard')}
                  </button>
                  </Actions>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card" data-testid="directory-card">
        <h3>{t('directory')}</h3>
        <div className="hint">{t('directory_hint')}</div>
        <ListState of={directory} empty={!directory.data.length} emptyKey="empty_directory" />
        <table>
          <thead><tr><th className="grow">{t('company')}</th><th>VÖEN</th><th>{t('category')}</th><th className="acts">{t('actions')}</th></tr></thead>
          <tbody>
            {directory.data.map((s) => (
              <tr key={s.id}>
                <td>{s.legal_name}</td>
                <td>{s.voen ?? '—'}</td>
                <td>{(s.categories ?? []).join(', ')}</td>
                <td className="acts"><Actions>
                  {canManage && !inRegistry.has(s.id) && <button className="btn small" data-testid="dir-invite" data-tip={t('tip_supplier_invite')} onClick={() => invite(s.id)}>{t('invite')}</button>}
                </Actions></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
