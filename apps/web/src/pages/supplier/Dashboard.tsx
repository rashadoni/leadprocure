import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate, fmtDateTime, fmtMoney } from '../../api/client';
import { useI18n } from '../../i18n';
import { Badge } from '../../components/Badge';
import { notifText, taskLabel } from '../../components/humanize';

const TASK_LINK: Record<string, (id: string) => string> = {
  BID: (id) => `/supplier/events/${id}`,
  ADVANCE_DELIVERY: () => '/supplier/orders',
  INVOICE: () => '/supplier/orders',
};

export default function SupplierDashboard() {
  const { t } = useI18n();
  const [kpi, setKpi] = useState<any>(null);
  const [notes, setNotes] = useState<any[]>([]);

  useEffect(() => {
    api.get('/dashboard/supplier').then((r) => setKpi(r.data));
    api.get('/notifications').then((r) => setNotes(r.data.slice(0, 8)));
  }, []);

  if (!kpi) return <div className="center">…</div>;
  const cards = [
    { label: t('market'), value: kpi.openTenders },
    { label: t('my_bids'), value: kpi.myActiveBids },
    { label: t('contracts'), value: kpi.contractsWon },
    { label: t('my_orders'), value: kpi.ordersInProgress },
    { label: t('invoices'), value: kpi.invoicesPending },
  ];

  return (
    <>
      <h1>{t('dashboard')}</h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
        {cards.map((c) => (
          <div className="card" key={c.label} style={{ marginBottom: 0 }}>
            <div style={{ color: 'var(--muted)', fontSize: 12 }}>{c.label}</div>
            <div style={{ fontSize: 22, fontWeight: 800, marginTop: 6 }}>{c.value}</div>
          </div>
        ))}
        <div className="card" style={{ marginBottom: 0 }}>
          <div style={{ color: 'var(--muted)', fontSize: 12 }}>{t('verification')}</div>
          <div style={{ marginTop: 10 }}>
            <Badge status={kpi.verificationStatus}
              cls={kpi.verificationStatus === 'APPROVED' ? 'APPROVED' : kpi.verificationStatus === 'REJECTED' ? 'REJECTED' : 'INVITED'} />
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>{t('tasks')}</h3>
        {kpi.tasks.length === 0 && <div className="hint">—</div>}
        <table>
          <tbody>
            {kpi.tasks.map((task: any, i: number) => (
              <tr key={i}>
                <td><span className="badge INVITED">{taskLabel(t, task.kind)}</span></td>
                <td>
                  {task.ref && task.ref !== task.title && <b>{task.ref} · </b>}{task.title}
                  {task.amount_minor != null && <> · {fmtMoney(task.amount_minor, task.currency ?? 'AZN')}</>}
                  {task.at && <span className="hint"> · {fmtDate(task.at)}</span>}
                </td>
                <td><Link to={TASK_LINK[task.kind]?.(task.id) ?? '#'}>→</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>{t('notifications')}</h3>
        {notes.length === 0 && <div className="hint">—</div>}
        <table>
          <tbody>
            {notes.map((n) => (
              <tr key={n.id} style={{ opacity: n.read_at ? 0.5 : 1 }}>
                <td>{notifText(t, n)}</td>
                <td className="hint">{fmtDateTime(n.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
