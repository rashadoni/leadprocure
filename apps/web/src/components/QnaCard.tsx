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
            {r.kind === 'ADDENDUM' ? <span className="badge is-info">{t('addendum')}</span> : null}{' '}
            {/* «(мои)» came from taking the first word of «Мои ставки» and lowercasing
                it — a question is not a bid, and in Azerbaijani it read «(mənim)». And
                «unpublished» was plain English on all three languages. */}
            <b>{r.question}</b> {r.mine && <span className="hint">({t('qna_mine')})</span>}
            {!r.is_published && <span className="sealed"> · {t('qna_unpublished')}</span>}
          </div>
          {r.answer && <div style={{ color: 'var(--ok)', marginTop: 4 }}>↳ {r.answer}</div>}
          {isBuyer && r.kind === 'QUESTION' && !r.answer && (
            {/* The field was labelled by its placeholder with the VERB «Ответить» — the
                same word as the button beside it — and the placeholder vanished the moment
                anything was typed. Noun on the field, verb on the button. */}
            <div className="qna-row" style={{ marginTop: 6 }}>
              <div className="filter-field" style={{ flex: 1 }}>
                <label htmlFor={`qna-a-${r.id}`}>{t('qna_answer_field')}</label>
                <input id={`qna-a-${r.id}`} value={answers[r.id] ?? ''}
                  onChange={(e) => setAnswers({ ...answers, [r.id]: e.target.value })} />
              </div>
              <button className="btn small" disabled={!answers[r.id]}
                data-tip={answers[r.id] ? t('tip_qna_answer') : t('qna_need_text')}
                onClick={() => run(() => api.post(`/events/${eventId}/qna/${r.id}/answer`, { answer: answers[r.id] }))}>
                📢 {t('answer')}
              </button>
            </div>
          )}
        </div>
      ))}
      {rows.length === 0 && <div className="hint">—</div>}

      {!isBuyer && (
        <div className="qna-row" style={{ marginTop: 12 }}>
          <div className="filter-field" style={{ flex: 1 }}>
            <label htmlFor="qna-q">{t('qna_question')}</label>
            <input id="qna-q" value={question} onChange={(e) => setQuestion(e.target.value)} />
          </div>
          {/* a button disabled with no reason given: the tip says what is missing */}
          <button className="btn small" disabled={!question}
            data-tip={question ? t('tip_qna_ask') : t('qna_need_text')}
            onClick={() => run(async () => { await api.post(`/events/${eventId}/qna`, { question }); setQuestion(''); })}>
            {t('ask')}
          </button>
        </div>
      )}
      {isBuyer && (
        {/* Field and button both read «Əlavə» in Azerbaijani — the same word twice, one of
            them meant as «publish this». The field is named for what it holds, the button
            for what it does. */}
        <div className="qna-row" style={{ marginTop: 12 }}>
          <div className="filter-field" style={{ flex: 1 }}>
            <label htmlFor="qna-add">{t('addendum')}</label>
            <input id="qna-add" value={addendum} onChange={(e) => setAddendum(e.target.value)} />
          </div>
          <button className="btn small ghost" disabled={!addendum}
            data-tip={addendum ? t('tip_addendum') : t('qna_need_text')}
            onClick={() => run(async () => { await api.post(`/events/${eventId}/addenda`, { text: addendum }); setAddendum(''); })}>
            📢 {t('publish')}
          </button>
        </div>
      )}
      {msg && <div className="error">{msg}</div>}
    </div>
  );
}
