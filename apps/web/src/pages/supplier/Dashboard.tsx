import { Link } from 'react-router-dom';
import { api, fmtDate, fmtDateTime, fmtMoney } from '../../api/client';
import { useI18n } from '../../i18n';
import { Badge } from '../../components/Badge';
import { notifText, taskLabel } from '../../components/humanize';
import { ListState, useLoad } from '../../components/ListState';

const TASK_LINK: Record<string, (id: string) => string> = {
  BID: (id) => `/supplier/events/${id}`,
  ADVANCE_DELIVERY: () => '/supplier/orders',
  INVOICE: () => '/supplier/orders',
};

export default function SupplierDashboard() {
  const { t } = useI18n();
  const kpi = useLoad<any>(() => api.get('/dashboard/supplier').then((r) => r.data), [], null);
  const notes = useLoad(() => api.get('/notifications').then((r) => r.data.slice(0, 8)), [], [] as any[]);

  // Without the KPI there is no page. A failed load used to leave "…" on screen for ever;
  // now it says what happened and offers the retry.
  if (!kpi.data) return <><h1>{t('dashboard')}</h1><div className="card"><ListState of={kpi} /></div></>;
  const cards = [
    { label: t('market'), value: kpi.data.openTenders },
    { label: t('my_bids'), value: kpi.data.myActiveBids },
    { label: t('contracts'), value: kpi.data.contractsWon },
    { label: t('my_orders'), value: kpi.data.ordersInProgress },
    { label: t('invoices'), value: kpi.data.invoicesPending },
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
            <Badge status={kpi.data.verificationStatus} />
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>{t('tasks')}</h3>
        {kpi.data.tasks.length === 0 && <div className="hint">—</div>}
        <table>
          <tbody>
            {kpi.data.tasks.map((task: any, i: number) => (
              <tr key={i}>
                <td><span className="badge is-info">{taskLabel(t, task.kind)}</span></td>
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
        <ListState of={notes} empty={!notes.data.length} />
        <table>
          <tbody>
            {notes.data.map((n) => (
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
