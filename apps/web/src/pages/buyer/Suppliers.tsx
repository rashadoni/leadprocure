import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';

export default function Suppliers() {
  const { t } = useI18n();
  const [registry, setRegistry] = useState<any[]>([]);
  const [directory, setDirectory] = useState<any[]>([]);

  const load = () => {
    api.get('/suppliers').then((r) => setRegistry(r.data));
    api.get('/suppliers/directory').then((r) => setDirectory(r.data));
  };
  useEffect(load, []);

  const invite = async (orgId: string) => { await api.post(`/suppliers/${orgId}/invite`); load(); };
  const setStatus = async (relId: string, status: string) => {
    await api.post(`/suppliers/relationships/${relId}/status`, { status }); load();
  };

  const [scores, setScores] = useState<Record<string, any>>({});
  const loadScore = async (orgId: string) => {
    const r = await api.get(`/suppliers/${orgId}/scorecard`);
    setScores((s) => ({ ...s, [orgId]: r.data.averages }));
  };
  const rate = async (orgId: string) => {
    const raw = prompt('OTIF score 0-100:', '90');
    if (raw == null) return;
    await api.post(`/suppliers/${orgId}/scorecard`, { metric: 'OTIF', score: Number(raw) });
    loadScore(orgId);
  };

  const inRegistry = new Set(registry.map((r) => r.supplier_org_id));

  return (
    <>
      <h1>{t('suppliers')}</h1>
      <div className="card">
        <h3>{t('registry')}</h3>
        <table>
          <thead><tr><th>{t('company')}</th><th>VÖEN</th><th>{t('status')}</th><th>{t('actions')}</th></tr></thead>
          <tbody>
            {registry.map((r) => (
              <tr key={r.id}>
                <td>{r.legal_name}</td>
                <td>{r.voen ?? '—'}</td>
                <td><span className={`badge ${r.status}`}>{r.status}</span></td>
                <td>
                  {r.status !== 'APPROVED' && <button className="btn small" onClick={() => setStatus(r.id, 'APPROVED')}>{t('approve')}</button>}{' '}
                  {r.status !== 'BLOCKED' && <button className="btn small ghost" onClick={() => setStatus(r.id, 'BLOCKED')}>Block</button>}{' '}
                  <button className="btn small ghost" onClick={() => rate(r.supplier_org_id)}>★ {t('scorecard')}</button>{' '}
                  <button className="btn small ghost" onClick={async () => { await api.post('/verification/cases', { supplierOrgId: r.supplier_org_id }); alert(t('verification') + ' →'); }}>🛡</button>
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
        <table>
          <thead><tr><th>{t('company')}</th><th>VÖEN</th><th>Categories</th><th></th></tr></thead>
          <tbody>
            {directory.map((s) => (
              <tr key={s.id}>
                <td>{s.legal_name}</td>
                <td>{s.voen ?? '—'}</td>
                <td>{(s.categories ?? []).join(', ')}</td>
                <td>{!inRegistry.has(s.id) && <button className="btn small" onClick={() => invite(s.id)}>{t('invite')}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
