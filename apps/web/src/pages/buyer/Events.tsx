import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import Pager from '../../components/Pager';
import { Badge } from '../../components/Badge';

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
          <thead><tr><th>{t('title')}</th><th>{t('status')}</th><th>{t('deadline')}</th><th>Bids</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><Link to={`/buyer/events/${r.id}`}>{r.title}</Link></td>
                <td><Badge status={r.status} /></td>
                <td>{r.close_at ? new Date(r.close_at).toLocaleString() : '—'}</td>
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
