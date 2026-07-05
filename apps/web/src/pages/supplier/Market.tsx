import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';

export default function Market() {
  const { t } = useI18n();
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { api.get('/events').then((r) => setRows(r.data)); }, []);
  return (
    <>
      <h1>{t('market')}</h1>
      <div className="card">
        <table>
          <thead><tr><th>{t('title')}</th><th>{t('buyer_org')}</th><th>{t('status')}</th><th>{t('deadline')}</th><th>{t('my_bid')}</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><Link to={`/supplier/events/${r.id}`}>{r.title}</Link></td>
                <td>{r.buyer_name}</td>
                <td><span className={`badge ${r.status}`}>{r.status}</span></td>
                <td>{r.close_at ? new Date(r.close_at).toLocaleString() : '—'}</td>
                <td>{r.my_bid_state ? <span className={`badge ${r.my_bid_state}`}>{r.my_bid_state}</span> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
