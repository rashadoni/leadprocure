import { useCallback, useEffect, useState } from 'react';
import { api, fmtMoney } from '../api/client';
import { useI18n } from '../i18n';
import { isDenied, ListState } from './ListState';

// Live auction state for both sides. Amounts come from the REST endpoint only;
// the socket merely signals "state changed" (see backend design).
export function AuctionPanel({ eventId, onChanged }: { eventId: string; onChanged?: () => void }) {
  const { t } = useI18n();
  const [state, setState] = useState<any>(null);
  // This polls every 5s and the panel keeps the last numbers between polls. In a live
  // reverse auction that is the one place a silent failure costs money: the supplier
  // would be bidding against a best price that has already moved. Say when the last
  // refresh did not land.
  const [stale, setStale] = useState(false);
  // Reverse auction is its own licence key, separate from sourcing.rfq, so an org can
  // legitimately open a REVERSE event and be denied this endpoint. That answer will not
  // change on the next poll: show nothing and stop asking, instead of an error banner the
  // supplier cannot act on and a request every five seconds behind it.
  const [denied, setDenied] = useState(false);

  const load = useCallback(
    () => api.get(`/events/${eventId}/auction/state`)
      .then((r) => { setState(r.data); setStale(false); })
      .catch((e: any) => { if (isDenied(e)) setDenied(true); else setStale(true); }),
    [eventId],
  );
  useEffect(() => {
    if (denied) return;
    load();
    const iv = setInterval(load, 5000); // poll fallback alongside the WS signal
    return () => clearInterval(iv);
  }, [load, denied]);

  if (denied) return null;
  if (!state) {
    return stale ? (
      <div className="card" style={{ borderColor: 'var(--accent2)' }}>
        <h3>⚡ {t('auction')}</h3>
        <ListState of={{ loading: false, failed: true, reload: load }} />
      </div>
    ) : null;
  }
  return (
    <div className="card" style={{ borderColor: 'var(--accent2)' }}>
      <h3>⚡ {t('auction')} — REVERSE</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        <div><div className="hint">{t('auction_start')}</div><b>{fmtMoney(state.start_price_minor, state.currency)}</b></div>
        <div><div className="hint">{t('best_price')}</div>
          <b style={{ color: 'var(--ok)' }}>{state.best_total_minor != null ? fmtMoney(state.best_total_minor, state.currency) : '—'}</b></div>
        <div><div className="hint">{t('next_max')}</div><b>{fmtMoney(state.next_max_total_minor, state.currency)}</b></div>
        <div><div className="hint">{t('bidders')}</div><b>{state.distinct_bidders}</b></div>
        <div><div className="hint">{t('extensions')}</div><b>{state.extension_count}</b></div>
        {state.my_best_total_minor != null && (
          <div><div className="hint">{t('my_bid')}</div><b>{fmtMoney(state.my_best_total_minor, state.currency)}</b></div>
        )}
      </div>
      {stale && <div role="alert" style={{ marginTop: 8 }}>{t('auction_stale')}</div>}
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
