import { FormEvent, useEffect, useState } from 'react';
import { api, fmtMoney } from '../../api/client';
import { useI18n } from '../../i18n';
import { Suggest, SuggestOption } from '../../components/Suggest';

// Создание заявки по шагам.
//
// Одна форма спрашивала всё сразу: заголовок, категорию, отдел, позиции — и ничего не
// говорила о последствиях. А последствия у заявки ровно два, и оба решаются ещё до
// отправки: СУММА выбирает способ закупки (прямая или тендер), а пара «категория + отдел»
// выбирает бюджет, из которого уйдут деньги. Человек узнавал об этом потом, от
// согласующего. Владелец сказал про этот экран: «надо сделать процесс более интуитивным и
// интерактивным», и это он и есть — не косметика, а показ последствий там, где их ещё
// можно изменить.
//
// Три шага: что покупаем → позиции → проверка. На последнем шаге сервер отвечает на два
// вопроса о НЕСУЩЕСТВУЮЩЕЙ ещё заявке: каким способом она пойдёт и что станет с бюджетом.
// Считает их тот же код, что и при подаче (`/requests/method-preview`,
// `/budgets/impact-preview`) — второй ответ, посчитанный на странице, однажды разошёлся бы
// с первым, и человек поверил бы не тому.
export interface WizardItem { name: string; qty: number; price: string }

const emptyItem = (): WizardItem => ({ name: '', qty: 1, price: '' });

