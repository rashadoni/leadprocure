import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDateTime } from '../../api/client';
import { useI18n } from '../../i18n';
import Pager from '../../components/Pager';
import { Badge } from '../../components/Badge';
import { ProcedureChip } from '../../components/ProcedureChip';
import { ListState, useLoad } from '../../components/ListState';

const PAGE_SIZE = 20;

export default function Market() {
  const { t } = useI18n();
  const [page, setPage] = useState(1);
  // A supplier who cannot see a tender does not bid on it, so a failed load must say so
  // rather than render an empty market.
  const market = useLoad(
    () => api.get('/events', { params: { page, pageSize: PAGE_SIZE } }).then((r) => r.data),
    [page],
    { items: [] as any[], total: 0 },
  );
  // A failed page change must not leave the PREVIOUS page's rows sitting under the new
  // page number: on failure the alert stands alone.
  const rows: any[] = market.failed ? [] : (market.data.items ?? []);
  return (
    <>
      <h1>{t('market')}</h1>
      <div className="card">
        <ListState of={market} empty={!rows.length} />
        <table>
          {/* The buyer's own tender list has carried this column since PR #71, and the
              market — the one screen where the procedure decides whether to bid at all —
              had none: a closed tender, a live auction and a request for information
              looked identical until the row was opened. The response already carries
              type/format/visibility, so this is the same chip over the same data. */}
          <thead><tr><th>{t('title')}</th><th>{t('method')}</th><th>{t('buyer_org')}</th><th>{t('status')}</th><th>{t('deadline')}</th><th>{t('my_bid')}</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><Link to={`/supplier/events/${r.id}`}>{r.title}</Link></td>
                <td><ProcedureChip type={r.type} format={r.format} visibility={r.visibility} /></td>
                <td>{r.buyer_name}</td>
                <td><Badge status={r.status} /></td>
                <td className="nowrap">{fmtDateTime(r.close_at)}</td>
                <td><Badge status={r.my_bid_state} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager total={market.data.total ?? 0} page={page} pageSize={PAGE_SIZE} onPage={setPage} />
      </div>
    </>
  );
}
