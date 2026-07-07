import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate, fmtDateTime, fmtMoney } from '../../api/client';
import { useI18n } from '../../i18n';
import { notifText, taskLabel } from '../../components/humanize';

const TASK_LINK: Record<string, (id: string) => string> = {
  APPROVE_REQUEST: () => '/buyer/requests',
  OPEN_BIDS: (id) => `/buyer/events/${id}`,
  AWARD: (id) => `/buyer/events/${id}`,
  ACCEPT_DELIVERY: () => '/buyer/contracts',
};

export default function Dashboard() {
  const { t } = useI18n();
  const [kpi, setKpi] = useState<any>(null);
  const [notes, setNotes] = useState<any[]>([]);

  const load = () => {
    api.get('/dashboard/buyer').then((r) => setKpi(r.data));
    api.get('/notifications').then((r) => setNotes(r.data.slice(0, 8)));
  };
  useEffect(load, []);

  if (!kpi) return <div className="center">…</div>;

  const cards = [
    { label: t('spend'), value: fmtMoney(kpi.awardedSpend) },
    { label: t('savings'), value: fmtMoney(kpi.savings) },
    { label: t('active_events'), value: kpi.activeEvents },
    { label: t('pending'), value: kpi.pendingApprovals },
    { label: t('orders'), value: kpi.openPos },
  ];

  return (
    <>
      <h1>{t('dashboard')}</h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
        {cards.map((c) => (
          <div className="card" key={c.label} style={{ marginBottom: 0 }}>
            <div style={{ color: 'var(--muted)', fontSize: 12 }}>{c.label}</div>
            <div style={{ fontSize: 22, fontWeight: 800, marginTop: 6 }}>{c.value}</div>
          </div>
        ))}
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
                <td>
                  {!n.read_at && (
                    <button className="btn small ghost" onClick={async () => { await api.post(`/notifications/${n.id}/read`); load(); }}>
                      ✓
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
