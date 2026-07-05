import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';

export default function Events() {
  const { t } = useI18n();
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { api.get('/events').then((r) => setRows(r.data)); }, []);
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
                <td><span className={`badge ${r.status}`}>{r.status}</span></td>
                <td>{r.close_at ? new Date(r.close_at).toLocaleString() : '—'}</td>
                <td>{r.bid_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
