import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDateTime } from '../../api/client';
import { useI18n } from '../../i18n';
import Pager from '../../components/Pager';
import { Badge } from '../../components/Badge';

// Procedure chip: the list must show WHAT kind of procedure each row is.
const TYPE_CHIP: Record<string, string> = { RFQ: 'RFQ 🔒', RFP: 'RFP 📄', RFI: 'RFI ❓', AUCTION: '⚡' };

const PAGE_SIZE = 20;

export default function Events() {
  const { t } = useI18n();
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  useEffect(() => {
    api.get('/events', { params: { page, pageSize: PAGE_SIZE } })
      .then((r) => { setRows(r.data.items); setTotal(r.data.total); });
  }, [page]);
  return (
    <>
      <h1>{t('events')}</h1>
      <div className="card">
        <table>
          <thead><tr><th>{t('title')}</th><th>{t('method')}</th><th>{t('status')}</th><th>{t('deadline')}</th><th>{t('bids_received')}</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><Link to={`/buyer/events/${r.id}`}>{r.title}</Link></td>
                <td><span className="badge INVITED" title={t(`tip_${(r.type ?? '').toLowerCase()}`)}>{TYPE_CHIP[r.type] ?? r.type}</span></td>
                <td><Badge status={r.status} /></td>
                <td className="hint">{fmtDateTime(r.close_at)}</td>
                <td>{r.bid_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager total={total} page={page} pageSize={PAGE_SIZE} onPage={setPage} />
      </div>
    </>
  );
}
