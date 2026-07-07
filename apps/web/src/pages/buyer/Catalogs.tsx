import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtMoney } from '../../api/client';
import { useAuth } from '../../auth/auth';
import { useI18n } from '../../i18n';
import { Badge } from '../../components/Badge';

export default function Catalogs() {
  const { t } = useI18n();
  const { session } = useAuth();
  const nav = useNavigate();
  const isBuyer = session?.org.kind !== 'SUPPLIER';
  const [rows, setRows] = useState<any[]>([]);
  const [open, setOpen] = useState<Record<string, any>>({});
  const [qty, setQty] = useState<Record<string, string>>({});

  const load = () => api.get('/catalogs').then((r) => setRows(r.data));
  useEffect(() => { load(); }, []);

  const run = async (fn: () => Promise<unknown>) => {
    try { await fn(); load(); } catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };
  const expand = async (id: string) => {
    if (open[id]) { setOpen((o) => ({ ...o, [id]: null })); return; }
    const { data } = await api.get(`/catalogs/${id}`);
    setOpen((o) => ({ ...o, [id]: data }));
  };
  const order = async (catalogId: string, items: any[]) => {
    const lines = items.filter((i) => Number(qty[i.id]) > 0).map((i) => ({ catalogItemId: i.id, qty: Number(qty[i.id]) }));
    if (!lines.length) { alert('Enter quantities'); return; }
    try {
      await api.post(`/catalogs/${catalogId}/order`, { items: lines });
      setQty({});
      nav('/buyer/contracts');
    } catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  return (
    <>
      <h1>📖 {t('catalogs')}</h1>
      <div className="card">
        <table>
          <thead><tr><th>{t('title')}</th><th>{isBuyer ? t('supplier_org') : t('buyer_org')}</th><th>{t('status')}</th><th>Items</th><th>{t('actions')}</th></tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td><a href="#" onClick={(e) => { e.preventDefault(); expand(c.id); }}>{c.title}</a></td>
                <td>{isBuyer ? c.supplier_name : c.buyer_name}</td>
                <td><Badge status={c.status} /></td>
                <td>{c.item_count}</td>
                <td>
                  {isBuyer && c.status === 'DRAFT' && (
                    <button className="btn small" data-tip={t('tip_catalog_activate')} onClick={() => run(() => api.post(`/catalogs/${c.id}/activate`))}>{t('activate')}</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="hint">— {isBuyer ? 'создайте каталог из контракта (кнопка «Каталог» на контракте)' : ''}</div>}
      </div>

      {Object.entries(open).filter(([, v]) => v).map(([id, cat]) => (
        <div className="card" key={id}>
          <h3>{cat.title} <Badge status={cat.status} /></h3>
          <table>
            <thead><tr><th>{t('name')}</th><th>MOQ</th><th>{t('unit_price')}</th>{isBuyer && cat.status === 'ACTIVE' && <th>{t('qty')}</th>}</tr></thead>
            <tbody>
              {cat.items.map((i: any) => (
                <tr key={i.id}>
                  <td>{i.name}</td>
                  <td>{Number(i.moq)}</td>
                  <td>{fmtMoney(i.unit_price_minor, cat.currency)}</td>
                  {isBuyer && cat.status === 'ACTIVE' && (
                    <td><input style={{ width: 80 }} type="number" min={0} value={qty[i.id] ?? ''} onChange={(e) => setQty({ ...qty, [i.id]: e.target.value })} /></td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {isBuyer && cat.status === 'ACTIVE' && (
            <button className="btn" style={{ marginTop: 10 }} data-tip={t('tip_quick_order')} onClick={() => order(cat.id, cat.items)}>📦 {t('quick_order')}</button>
          )}
        </div>
      ))}
    </>
  );
}
