import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useAuth } from '../../auth/auth';
import { useI18n } from '../../i18n';
import { Badge } from '../../components/Badge';

// Shipment tracking board — the buyer watches deliveries in flight (read-only;
// the supplier drives the timeline from "Заказы в работе").
export default function Logistics() {
  const { t } = useI18n();
  const { session } = useAuth();
  const isBuyer = session?.org.kind !== 'SUPPLIER';
  const [rows, setRows] = useState<any[]>([]);

  useEffect(() => { api.get('/logistics').then((r) => setRows(r.data)); }, []);

  return (
    <>
      <h1>🚚 {t('logistics')}</h1>
      <div className="card">
        <table>
          <thead><tr>
            <th>PO</th><th>{isBuyer ? t('supplier_org') : t('buyer_org')}</th>
            <th>Carrier</th><th>Tracking №</th><th>{t('status')}</th><th>ETA</th>
          </tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td>{s.po_no}</td>
                <td>{isBuyer ? s.supplier_name : s.buyer_name}</td>
                <td>{s.carrier ?? '—'}</td>
                <td>{s.tracking_no ?? '—'}</td>
                <td><Badge status={s.status} /></td>
                <td>{s.eta ? new Date(s.eta).toLocaleDateString() : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="hint">—</div>}
      </div>
    </>
  );
}
