import { useEffect, useState } from 'react';
import { api, fmtMoney } from '../api/client';
import { useAuth } from '../auth/auth';
import { useI18n } from '../i18n';
import { Badge } from '../components/Badge';

export default function Invoices() {
  const { t } = useI18n();
  const { session } = useAuth();
  const isBuyer = session?.org.kind !== 'SUPPLIER';
  const [rows, setRows] = useState<any[]>([]);
  const [open, setOpen] = useState<Record<string, any>>({});

  const load = () => api.get('/invoices').then((r) => setRows(r.data));
  useEffect(() => { load(); }, []);

  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); load(); } catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };
  const expand = async (id: string) => {
    if (open[id]) { setOpen((o) => ({ ...o, [id]: null })); return; }
    const { data } = await api.get(`/invoices/${id}`);
    setOpen((o) => ({ ...o, [id]: data }));
  };

  // A DISPUTED invoice (failed 3-way match) can only be approved with a documented override.
  const approveInvoice = (i: any) => act(async () => {
    let reason: string | undefined;
    if (i.status === 'DISPUTED') {
      reason = window.prompt(t('override_reason_prompt')) ?? undefined;
      if (!reason) return;
    }
    await api.post(`/invoices/${i.id}/approve`, reason ? { reason } : {});
  });

  const badge = (s: string) =>
    s === 'PAID' || s === 'MATCHED' || s === 'APPROVED' ? s : s === 'DISPUTED' || s === 'REJECTED' ? 'REJECTED' : 'INVITED';

  return (
    <>
      <h1>🧾 {t('invoices')}</h1>
      <div className="card">
        <table>
          <thead><tr><th>#</th><th>PO</th><th>{isBuyer ? t('supplier_org') : t('buyer_org')}</th><th>{t('total')}</th><th>{t('status')}</th><th>{t('actions')}</th></tr></thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.id}>
                <td><a href="#" onClick={(e) => { e.preventDefault(); expand(i.id); }}>{i.invoice_no}</a></td>
                <td>{i.po_no}</td>
                <td>{isBuyer ? i.supplier_name : i.buyer_name}</td>
                <td>{fmtMoney(i.gross_minor, i.currency)}</td>
                <td><Badge status={i.status} cls={badge(i.status)} /></td>
                <td>
                  {isBuyer && ['MATCHED', 'DISPUTED', 'SUBMITTED'].includes(i.status) && (
                    <>
                      <button className="btn small" onClick={() => approveInvoice(i)}>{t('approve')}</button>{' '}
                      <button className="btn small ghost" onClick={() => act(() => api.post(`/invoices/${i.id}/reject`))}>{t('reject')}</button>
                    </>
                  )}
                  {isBuyer && i.status === 'APPROVED' && (
                    <button className="btn small" onClick={() => act(() => api.post(`/invoices/${i.id}/pay`))}>💳 {t('pay')}</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="hint">—{!isBuyer ? ' выставите счёт кнопкой на принятом заказе' : ''}</div>}
      </div>

      {Object.entries(open).filter(([, v]) => v).map(([id, inv]) => (
        <div className="card" key={id}>
          <h3>{inv.invoice_no} · {fmtMoney(inv.gross_minor, inv.currency)} <Badge status={inv.status} cls={badge(inv.status)} /></h3>
          <div className="hint">net {fmtMoney(inv.net_minor, inv.currency)} + ƏDV {fmtMoney(inv.vat_minor, inv.currency)}</div>
          <h3 style={{ marginTop: 10 }}>3-way match {inv.match?.ok ? '✅' : '⚠️'}</h3>
          <table>
            <thead><tr><th>Invoice price</th><th>PO price</th><th>Invoice qty</th><th>Received</th><th>OK</th></tr></thead>
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
