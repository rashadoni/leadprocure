import { useRef, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/auth';
import { useI18n } from '../i18n';
import { VERIFICATION_DOC_TYPES } from '@leadprocure/shared';
import { Badge } from '../components/Badge';
import { ListState, useLoad } from '../components/ListState';

async function sha256(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default function Verification() {
  const { t } = useI18n();
  const { session } = useAuth();
  const isBuyer = session?.org.kind !== 'SUPPLIER';
  const [open, setOpen] = useState<Record<string, any>>({});
  const [docType, setDocType] = useState('VOEN');
  const fileRef = useRef<HTMLInputElement>(null);

  const caseList = useLoad(() => api.get('/verification/cases').then((r) => r.data), [], [] as any[]);
  const cases = caseList.data;
  const load = () => caseList.reload();

  const expand = async (id: string) => {
    if (open[id]) { setOpen((o) => ({ ...o, [id]: null })); return; }
    const { data } = await api.get(`/verification/cases/${id}`);
    setOpen((o) => ({ ...o, [id]: data }));
  };
  const refresh = async (id: string) => { const { data } = await api.get(`/verification/cases/${id}`); setOpen((o) => ({ ...o, [id]: data })); load(); };

  const decide = async (id: string, status: string) => {
    try { await api.post(`/verification/cases/${id}/decide`, { status }); refresh(id); }
    catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  const upload = async (caseId: string, file: File) => {
    try {
      const { data: pre } = await api.post('/verification/presign', { filename: file.name, mime: file.type || 'application/octet-stream' });
      const put = await fetch(pre.uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
      if (!put.ok) throw new Error(`upload failed (${put.status})`);
      await api.post(`/verification/cases/${caseId}/documents`, { docType, storageKey: pre.storageKey, filename: file.name, sha256: await sha256(file) });
      refresh(caseId);
    } catch (e: any) { alert(e.response?.data?.message?.toString() ?? e.message ?? 'Error'); }
    finally { if (fileRef.current) fileRef.current.value = ''; }
  };

  const download = async (docId: string) => {
    const { data } = await api.get(`/verification/documents/${docId}/download`);
    if (data.url) window.open(data.url, '_blank');
  };

  return (
    <>
      <h1>🛡 {t('verification')}</h1>
      <div className="card">
        <ListState of={caseList} />
        <table>
          <thead><tr><th>{isBuyer ? t('supplier_org') : t('buyer_org')}</th><th>{t('status')}</th><th>{t('attachments')}</th></tr></thead>
          <tbody>
            {cases.map((c) => (
              <tr key={c.id}>
                <td><a href="#" onClick={(e) => { e.preventDefault(); expand(c.id); }}>{isBuyer ? c.supplier_name : c.buyer_name}</a></td>
                <td><Badge status={c.status} /></td>
                <td>{c.doc_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!caseList.loading && !caseList.failed && cases.length === 0 && <div className="hint">—{isBuyer ? ` ${t('hint_verification_empty')}` : ''}</div>}
      </div>

      {Object.entries(open).filter(([, v]) => v).map(([id, c]) => (
        <div className="card" key={id}>
          <h3>{isBuyer ? c.supplier_name : c.buyer_name} <Badge status={c.status} /></h3>
          {c.documents.map((d: any) => (
            <div key={d.id} style={{ fontSize: 13, padding: '3px 0' }}>
              <span className="badge is-info">{d.doc_type}</span>{' '}
              <a href="#" onClick={(e) => { e.preventDefault(); download(d.id); }}>{d.filename}</a>{' '}
              {/* The stored fingerprint, shown: an auditor asks "is this the file that was
                  uploaded?", and the answer has to be visible, not merely kept in a column. */}
              {d.sha256 && (
                <span className="hint" data-tip={t('tip_doc_hash')} style={{ fontFamily: 'monospace' }}>
                  🔒 {String(d.sha256).slice(0, 12)}
                </span>
              )}
            </div>
          ))}
          {!isBuyer && (
            <div className="row" style={{ marginTop: 10, maxWidth: 460 }}>
              <select value={docType} onChange={(e) => setDocType(e.target.value)}>
                {VERIFICATION_DOC_TYPES.map((dt) => <option key={dt} value={dt}>{dt}</option>)}
              </select>
              <input ref={fileRef} type="file" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(c.id, f); }} />
            </div>
          )}
          {isBuyer && !['APPROVED', 'REJECTED'].includes(c.status) && (
            <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
              <button className="btn small" data-tip={t('tip_verify_approve')} onClick={() => decide(c.id, 'APPROVED')}>{t('approve')}</button>
              <button className="btn small ghost" data-tip={t('tip_verify_reject')} onClick={() => decide(c.id, 'REJECTED')}>{t('reject')}</button>
            </div>
          )}
        </div>
      ))}
    </>
  );
}
