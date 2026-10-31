import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDateTime } from '../../api/client';
import { useI18n } from '../../i18n';
import Pager from '../../components/Pager';
import { Badge } from '../../components/Badge';
import { ListState, useLoad } from '../../components/ListState';

// Procedure chip: icon + label so the list shows WHAT kind of procedure each row is.
const TYPE_META: Record<string, { ico: string; label: string }> = {
  RFQ: { ico: '🔒', label: 'RFQ' }, RFP: { ico: '📄', label: 'RFP' },
  RFI: { ico: '❓', label: 'RFI' }, AUCTION: { ico: '⚡', label: 'AUKSION' },
};

const PAGE_SIZE = 20;

export default function Events() {
  const { t } = useI18n();
  const [page, setPage] = useState(1);
  const events = useLoad(
    () => api.get('/events', { params: { page, pageSize: PAGE_SIZE } }).then((r) => r.data),
    [page],
    { items: [] as any[], total: 0 },
  );
  const rows: any[] = events.data.items ?? [];
  return (
    <>
      <h1>{t('events')}</h1>
      <div className="card">
        <ListState of={events} empty={!rows.length} />
        <table>
          <thead><tr><th>{t('title')}</th><th>{t('method')}</th><th>{t('status')}</th><th>{t('deadline')}</th><th>{t('bids_received')}</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><Link to={`/buyer/events/${r.id}`}>{r.title}</Link></td>
                <td>
                  <span className="chip" data-tip={t(`tip_${(r.type ?? '').toLowerCase()}`)}>
                    <span className="chip-ico">{TYPE_META[r.type]?.ico ?? '•'}</span>
                    {r.type === 'AUCTION' ? t('auction') : (TYPE_META[r.type]?.label ?? r.type)}
                  </span>
                </td>
                <td><Badge status={r.status} /></td>
                <td className="hint">{fmtDateTime(r.close_at)}</td>
                <td>{r.bid_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager total={events.data.total ?? 0} page={page} pageSize={PAGE_SIZE} onPage={setPage} />
      </div>
    </>
  );
}
