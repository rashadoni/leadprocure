import { useEffect, useRef, useState } from 'react';
import { api, fmtDate, fmtMoney } from '../api/client';
import { useAuth } from '../auth/auth';
import { useI18n } from '../i18n';
import { Badge } from '../components/Badge';
import { isDenied } from '../components/ListState';

export default function Invoices() {
  const { t } = useI18n();
  const { session } = useAuth();
  const isBuyer = session?.org.kind !== 'SUPPLIER';
  const [rows, setRows] = useState<any[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState(false);
  const [open, setOpen] = useState<Record<string, any>>({});
  const detailSequence = useRef(0);
  const detailIntent = useRef<Record<string, { request: number; open: boolean }>>({});
  const mutationVersion = useRef<Record<string, number>>({});
  // Rows a confirmed mutation or detail read already knows better than any list read that
  // started earlier. Keeping them per row — instead of discarding the whole list response —
  // is what lets a refresh still refresh every OTHER row, and still report its own failure.
  const fresherRow = useRef<Record<string, { version: number; data: any }>>({});
  const listRequest = useRef(0);

  const load = async () => {
    const request = ++listRequest.current;
    const readAt = detailSequence.current;
    setListLoading(true);
    setListError(false);
    try {
      const { data } = await api.get('/invoices');
      if (request === listRequest.current) setRows(data.map((row: any) => {
        const fresher = fresherRow.current[row.id];
        return fresher && fresher.version > readAt ? { ...row, ...fresher.data } : row;
      }));
    } catch (e) {
      // p2p.invoicing is a licence: an org without it is denied, and that is an empty
      // list, not a failed one. This page's loader predates useLoad, so it says so here.
      if (request === listRequest.current && !isDenied(e)) setListError(true);
    } finally {
      if (request === listRequest.current) setListLoading(false);
    }
  };
  useEffect(() => {
    load();
    return () => {
      detailIntent.current = {}; mutationVersion.current = {}; fresherRow.current = {};
      listRequest.current++;
    };
  }, []);

  const act = async (id: string, fn: () => Promise<{ data: any } | undefined>) => {
    try {
      const result = await fn();
      if (!result) return; // cancelled override prompt — no state transition
      // Any GET spanning this confirmation has ambiguous snapshot ordering. Mark the row
      // as freshly known and let a pending detail read refresh itself; an older list read
      // keeps running, so it still refreshes the rest and still reports its own failure.
      mutationVersion.current[id] = ++detailSequence.current;
      fresherRow.current[id] = { version: mutationVersion.current[id], data: result.data };
      setRows((current) => current.map((row) => row.id === id ? { ...row, ...result.data } : row));
      // The mutation returns the canonical invoice row. Keep loaded item details,
      // but update status/match/totals only after the server confirms success.
      // A card closed while the request was running must stay closed.
      setOpen((current) => current[id]
        ? { ...current, [id]: { ...current[id], ...result.data } }
        : current);
      await load();
    } catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };
  const expand = async (id: string) => {
    const wantsOpen = !(detailIntent.current[id]?.open ?? !!open[id]);
    const request = ++detailSequence.current;
    detailIntent.current[id] = { request, open: wantsOpen };
    if (!wantsOpen) { setOpen((o) => ({ ...o, [id]: null })); return; }
    const isCurrent = () => detailIntent.current[id]?.request === request && detailIntent.current[id]?.open;
    try {
      while (isCurrent()) {
        const versionAtStart = mutationVersion.current[id];
        const { data } = await api.get(`/invoices/${id}`);
        if (!isCurrent()) return;
        // The response could be older OR newer than our last mutation. Do not
        // overlay a local row: read again after confirmation and trust the server.
        // Another read is needed only when a successful local action overlapped it.
        if (mutationVersion.current[id] !== versionAtStart) continue;
        fresherRow.current[id] = { version: ++detailSequence.current, data };
        setRows((current) => current.map((row) => row.id === id ? { ...row, ...data } : row));
        setOpen((o) => ({ ...o, [id]: data }));
        return;
      }
    } catch (e: any) {
      if (!isCurrent()) return;
      detailIntent.current[id] = { request, open: false };
      alert(e.response?.data?.message?.toString() ?? t('invoice_details_error'));
    }
  };

  // A DISPUTED invoice (failed 3-way match) can only be approved with a documented override.
  const approveInvoice = (i: any) => act(i.id, async () => {
    let reason: string | undefined;
    if (i.status === 'DISPUTED') {
      reason = window.prompt(t('override_reason_prompt')) ?? undefined;
      if (!reason) return;
    }
    return api.post(`/invoices/${i.id}/approve`, reason ? { reason } : {});
  });

  return (
    <>
      <h1>🧾 {t('invoices')}</h1>
      <div className="card">
        {listLoading && <div role="status" className="hint">{t('invoice_list_loading')}</div>}
        {listError && <div role="alert">
          <span>{t('invoice_list_error')}</span>{' '}
          <button className="btn small ghost" onClick={() => load()}>{t('invoice_list_retry')}</button>
        </div>}
        <table>
          <thead><tr><th>#</th><th>PO</th><th>{isBuyer ? t('supplier_org') : t('buyer_org')}</th><th>{t('date')}</th><th>{t('due_date')}</th><th>{t('total')}</th><th>{t('status')}</th><th>{t('actions')}</th></tr></thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.id}>
                <td><a href="#" onClick={(e) => { e.preventDefault(); expand(i.id); }}>{i.invoice_no}</a></td>
                <td>{i.po_no}</td>
                <td>{isBuyer ? i.supplier_name : i.buyer_name}</td>
                <td className="hint">{fmtDate(i.issued_at ?? i.created_at)}</td>
                <td className="hint">{fmtDate(i.due_date)}</td>
                <td>{fmtMoney(i.gross_minor, i.currency)}</td>
                <td><Badge status={i.status} /></td>
                <td>
                  {isBuyer && ['MATCHED', 'DISPUTED', 'SUBMITTED'].includes(i.status) && (
                    <>
                      <button className="btn small" data-tip={t('tip_inv_approve')} onClick={() => approveInvoice(i)}>{t('approve')}</button>{' '}
                      <button className="btn small ghost" data-tip={t('tip_inv_reject')} onClick={() => act(i.id, () => api.post(`/invoices/${i.id}/reject`))}>{t('reject')}</button>
                    </>
                  )}
                  {isBuyer && i.status === 'APPROVED' && (
                    <button className="btn small" data-tip={t('tip_pay')} onClick={() => act(i.id, () => api.post(`/invoices/${i.id}/pay`))}>💳 {t('pay')}</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!listLoading && !listError && rows.length === 0 && <div className="hint">—{!isBuyer ? ` ${t('hint_invoices_empty')}` : ''}</div>}
      </div>

      {Object.entries(open).filter(([, v]) => v).map(([id, inv]) => (
        <div className="card" key={id}>
          <h3>{inv.invoice_no} · {fmtMoney(inv.gross_minor, inv.currency)} <Badge status={inv.status} /></h3>
          <div className="hint">{t('inv_net')} {fmtMoney(inv.net_minor, inv.currency)} + {t('inv_vat')} {fmtMoney(inv.vat_minor, inv.currency)}</div>
          <h3 style={{ marginTop: 10 }}>{t('inv_match')} {inv.match?.ok ? '✅' : '⚠️'}</h3>
          <table>
            <thead><tr><th>{t('inv_price')}</th><th>{t('inv_po_price')}</th><th>{t('inv_qty')}</th><th>{t('inv_received')}</th><th>{t('inv_ok')}</th></tr></thead>
            <tbody>
              {(inv.match?.lines ?? []).map((l: any, idx: number) => (
                <tr key={idx}>
                  <td>{fmtMoney(l.invoice_price, inv.currency)}</td>
                  <td>{fmtMoney(l.po_price, inv.currency)}</td>
                  <td>{l.invoice_qty}</td>
                  <td>{l.received}</td>
                  <td>{l.price_ok && l.qty_ok ? '✅' : '⚠️'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  );
}
