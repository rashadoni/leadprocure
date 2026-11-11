import { Fragment, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtAmount, fmtDate, fmtMoney, tableCurrency } from '../../api/client';
import { Cur } from '../../components/Cur';
import { useAuth } from '../../auth/auth';
import { useI18n } from '../../i18n';
import { useDialogs } from '../../components/Dialogs';
import Pager from '../../components/Pager';
import { Badge } from '../../components/Badge';
import { statusLabel } from '../../components/humanize';
import { isDenied, ListState, useLoad } from '../../components/ListState';
import { Actions } from '../../components/Actions';
import { RowMenu } from '../../components/RowMenu';
import { Suggest } from '../../components/Suggest';
import { FilterChip, useUrlFilter } from '../../components/StatCard';
import { RequestWizard } from './RequestWizard';

const PAGE_SIZE = 20;


/** «Отменил» — не то же, что «причина не нужна»: склеив их в undefined, мы объявили бы
 *  тендер после отказа объяснять. */
const CANCELLED = Symbol('cancelled');

export default function Requests() {
  const { t } = useI18n();
  const { notifyError, notify, ask } = useDialogs();
  const { session } = useAuth();
  const nav = useNavigate();
  // The form used to be the first thing on the screen, so arriving at «Заявки» showed a
  // blank form and pushed the list of requests — the reason to come here — below the fold.
  // It opens on a worded button now. It does NOT close after a successful create: the
  // owner weighed the extra click against entering requests in a batch, and a form that
  // shut itself every time would charge that click per request instead of once.
  const [formOpen, setFormOpen] = useState(false);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [hasPolicies, setHasPolicies] = useState(false);
  const [cats, setCats] = useState<Array<{ code: string; auto_created?: boolean }>>([]);
  // Departments (cost centres) — which budget this spend lands on. Only active ones can
  // be picked for new requests; retired ones stay on their historic requests.
  const [deps, setDeps] = useState<any[]>([]);
  const [depFilter, setDepFilter] = useState('');
  // Отбор из адреса — его ставит карточка «Ждут одобрения» на панели. Уходит в запрос
  // вместе с номером страницы: что значит «ждут одобрения», решает один
  // PENDING_REQUEST_STATUSES на сервере, а отбор по уже показанной странице дал бы
  // «ждут одобрения: 5» над списком из двух строк.
  const [statusFilter, setStatusFilter] = useUrlFilter('status');
  // These two fill the category and department selects, and the department decides whose
  // budget the spend lands on. A fresh org legitimately has neither (and may be denied
  // them), but a dead request must not quietly leave the author with no choice to make.
  // Both carry only @Roles over the four buyer roles — no licence gate — so on a buyer
  // page every failure of theirs is a real one.
  const [refFailed, setRefFailed] = useState(false);
  // The budget projection shown between the two approval clicks keeps its OWN flag: on one
  // shared boolean a successful projection would have cleared a dead /departments (the
  // page then claims it loaded while the control choosing whose budget pays is broken),
  // and Retry would have re-run the reference reads instead of the projection that failed.
  // Every row whose projection failed, not just the latest: with one id, a retry that
  // succeeded on the second row cleared the alert while the first row's figure was still
  // missing — and that row's preview is already cached, so the next click approves it.
  const [impactFailed, setImpactFailed] = useState<string[]>([]);
  // An org without the budgets licence is denied this and the projection is simply absent.
  // Any other failure means the approver confirms without the figure they were promised.
  const loadImpact = (id: string) => api.get(`/budgets/impact/${id}`)
    .then((r) => {
      setImpact((m) => ({ ...m, [id]: r.data ?? null }));
      setImpactFailed((f) => f.filter((x) => x !== id));
    })
    .catch((e: any) => { if (!isDenied(e)) setImpactFailed((f) => (f.includes(id) ? f : [...f, id])); });
  const loadRefs = () => {
    setRefFailed(false);
    const broken = () => setRefFailed(true);
    api.get('/categories').then((r) => setCats(r.data)).catch(broken);
    api.get('/departments').then((r) => setDeps(r.data)).catch(broken);
    // Нужны не сами полосы, а только факт, что они заведены: без них `resolveMethod`
    // ставит OPEN_TENDER на КАЖДУЮ заявку (пробел политики идёт самым состязательным
    // путём, а не молча прямой). Спрашивать обоснование у организации, которая политику
    // не настраивала, значило бы требовать объяснений за умолчание. Сервер проверяет то
    // же самое и остаётся последним словом — это лишь чтобы человек не упёрся в отказ.
    api.get('/requests/method-policies').then((r) => setHasPolicies(r.data.length > 0)).catch(broken);
  };
  useEffect(loadRefs, []);
  const canApprove = ['BUYER_ADMIN', 'BUYER_APPROVER'].includes(session?.org.role ?? '');
  const isFinance = session?.org.role === 'BUYER_FINANCE';
  const isAdmin = session?.org.role === 'BUYER_ADMIN';

  const requests = useLoad(
    () => api.get('/requests', { params: { ...(q ? { q } : {}), ...(depFilter ? { departmentId: depFilter } : {}), ...(statusFilter ? { status: statusFilter } : {}), page, pageSize: PAGE_SIZE } })
      .then((r) => r.data),
    [q, page, depFilter, statusFilter], { items: [] as any[], total: 0 },
  );
  // A failed page change must not leave the PREVIOUS page's rows sitting under the new
  // page number: on failure the alert stands alone.
  const rows: any[] = requests.failed ? [] : (requests.data.items ?? []);
  // One currency for the whole page means the code belongs in the heading, not on every
  // figure; mixed rows bring it back onto each one.
  const cur = tableCurrency(rows);
  const total: number = requests.data.total ?? 0;
  const load = () => requests.reload();

  // Which procedure each row's dropdown is showing, keyed by request id; unset means "the
  // one the method policy resolved".
  //
  // OPEN is the open procedure: the same sealed-price event as RFQ, published to every
  // supplier instead of a named list. It exists because procurement_method bands a request
  // into DIRECT / RFQ / OPEN_TENDER, and OPEN_TENDER had nothing to announce it with — the
  // Method column said OPEN_TENDER while the control beside it offered RFQ, and one click
  // produced an invitation-only tender. For a product sold against UNCITRAL and exporting
  // OCDS (where visibility === 'PUBLIC' is what makes procurementMethod "open") that is the
  // central procedure, so it was reachable on the server and missing from the product.
  const defaultProcedure = (r: any) =>
    (r.method_resolved === 'OPEN_TENDER' ? 'OPEN'
      : ['RFQ', 'RFP', 'RFI'].includes(r.method_resolved) ? r.method_resolved : 'RFQ');
  // The procedure is chosen in a dialog, not by a dropdown parked in the row. The dropdown
  // cost the cell 124px — enough to push the two buttons beside it onto their own lines —
  // and its six entries were unreadable without the grey legend paragraph that used to sit
  // above the table. In the dialog each procedure says what it is, next to the name of the
  // request it will be announced under, and the resolved one is preselected, so the common
  // case is still one click and one Enter.
  const announce = async (r: any) => {
    const pick = await ask({
      title: t('announce_pick'),
      hint: `${r.request_no} · ${r.title} · ${fmtMoney(r.estimated_total_minor, r.currency)}`,
      confirmLabel: t('announce'),
      defaultValue: defaultProcedure(r),
      options: [
        { value: 'RFQ', label: `🔒 RFQ`, hint: `${t('announce_rfq_what')}${defaultProcedure(r) === 'RFQ' ? ` ${t('announce_policy_pick')}` : ''}` },
        { value: 'OPEN', label: `🌐 ${t('open_tender')}`, hint: `${t('announce_open_what')}${defaultProcedure(r) === 'OPEN' ? ` ${t('announce_policy_pick')}` : ''}` },
        { value: 'RFP', label: `📄 RFP`, hint: `${t('announce_rfp_what')}${defaultProcedure(r) === 'RFP' ? ` ${t('announce_policy_pick')}` : ''}` },
        { value: 'RFI', label: `❓ RFI`, hint: `${t('announce_rfi_what')}${defaultProcedure(r) === 'RFI' ? ` ${t('announce_policy_pick')}` : ''}` },
        // Допуск — часть выбора процедуры, а не настройка поверх неё, поэтому оба
        // аукциона стоят в этом же списке.
        { value: 'AUCTION', label: `⚡ ${t('auction_invited')}`, hint: t('announce_auction_what') },
        { value: 'AUCTION_OPEN', label: `⚡ ${t('auction_open')}`, hint: t('announce_auction_open_what') },
      ],
    });
    if (!pick) return;
    if (pick === 'AUCTION' || pick === 'AUCTION_OPEN') {
      return makeAuction(r, pick === 'AUCTION_OPEN' ? 'PUBLIC' : 'INVITED');
    }
    // Only the open procedure publishes to everyone; the other three are addressed to the
    // suppliers the buyer invites, which is what their labels say.
    if (pick === 'OPEN') return makeRfq(r, 'RFQ', 'PUBLIC');
    return makeRfq(r, pick as 'RFQ' | 'RFP' | 'RFI');
  };

  // The chosen supplier used to be read back out of the DOM by element id at click time.
  // Picking the supplier opened a second dropdown inside the row, next to a Confirm button
  // — two more controls in the cell that was already overflowing, and they appeared only
  // for the row being worked on, so the table jumped. Same dialog as the procedure choice.
  const placeDirect = async (r: any) => {
    let list: any[];
    try {
      const res = await api.get('/suppliers');
      list = res.data.filter((x: any) => x.status === 'APPROVED');
    } catch (e: any) { return notifyError(e); }
    if (!list.length) return notify(t('no_approved_suppliers'), 'error');
    const supplierOrgId = await ask({
      title: t('direct_order'),
      hint: `${r.request_no} · ${r.title} · ${fmtMoney(r.estimated_total_minor, r.currency)}`,
      label: t('supplier_org'),
      confirmLabel: t('confirm'),
      // An empty first entry, and `required`, because `ask` preselects options[0] and this
      // dialog places a REAL order: the row it replaced held a disabled «pick a supplier»
      // option for exactly that reason, and without it an Enter straight after opening
      // buys from whoever happens to sort first.
      required: true,
      options: [{ value: '', label: `${t('supplier_org')}…` },
        ...list.map((x: any) => ({ value: x.supplier_org_id, label: x.legal_name }))],
    });
    if (!supplierOrgId) return;
    try {
      await api.post(`/orders/direct/from-request/${r.id}`, { supplierOrgId });
      nav('/buyer/contracts');
    } catch (e: any) { notifyError(e); }
  };

  // Категории: сперва заведённые в «Параметрах», затем те, что уже встречались в заявках.
  // Второе важнее, чем кажется: курируемый список часто пуст, а заявки у компании уже есть,
  // и подсказывать надо по ним — иначе поле «помнит» пустоту.
  const categoryOptions = useMemo(() => {
    const used = [...new Set(rows.map((r: any) => r.category).filter((c: any): c is string => !!c && c !== '*'))];
    return [
      // Подсказка у строки должна быть правдой: «заведена в параметрах» — только про то,
      // что завели рукой; остальное пришло из заявок, в том числе из этой же формы.
      ...cats.map((c) => ({ value: c.code, hint: c.auto_created ? t('suggest_from_list') : t('suggest_curated') })),
      ...used.filter((c) => !cats.some((k) => k.code === c)).map((c) => ({ value: c, hint: t('suggest_from_list') })),
    ];
  }, [cats, rows, t]);


  const act = async (id: string, action: string) => {
    try { await api.post(`/requests/${id}/${action}`); load(); }
    catch (e: any) { notifyError(e); }
  };

  // Cancelling releases the budget commitment, so the reason is required and audited.
  const cancelRequest = async (id: string) => {
    const reason = await ask({
      title: t('cancel_reason_prompt'), label: t('reason'), required: true, minLength: 3,
      hint: t('cancel_request_hint'), confirmLabel: t('cancel_request'), danger: true,
    });
    if (!reason || reason.trim().length < 3) return;
    try { await api.post(`/requests/${id}/cancel`, { reason: reason.trim() }); load(); }
    catch (e: any) { notifyError(e); }
  };

  // Forced look-before-approve: the first click reveals the line items, the second
  // actually approves — nobody waves 36 000 ₼ through without seeing what's in it.
  const [preview, setPreview] = useState<Record<string, any>>({});
  const [impact, setImpact] = useState<Record<string, any>>({});
  const approvalError = (e: any) => {
    switch (e.response?.data?.code) {
      case 'BUDGET_LIMIT_EXCEEDED': return t('bud_approval_blocked');
      case 'BUDGET_OVERRIDE_FORBIDDEN': return t('bud_override_forbidden');
      case 'REQUEST_SELF_APPROVAL_FORBIDDEN': return t('request_self_approval_forbidden');
      default: return e.response?.data?.message?.toString() ?? t('error_generic');
    }
  };
  const approveGuard = async (id: string) => {
    if (!preview[id]) {
      const { data } = await api.get(`/requests/${id}`);
      setPreview((p) => ({ ...p, [id]: data }));
      // what this approval does to the budget — shown before the second click, not after
      loadImpact(id);
      return;
    }
    try {
      await api.post(`/requests/${id}/approve`);
    } catch (e: any) {
      // Only the current server decision can authorize an override, never a cached preview.
      const msg = approvalError(e);
      if (e.response?.status === 403 && e.response.data?.code === 'BUDGET_LIMIT_EXCEEDED'
        && e.response.data.canOverride === true && isAdmin) {
        const reason = await ask({
          title: t('bud_override_prompt'), label: t('reason'), required: true, minLength: 3,
          hint: t('bud_override_hint'), confirmLabel: t('approve'),
        });
        if (!reason || reason.trim().length < 3) return;
        try { await api.post(`/requests/${id}/approve`, { budgetOverrideReason: reason.trim() }); }
        catch (e2: any) { notify(approvalError(e2), 'error'); return; }
      } else { notify(msg, 'error'); return; }
    }
    load();
    setPreview((p) => { const q = { ...p }; delete q[id]; return q; });
    setImpact((m) => { const q = { ...m }; delete q[id]; return q; });
  };

  // Сужение круга участников вопреки политике спрашивают ОДИНАКОВО у обеих процедур:
  // запечатанный RFQ объявляется тем же списком на том же экране и сужает так же, как
  // аукцион. Правило на сервере тоже одно — `visibility-rule.ts`.
  const askVisibilityReason = async (
    r: any, visibility: 'PUBLIC' | 'INVITED',
  ): Promise<string | undefined | typeof CANCELLED> => {
    if (!hasPolicies || visibility !== 'INVITED' || r.method_resolved !== 'OPEN_TENDER') return undefined;
    const reason = await ask({
      title: t('visibility_reason_prompt'), label: t('reason'), hint: t('visibility_reason_hint'),
      required: true, minLength: 3, confirmLabel: t('announce'),
    });
    return reason ? reason.trim() : CANCELLED;
  };

  const makeRfq = async (r: any, type: 'RFQ' | 'RFP' | 'RFI' = 'RFQ', visibility: 'PUBLIC' | 'INVITED' = 'INVITED') => {
    const visibilityReason = await askVisibilityReason(r, visibility);
    if (visibilityReason === CANCELLED) return;
    try {
      const closeAt = new Date(Date.now() + 24 * 3600_000).toISOString();
      const ev = await api.post(`/events/from-request/${r.id}`, { closeAt, visibility, visibilityReason, type });
      nav(`/buyer/events/${ev.data.id}`);
    } catch (e: any) { notifyError(e); }
  };

  // Reverse auction: start at the estimate, min decrement = 1% (floor 1 AZN).
  // Аукцион по приглашениям на заявке, которую политика отнесла к открытому тендеру, —
  // отклонение от собственного правила организации. Продукт его не запрещает: кого пускать
  // на живые торги, решает закупщик. Но спрашивает причину и записывает её в журнал, как и
  // при присуждении не лучшей ставке. Обратный случай — открытый аукцион там, где хватило
  // бы закрытого — вопросов не вызывает: круг участников шире, а не уже.
  const makeAuction = async (r: any, visibility: 'PUBLIC' | 'INVITED') => {
    const visibilityReason = await askVisibilityReason(r, visibility);
    if (visibilityReason === CANCELLED) return;
    try {
      const start = Number(r.estimated_total_minor);
      const ev = await api.post(`/events/reverse/from-request/${r.id}`, {
        closeAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
        visibility, visibilityReason,
        startPriceMinor: start,
        minDecrementMinor: Math.max(Math.round(start / 100), 100),
      });
      nav(`/buyer/events/${ev.data.id}`);
    } catch (e: any) { notifyError(e); }
  };

  return (
    <>
      <h1>{t('requests')}</h1>
      <ListState of={{ loading: false, failed: refFailed, reload: loadRefs }} />
      {/* `tip-below`: кнопка стоит почти под заголовком страницы, а пузырь подсказки
          рисуется ВВЕРХ — на трёх строках ему там не хватает места, и он обрезается
          верхом окна, где прокрутить его уже нечем. */}
      {!isFinance && !formOpen && (
        <button className="btn tip-below" data-testid="req-new" data-tip={t('tip_new_request')}
          onClick={() => { setErr(''); setFormOpen(true); }} style={{ marginBottom: 12 }}>
          + {t('new_request')}
        </button>
      )}
      {!isFinance && formOpen && (
        <RequestWizard
          categoryOptions={categoryOptions}
          titleOptions={[...new Set(rows.map((r: any) => r.title).filter(Boolean))].slice(0, 50) as string[]}
          deps={deps}
          onCancel={() => { setErr(''); setFormOpen(false); }}
          onCreated={() => {
            setFormOpen(false);
            load();
            // Новая категория заводится сервером в момент создания заявки — перечитываем
            // справочник, чтобы она подсказывалась уже со следующей заявки.
            loadRefs();
          }}
        />
      )}
      <div className="card">
        <div style={{ display: 'flex', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
          <input placeholder={`🔎 ${t('title')}…`} value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} style={{ maxWidth: 320 }} />
          <select value={depFilter} onChange={(e) => { setDepFilter(e.target.value); setPage(1); }} style={{ maxWidth: 220 }}>
            <option value="">{t('dep_all')}</option>
            {deps.map((d) => <option key={d.id} value={d.id}>{d.code}</option>)}
          </select>
        </div>
        {/* Процедуры больше не объясняются абзацем над таблицей: объяснение стоит в окне
            «Elan et», у каждой процедуры своё. Здесь остаётся только ссылка на правило,
            которое их выбирает. */}
        {['BUYER_ADMIN', 'BUYER_APPROVER'].includes(session?.org.role ?? '') && (
          <div className="hint" style={{ marginBottom: 10 }}>
            <a href="/buyer/settings">⚖️ {t('method_policy')}</a>
          </div>
        )}
        <ListState of={[requests,
          { loading: false, failed: impactFailed.length > 0,
            reload: () => impactFailed.forEach((id) => loadImpact(id)) }]}
          empty={!rows.length} />
        {statusFilter && (
          <FilterChip label={statusFilter === 'pending' ? t('req_f_pending') : statusLabel(t, statusFilter)}
            total={total} onClear={() => { setPage(1); setStatusFilter(''); }} testid="req-filter" />
        )}
        <table>
          <thead><tr><th className="nowrap">#</th><th className="grow">{t('title')}</th><th>{t('category')}</th><th>{t('department')}</th><th className="nowrap">{t('date')}</th><th>{t('requester')}</th><th className="num">{t('total')}<Cur of={cur} /></th><th>{t('status')}</th><th>{t('method')}</th><th className="acts">{t('actions')}</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.id}>
              <tr>
                <td className="nowrap">{r.request_no}</td>
                <td className="grow">{r.title}</td>
                <td>{r.category && r.category !== '*' ? r.category : '—'}</td>
                <td>{r.department_code ?? '—'}</td>
                <td className="hint nowrap">{fmtDate(r.created_at)}</td>
                <td className="hint">{r.created_by_name ?? '—'}</td>
                <td className="num">{cur ? fmtAmount(r.estimated_total_minor) : fmtMoney(r.estimated_total_minor, r.currency)}</td>
                <td>
                  <Badge status={r.status} />
                  {r.status === 'SUBMITTED' && r.steps_total > 0 && (
                    <div className="hint">✔ {r.steps_done}/{r.steps_total} · {r.current_role ? t(`role_${r.current_role}`) : '—'}</div>
                  )}
                    {/* Цепочки согласования может не быть вовсе — на только что заведённой
                        организации её и нет. Тогда заявку согласует любой согласующий, и это
                        надо сказать: пустое место читается как «никто не смотрит». */}
                    {r.status === 'SUBMITTED' && !r.steps_total && (
                      <div className="hint">✔ {t('any_approver')}</div>
                    )}
                </td>
                {/* RFQ and DIRECT read as themselves; OPEN_TENDER read as a database
                    code sitting next to a control that now says "open tender" in words. */}
                <td className="nowrap">{r.method_resolved === 'OPEN_TENDER' ? t('open_tender') : (r.method_resolved ?? '—')}</td>
                <td>
                  {/* Cancelling releases the budget this request is holding and demands a
                      written reason, so it is the one destructive action here and sits at the
                      end. Rejecting is not destructive — it is one half of a binary decision —
                      so it stays beside Approve where an approver expects it. */}
                  <Actions>
                    {r.status === 'DRAFT' && !isFinance && <button className="btn small" data-testid="req-submit" data-tip={t('tip_submit')} onClick={() => act(r.id, 'submit')}>{t('submit')}</button>}
                    {r.status === 'SUBMITTED' && (canApprove || (isFinance && r.current_role === 'BUYER_FINANCE')) && (
                      <>
                        <button className="btn small" data-testid="req-approve" aria-label={preview[r.id] ? t('confirm_approve') : t('approve')} data-tip={t('tip_approve')} onClick={() => approveGuard(r.id)}>
                          {preview[r.id] ? `✔ ${t('confirm_approve')}` : t('approve')}
                        </button>
                        <button className="btn small ghost" data-testid="req-reject" data-tip={t('tip_reject')} onClick={() => act(r.id, 'reject')}>{t('reject')}</button>
                      </>
                    )}
                    {/* One decision, one control: the procedure is picked inside the dialog
                        this button opens, where each one is explained. */}
                    {r.status === 'APPROVED' && r.method_resolved !== 'DIRECT' && canApprove && (
                      <button className="btn small" data-testid="req-announce" data-tip={t('tip_announce')} onClick={() => announce(r)}>{t('announce')}</button>
                    )}
                    {r.status === 'APPROVED' && r.method_resolved === 'DIRECT' && canApprove && (
                      <button className="btn small" data-testid="req-direct" data-tip={t('tip_direct')} onClick={() => placeDirect(r)}>📦 {t('direct_order')}</button>
                    )}
                    {/* Cancelling an approved request is the one destructive thing here and
                        the one nobody does by default: it belongs behind the named button,
                        not beside Announce where a mis-click lands on it.
                        */}
                    <RowMenu>
                      {r.status === 'APPROVED' && isAdmin && (
                        <button className="btn small ghost danger" data-tip={t('tip_cancel_request')} onClick={() => cancelRequest(r.id)}>
                          {t('cancel')}
                        </button>
                      )}
                    </RowMenu>
                  </Actions>
                </td>
              </tr>
              {preview[r.id] && (
                <tr>
                  <td colSpan={10} style={{ background: 'rgba(79,140,255,0.05)' }}>
                    <b>{t('items')}</b>
                    <table style={{ margin: '6px 0' }}>
                      <thead><tr><th>{t('name')}</th><th>{t('qty')}</th><th>{t('unit_price')}</th><th>{t('total')}</th></tr></thead>
                      <tbody>
                        {preview[r.id].items.map((it: any) => (
                          <tr key={it.id}>
                            <td>{it.name}</td>
                            <td>{Number(it.qty)} {it.uom}</td>
                            <td className="num">{fmtMoney(it.est_unit_price_minor, r.currency)}</td>
                            <td className="num">{fmtMoney(it.est_total_minor, r.currency)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {/* the money question, answered before the approve click, not after */}
                    {impact[r.id] === null && <div className="hint">{t('bud_impact_none')}</div>}
                    {impact[r.id] && (
                      <div style={{ marginBottom: 6 }}>
                        <b>{t('bud_impact')}:</b>{' '}
                        {impact[r.id].departmentCode ? `${impact[r.id].departmentCode} · ` : ''}
                        {impact[r.id].budgetName} ({impact[r.id].periodLabel}) —{' '}
                        {fmtMoney(impact[r.id].projectedUsedMinor, impact[r.id].currency)} /{' '}
                        {fmtMoney(impact[r.id].amountMinor, impact[r.id].currency)}{' '}
                        <span className={impact[r.id].wouldWarn ? 'error' : ''}>
                          ({impact[r.id].projectedPct}%)
                        </span>
                      </div>
                    )}
                    <span className="hint">{t('tip_approve')}</span>
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
          </tbody>
        </table>
        <Pager total={total} page={page} pageSize={PAGE_SIZE} onPage={setPage} />
      </div>
    </>
  );
}
