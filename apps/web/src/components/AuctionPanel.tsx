import { useCallback, useEffect, useState } from 'react';
import { api, fmtMoney } from '../api/client';
import { useI18n } from '../i18n';

// Live auction state for both sides. Amounts come from the REST endpoint only;
// the socket merely signals "state changed" (see backend design).
export function AuctionPanel({ eventId, onChanged }: { eventId: string; onChanged?: () => void }) {
  const { t } = useI18n();
  const [state, setState] = useState<any>(null);

  const load = useCallback(
    () => api.get(`/events/${eventId}/auction/state`).then((r) => setState(r.data)).catch(() => {}),
    [eventId],
  );
  useEffect(() => {
    load();
    const iv = setInterval(load, 5000); // poll fallback alongside the WS signal
    return () => clearInterval(iv);
  }, [load]);

  if (!state) return null;
  return (
    <div className="card" style={{ borderColor: 'var(--accent2)' }}>
      <h3>⚡ {t('auction')} — REVERSE</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        <div><div className="hint">Start</div><b>{fmtMoney(state.start_price_minor, state.currency)}</b></div>
        <div><div className="hint">{t('best_price')}</div>
          <b style={{ color: 'var(--ok)' }}>{state.best_total_minor != null ? fmtMoney(state.best_total_minor, state.currency) : '—'}</b></div>
        <div><div className="hint">{t('next_max')}</div><b>{fmtMoney(state.next_max_total_minor, state.currency)}</b></div>
        <div><div className="hint">{t('bidders')}</div><b>{state.distinct_bidders}</b></div>
        <div><div className="hint">{t('extensions')}</div><b>{state.extension_count}</b></div>
        {state.my_best_total_minor != null && (
          <div><div className="hint">{t('my_bid')}</div><b>{fmtMoney(state.my_best_total_minor, state.currency)}</b></div>
        )}
      </div>
      <div className="hint" style={{ marginTop: 8 }}>
        {t('deadline')}: {new Date(state.close_at).toLocaleString()}
      </div>
      {onChanged && <AuctionRefresher onTick={() => { load(); onChanged(); }} />}
    </div>
  );
}

function AuctionRefresher({ onTick }: { onTick: () => void }) {
  useEffect(() => {
    const iv = setInterval(onTick, 7000);
    return () => clearInterval(iv);
  }, [onTick]);
  return null;
}
