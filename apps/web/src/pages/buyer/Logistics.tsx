import { api } from '../../api/client';
import { useAuth } from '../../auth/auth';
import { useI18n } from '../../i18n';
import { Badge } from '../../components/Badge';
import { ListState, useLoad } from '../../components/ListState';

// Shipment tracking board — the buyer watches deliveries in flight (read-only;
// the supplier drives the timeline from "Заказы в работе").
export default function Logistics() {
  const { t } = useI18n();
  const { session } = useAuth();
  const isBuyer = session?.org.kind !== 'SUPPLIER';
  const board = useLoad(() => api.get('/logistics').then((r) => r.data), [], [] as any[]);
  const rows = board.data;

  return (
    <>
      <h1>🚚 {t('logistics')}</h1>
      <div className="card">
        <table>
          <thead><tr>
            <th>PO</th><th>{isBuyer ? t('supplier_org') : t('buyer_org')}</th>
            <th>{t('carrier')}</th><th>{t('tracking_no')}</th><th>{t('status')}</th>
            <th>{t('po_status_col')}</th><th>{t('eta')}</th>
          </tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td>{s.po_no}</td>
                <td>{isBuyer ? s.supplier_name : s.buyer_name}</td>
                <td>{s.carrier ?? '—'}</td>
                <td>{s.tracking_no ?? '—'}</td>
                <td><Badge status={s.status} /></td>
                {/* The delivery status is the supplier's claim; the order's own status is
                    what the buyer acts on. Walking the order forward is best-effort, so
                    these two can legitimately differ — but only if you can see both. */}
                <td><Badge status={s.po_status} /></td>
                <td>{s.eta ? new Date(s.eta).toLocaleDateString() : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ListState of={board} empty={!rows.length} />
      </div>
    </>
  );
}
