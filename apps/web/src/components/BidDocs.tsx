import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useI18n } from '../i18n';

async function sha256(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Bid attachments. The supplier uploads via presigned PUT straight to object storage,
// then confirms metadata; the buyer sees them (read-only) once the event is opened.
export function BidDocs({ bidId, canUpload }: { bidId: string; canUpload: boolean }) {
  const { t } = useI18n();
  const [docs, setDocs] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => api.get(`/documents/bid/${bidId}`).then((r) => setDocs(r.data)).catch(() => {}), [bidId]);
  useEffect(() => { load(); }, [load]);

  const upload = async (file: File) => {
    setBusy(true); setMsg('');
    try {
      const { data: pre } = await api.post(`/documents/bid/${bidId}/presign`, { filename: file.name, mime: file.type || 'application/octet-stream' });
      const put = await fetch(pre.uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
      if (!put.ok) throw new Error(`upload failed (${put.status})`);
      await api.post(`/documents/bid/${bidId}/confirm`, {
        storageKey: pre.storageKey, filename: file.name, mime: file.type || 'application/octet-stream',
        sizeBytes: file.size, sha256: await sha256(file),
      });
      setMsg('OK');
      load();
    } catch (e: any) { setMsg(e.response?.data?.message?.toString() ?? e.message ?? 'Error'); }
    finally { setBusy(false); if (inputRef.current) inputRef.current.value = ''; }
  };

  const download = async (id: string) => {
    const { data } = await api.get(`/documents/bid-doc/${id}/download`);
    if (data.url) window.open(data.url, '_blank');
  };

  return (
    <div>
      {docs.map((d) => (
        <div key={d.id} style={{ fontSize: 12 }}>
          📎 <a href="#" onClick={(e) => { e.preventDefault(); download(d.id); }}>{d.filename}</a>
          <span className="hint"> · {(Number(d.size_bytes) / 1024).toFixed(0)} KB</span>
        </div>
      ))}
      {canUpload && (
        <div style={{ marginTop: 6 }}>
          <input ref={inputRef} type="file" disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
          {busy && <span className="hint"> …</span>}
          {msg && msg !== 'OK' && <span className="error"> {msg}</span>}
        </div>
      )}
    </div>
  );
}
