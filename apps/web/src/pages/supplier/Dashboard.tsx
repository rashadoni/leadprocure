import { Link } from 'react-router-dom';
import { api, fmtDate, fmtMoney } from '../../api/client';
import { useI18n } from '../../i18n';
import { Badge, statusGroup } from '../../components/Badge';
import { taskLabel } from '../../components/humanize';
import { NotificationList } from '../../components/NotificationList';
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
  // Each tip is written from the query behind it (dashboard.module.ts, `supplier()`), the
  // way the buyer's panel already does it. The buyer got hints under every figure and the
  // supplier got none, so the side with the least context in the product had the least
  // explanation: "Контракты: 3" counts drafts and finished ones too, and "Открытые
  // тендеры" counts the closed ones you were invited to. The bare numbers said neither.
  const cards = [
    { label: t('market'), value: kpi.data.openTenders, tip: t('tip_sup_market') },
    { label: t('my_bids'), value: kpi.data.myActiveBids, tip: t('tip_sup_bids') },
    { label: t('contracts'), value: kpi.data.contractsWon, tip: t('tip_sup_contracts') },
    { label: t('my_orders'), value: kpi.data.ordersInProgress, tip: t('tip_sup_orders') },
    { label: t('invoices'), value: kpi.data.invoicesPending, tip: t('tip_sup_invoices') },
  ];
  // Verification is a standing condition, not a figure. Sitting as the sixth tile in a row
  // of numbers it broke the grid's rhythm and stood taller than the rest, and it answers a
  // question that comes BEFORE any count: can I be invited at all. So it moved above them,
  // as one line that says what the status means for the reader.
  const ver: string | null = kpi.data.verificationStatus ?? null;
  const verOk = ver === 'APPROVED';
  const verBorder = verOk ? undefined
    : statusGroup(ver) === 'is-bad' ? 'var(--bad)' : 'var(--warn)';

  return (
    <>
      <h1>{t('dashboard')}</h1>
      <div className="card" data-testid="sup-verification"
        style={{ marginBottom: 12, borderColor: verBorder,
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <b>{t('verification')}:</b>
        {/* A missing case is not «—»: nothing has been submitted yet, and that is the one
            state the supplier can act on. */}
        {ver ? <Badge status={ver} /> : <span className="badge is-neutral">{t('ver_not_started')}</span>}
        <span className="hint">{t(verOk ? 'ver_hint_ok' : 'ver_hint_todo')}</span>
        <Link className="btn small ghost" to="/supplier/verification"
          style={{ marginLeft: 'auto' }}>{t('open_item')} →</Link>
      </div>

      <div data-testid="sup-kpi" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
        {cards.map((c) => (
          <div className="card" key={c.label} style={{ marginBottom: 0 }} data-tip={c.tip}>
            <div style={{ color: 'var(--muted)', fontSize: 12 }}>{c.label}</div>
            <div style={{ fontSize: 22, fontWeight: 800, marginTop: 6 }}>{c.value}</div>
          </div>
        ))}
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
                {/* The badge on the left names the action and the arrow on the right was
                    the only thing clickable — the buyer's panel lost that bare arrow in
                    PR #68, the supplier's kept it. */}
                <td className="nowrap"><Link className="btn small ghost" to={TASK_LINK[task.kind]?.(task.id) ?? '#'}>{t('open_item')} →</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <NotificationList notes={notes} />
    </>
  );
}
