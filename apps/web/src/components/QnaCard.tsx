import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useI18n } from '../i18n';

// Q&A / addenda with equal disclosure: unpublished questions are visible only to
// the asker and the buyer; published answers and addenda — to every eligible supplier.
export function QnaCard({ eventId, isBuyer }: { eventId: string; isBuyer: boolean }) {
  const { t } = useI18n();
  const [rows, setRows] = useState<any[]>([]);
  const [question, setQuestion] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [addendum, setAddendum] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(() => api.get(`/events/${eventId}/qna`).then((r) => setRows(r.data)), [eventId]);
  useEffect(() => { load(); }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setMsg('');
    try { await fn(); load(); }
    catch (e: any) { setMsg(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  return (
    <div className="card">
      <h3>💬 {t('qna')}</h3>
      {rows.map((r) => (
        <div key={r.id} style={{ borderBottom: '1px solid var(--border)', padding: '8px 0' }}>
          <div>
            {r.kind === 'ADDENDUM' ? <span className="badge INVITED">{t('addendum')}</span> : null}{' '}
            <b>{r.question}</b> {r.mine && <span className="hint">({t('my_bid').split(' ')[0].toLowerCase()})</span>}
            {!r.is_published && <span className="sealed"> · unpublished</span>}
          </div>
          {r.answer && <div style={{ color: 'var(--ok)', marginTop: 4 }}>↳ {r.answer}</div>}
          {isBuyer && r.kind === 'QUESTION' && !r.answer && (
            <div className="row" style={{ marginTop: 6, maxWidth: 520 }}>
              <input placeholder={t('answer')} value={answers[r.id] ?? ''}
                onChange={(e) => setAnswers({ ...answers, [r.id]: e.target.value })} />
              <button className="btn small" disabled={!answers[r.id]}
                onClick={() => run(() => api.post(`/events/${eventId}/qna/${r.id}/answer`, { answer: answers[r.id] }))}>
                {t('answer')} 📢
              </button>
            </div>
          )}
        </div>
      ))}
      {rows.length === 0 && <div className="hint">—</div>}

      {!isBuyer && (
        <div className="row" style={{ marginTop: 12, maxWidth: 520 }}>
          <input placeholder={`${t('ask')}…`} value={question} onChange={(e) => setQuestion(e.target.value)} />
          <button className="btn small" disabled={!question}
            onClick={() => run(async () => { await api.post(`/events/${eventId}/qna`, { question }); setQuestion(''); })}>
            {t('ask')}
          </button>
        </div>
      )}
      {isBuyer && (
        <div className="row" style={{ marginTop: 12, maxWidth: 520 }}>
          <input placeholder={`${t('addendum')}…`} value={addendum} onChange={(e) => setAddendum(e.target.value)} />
          <button className="btn small ghost" disabled={!addendum}
            onClick={() => run(async () => { await api.post(`/events/${eventId}/addenda`, { text: addendum }); setAddendum(''); })}>
            📢 {t('addendum')}
          </button>
        </div>
      )}
      {msg && <div className="error">{msg}</div>}
    </div>
  );
}
