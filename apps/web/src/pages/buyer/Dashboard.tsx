import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate, fmtDateTime, fmtMoney } from '../../api/client';
import { useI18n } from '../../i18n';
import { notifText, taskLabel } from '../../components/humanize';
import { ListState, useLoad } from '../../components/ListState';

const TASK_LINK: Record<string, (id: string) => string> = {
  APPROVE_REQUEST: () => '/buyer/requests',
  OPEN_BIDS: (id) => `/buyer/events/${id}`,
  AWARD: (id) => `/buyer/events/${id}`,
  ACCEPT_DELIVERY: () => '/buyer/contracts',
};

export default function Dashboard() {
  const { t } = useI18n();
  const kpi = useLoad<any>(() => api.get('/dashboard/buyer').then((r) => r.data), [], null);
  const notes = useLoad(() => api.get('/notifications').then((r) => r.data.slice(0, 8)), [], [] as any[]);
  const [overBudgets, setOverBudgets] = useState<any[]>([]);

  // a 9× overspend must scream on the front page, not hide in the budgets tab. This one
  // stays quiet when it fails: an org without the budgets feature has no overspend to show.
  const loadOverBudgets = () => {
    api.get('/budgets')
      .then((r) => setOverBudgets(r.data.filter((b: any) => b.committedMinor > b.amountMinor)))
      .catch(() => {});
  };
  useEffect(loadOverBudgets, []);

  const readNote = async (id: string) => {
    try {
      await api.post(`/notifications/${id}/read`);
      // the whole front page moves with a notification, not just the list it came from
      await Promise.all([notes.reload(), kpi.reload()]);
      loadOverBudgets();
    } catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  // Without the KPI there is no page. A failed load used to leave "…" on screen for ever;
  // now it says what happened and offers the retry.
  if (!kpi.data) return <><h1>{t('dashboard')}</h1><div className="card"><ListState of={kpi} /></div></>;

  const cards = [
    { label: t('spend'), value: fmtMoney(kpi.data.awardedSpend) },
    { label: t('savings'), value: fmtMoney(kpi.data.savings) },
    { label: t('active_events'), value: kpi.data.activeEvents },
    { label: t('pending'), value: kpi.data.pendingApprovals },
    { label: t('orders'), value: kpi.data.openPos },
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

      {overBudgets.length > 0 && (
        <div className="card" style={{ borderColor: 'var(--bad)', marginTop: 16 }}>
          <b style={{ color: 'var(--bad)' }}>⚠ {t('budget_over')}</b>
          {overBudgets.map((b: any) => (
            <div key={b.id} className="hint" style={{ marginTop: 4 }}>
              {/* which department blew it matters more than the budget's name */}
              {b.departmentCode ? `${b.departmentCode} · ` : ''}{b.name} ({b.periodLabel}):{' '}
              {fmtMoney(b.committedMinor, b.currency)} / {fmtMoney(b.amountMinor, b.currency)} · {b.utilizationPct}%
            </div>
          ))}
          <div style={{ marginTop: 6 }}><Link to="/buyer/budgets">→ {t('budgets')}</Link></div>
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <h3>{t('tasks')}</h3>
        {kpi.data.tasks.length === 0 && <div className="hint">—</div>}
        <table>
          <tbody>
            {kpi.data.tasks.map((task: any, i: number) => (
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
        <ListState of={notes} empty={!notes.data.length} />
        <table>
          <tbody>
            {notes.data.map((n) => (
              <tr key={n.id} style={{ opacity: n.read_at ? 0.5 : 1 }}>
                <td>{notifText(t, n)}</td>
                <td className="hint">{fmtDateTime(n.created_at)}</td>
                <td>
                  {!n.read_at && (
                    <button className="btn small ghost" onClick={() => readNote(n.id)}>✓</button>
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