export function RequestWizard({
  categoryOptions, titleOptions, deps, onCreated, onCancel,
}: {
  categoryOptions: SuggestOption[];
  titleOptions: string[];
  deps: Array<{ id: string; code: string; name?: string; is_active: boolean }>;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState(0);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [department, setDepartment] = useState('');
  const [items, setItems] = useState<WizardItem[]>([emptyItem()]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [method, setMethod] = useState<string | null>(null);
  const [impact, setImpact] = useState<any | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);

  const totalMinor = items.reduce(
    (sum, i) => sum + Math.round(Number(i.price) * 100 || 0) * Number(i.qty || 0), 0,
  );
  const filled = items.filter((i) => i.name.trim());
  // Шаг нельзя перешагнуть пустым: «Дальше» не уводит с шага, на котором нет того, ради
  // чего он существует. Это дешевле, чем отказ сервера в конце, когда исправлять уже
  // далеко.
  const canLeave = (s: number) => (s === 0 ? title.trim().length > 0 : s === 1 ? filled.length > 0 && totalMinor > 0 : true);

  // Предпросмотр спрашивается на третьем шаге и при каждом изменении того, от чего он
  // зависит: вернуться на шаг назад, поменять категорию и прийти обратно — обычный ход.
  useEffect(() => {
    if (step !== 2) return;
    let alive = true;
    setPreviewFailed(false);
    const params = { category: category.trim() || '*', amountMinor: String(totalMinor) };
    Promise.all([
      api.get('/requests/method-preview', { params }).then((r) => r.data?.method ?? null),
      api.get('/budgets/impact-preview', { params: { ...params, ...(department ? { departmentId: department } : {}) } })
        .then((r) => r.data ?? null),
    ])
      .then(([m, i]) => { if (alive) { setMethod(m); setImpact(i); } })
      // Молчать нельзя: пустая сводка читается как «последствий нет», а это не так —
      // их просто не узнали.
      .catch(() => { if (alive) { setMethod(null); setImpact(null); setPreviewFailed(true); } });
    return () => { alive = false; };
  }, [step, category, department, totalMinor]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await api.post('/requests', {
        title,
        ...(category.trim() ? { category: category.trim() } : {}),
        ...(department ? { departmentId: department } : {}),
        items: filled.map((i) => ({ name: i.name, qty: Number(i.qty), estUnitPriceMinor: Math.round(Number(i.price) * 100) })),
      });
      onCreated();
    } catch (e: any) {
      setErr(e.response?.data?.message?.toString() ?? t('error_generic'));
    } finally { setBusy(false); }
  };

  const steps = [t('req_step_what'), t('req_step_items'), t('req_step_check')];

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>{t('new_request')}</h3>
        <button type="button" className="btn small ghost" onClick={onCancel}>✕ {t('form_hide')}</button>
      </div>

      {/* Шаги названы словами и показывают, где человек сейчас и сколько осталось.
          Полоска без подписей говорила бы «их три», но не «о чём они». */}
      <ol className="wiz-steps" data-testid="req-steps">
        {steps.map((s, i) => (
          <li key={s} className={i === step ? 'on' : i < step ? 'done' : ''} data-testid={i === step ? 'req-step-current' : undefined}>
            <b>{i + 1}</b> {s}
          </li>
        ))}
      </ol>

      <form onSubmit={create}>
        {step === 0 && (
          <>
            <div className="hint" style={{ marginBottom: 10 }}>{t('req_step_what_hint')}</div>
            <div className="row">
              <div style={{ flex: 2 }}><label htmlFor="request-title">{t('title')}</label>
                <Suggest id="request-title" testid="req-title" value={title} onChange={setTitle} required
                  allowNew={false} tip={t('req_title_tip')} options={titleOptions} /></div>
              <div style={{ flex: 1 }}><label htmlFor="request-category">{t('category')}</label>
                <Suggest id="request-category" testid="req-category" value={category} onChange={setCategory}
                  placeholder="IT, OFFICE…" tip={t('cat_tip')} options={categoryOptions} /></div>
              <div style={{ flex: 1 }}><label htmlFor="request-department">{t('department')}</label>
                <select id="request-department" data-testid="req-department" value={department}
                  onChange={(e) => setDepartment(e.target.value)}>
                  <option value="">{t('dep_default')}</option>
                  {deps.filter((d) => d.is_active).map((d) => (
                    <option key={d.id} value={d.id}>{d.code}{d.name ? ` · ${d.name}` : ''}</option>
                  ))}
                </select></div>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <div className="hint" style={{ marginBottom: 10 }}>{t('req_step_items_hint')}</div>
            {items.map((it, idx) => (
              <div className="row" key={idx}>
                <div style={{ flex: 3 }}><label htmlFor={`request-item-${idx}-name`}>{t('name')}</label>
                  <input id={`request-item-${idx}-name`} data-testid={`item-name-${idx}`} value={it.name}
                    onChange={(e) => setItems(items.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x)))} /></div>
                <div style={{ flex: '0 0 110px' }}><label htmlFor={`request-item-${idx}-qty`}>{t('qty')}</label>
                  <input id={`request-item-${idx}-qty`} data-testid={`item-qty-${idx}`} type="number" min={1} value={it.qty}
                    onChange={(e) => setItems(items.map((x, i) => (i === idx ? { ...x, qty: Number(e.target.value) } : x)))} /></div>
                <div style={{ flex: '0 0 170px' }}><label htmlFor={`request-item-${idx}-price`}>{t('unit_price')} (AZN)</label>
                  <input id={`request-item-${idx}-price`} data-testid={`item-price-${idx}`} type="number" step="0.01" min={0} value={it.price}
                    onChange={(e) => setItems(items.map((x, i) => (i === idx ? { ...x, price: e.target.value } : x)))} /></div>
              </div>
            ))}
            <div className="hint" data-testid="req-total" style={{ marginTop: 12 }}>
              {t('total')}: <b>{fmtMoney(totalMinor, 'AZN')}</b>
            </div>
            <button type="button" className="btn ghost small" style={{ marginTop: 10 }}
              onClick={() => setItems([...items, emptyItem()])}>+ {t('items')}</button>
          </>
        )}

        {step === 2 && (
          <>
            <div className="hint" style={{ marginBottom: 10 }}>{t('req_step_check_hint')}</div>
            <table className="wiz-sum" data-testid="req-summary">
              <tbody>
                <tr><td>{t('title')}</td><td><b>{title}</b></td></tr>
                <tr><td>{t('category')}</td><td>{category.trim() || '—'}</td></tr>
                <tr><td>{t('department')}</td><td>{deps.find((d) => d.id === department)?.code ?? t('dep_default')}</td></tr>
                <tr><td>{t('items')}</td><td>{filled.length}</td></tr>
                <tr><td>{t('total')}</td><td><b>{fmtMoney(totalMinor, 'AZN')}</b></td></tr>
              </tbody>
            </table>

            {/* Два последствия, посчитанные сервером. Каждое — одной фразой, потому что
                читают их за секунду перед нажатием, а не изучают. */}
            <div className="hint" data-testid="req-method-preview" style={{ marginTop: 12 }}>
              {method
                ? t('req_method_will').replace('%s', t(`mt_${method}`))
                : previewFailed ? t('req_preview_failed') : '…'}
            </div>
            <div className="hint" data-testid="req-budget-preview">
              {impact?.visible === false
                ? t('req_budget_hidden')
                : impact
                ? t('req_budget_will')
                  .replace('%n', impact.budgetName)
                  .replace('%p', String(impact.projectedPct))
                  .replace('%r', fmtMoney(Math.max(0, impact.amountMinor - impact.projectedUsedMinor), impact.currency))
                : previewFailed ? '' : t('req_budget_none')}
            </div>
            {impact?.wouldBlock && <div className="error" data-testid="req-budget-block">{t('req_budget_block')}</div>}
            {impact?.wouldWarn && !impact?.wouldBlock && <div className="hint" data-testid="req-budget-warn">⚠ {t('req_budget_warn')}</div>}
          </>
        )}

        <div style={{ marginTop: 14, display: 'flex', gap: 8, alignItems: 'center' }}>
          {step > 0 && (
            <button type="button" className="btn ghost" data-testid="req-back" onClick={() => { setErr(''); setStep(step - 1); }}>
              ← {t('req_back')}
            </button>
          )}
          {step < 2 && (
            // `type="button"` — не мелочь: кнопка «Дальше» внутри формы по умолчанию
            // отправляет её, то есть создавала бы заявку с первого шага.
            <button type="button" className="btn" data-testid="req-next" disabled={!canLeave(step)}
              onClick={() => { setErr(''); setStep(step + 1); }}>
              {t('req_next')} →
            </button>
          )}
          {step === 2 && (
            <button className="btn" disabled={busy}>{t('create')}</button>
          )}
          {step < 2 && !canLeave(step) && <span className="hint">{step === 0 ? t('req_need_title') : t('req_need_items')}</span>}
        </div>
        {err && <div className="error">{err}</div>}
      </form>
    </div>
  );
}
