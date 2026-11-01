import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n';

// The product's own dialogs, replacing 74 calls to the browser's alert / prompt / confirm.
//
// Why those had to go, in the order it matters: the native boxes cannot be translated — the
// buttons stay in the BROWSER's language, so an Azerbaijani buyer was answering «OK/Cancel»
// in English; they cannot be styled, so every one of them announced the page as a developer
// artefact; they take no validation, so «OTIF score 0-100» accepted «потом» and sent it to
// the server; and `prompt` is a modal freeze of the whole tab that some browsers now refuse
// outright in cross-origin frames.
//
// The API deliberately mirrors the three native calls, so each call site changes by one line:
//   notify(text, kind)    ← alert(text)
//   notifyError(e)        ← alert(e.response?.data?.message ?? 'Error')   (the usual shape)
//   await ask({…})        ← prompt(…)
//   await confirm({…})    ← confirm(…)

type Kind = 'error' | 'ok' | 'info';
type Toast = { id: number; text: string; kind: Kind };

type BaseOpts = {
  /** The question, in words. */
  title: string;
  /** Said under the field: what this answer will do, or where it will end up. */
  hint?: string;
  confirmLabel?: string;
  /** Paints the confirming button as destructive — deletes, disconnects, cancellations. */
  danger?: boolean;
};

export type AskOpts = BaseOpts & {
  /** The field's own label; the title does the job when this is absent. */
  label?: string;
  defaultValue?: string;
  /** An empty answer is refused, and the button says why instead of simply being dead. */
  required?: boolean;
  /**
   * The minimum the SERVER enforces (3 on most reasons, 10 on a delivery reconciliation).
   * It belongs here and not at the call site: a check after the dialog closes swallows the
   * action silently — «ок» was accepted, the dialog shut, and nothing happened.
   */
  minLength?: number;
  type?: 'text' | 'number' | 'date';
  min?: number;
  /** Нижняя граница для `type: 'date'` — отдельно от числового `min`, в виде ГГГГ-ММ-ДД. */
  minDate?: string;
  max?: number;
  /** Whole numbers only — a score is an integer and the API validates it as one. */
  integer?: boolean;
  /** Renders a list instead of a free field — a choice nobody can mistype. */
  options?: { value: string; label: string }[];
};

export type ConfirmOpts = BaseOpts;

type Api = {
  notify: (text: string, kind?: Kind) => void;
  /** The one shape every failed API call has, with the server's own message when it sent one. */
  notifyError: (e: unknown) => void;
  ask: (opts: AskOpts) => Promise<string | null>;
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
};

const Ctx = createContext<Api | null>(null);

export function useDialogs(): Api {
  const api = useContext(Ctx);
  if (!api) throw new Error('useDialogs outside DialogsProvider');
  return api;
}

type Pending =
  | { kind: 'confirm'; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { kind: 'ask'; opts: AskOpts; resolve: (v: string | null) => void };

export function DialogsProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [value, setValue] = useState('');
  const nextId = useRef(1);
  const field = useRef<HTMLInputElement | HTMLSelectElement | null>(null);
  const accept = useRef<HTMLButtonElement | null>(null);

  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((x) => x.id !== id)), []);

  const notify = useCallback((text: string, kind: Kind = 'info') => {
    const id = nextId.current++;
    setToasts((all) => [...all, { id, text, kind }]);
    // A success fades; a failure waits to be read. An error nobody saw is exactly the one
    // that mattered, and these replace alert(), which could not be missed at all.
    if (kind !== 'error') setTimeout(() => setToasts((all) => all.filter((x) => x.id !== id)), 6000);
  }, []);

  const notifyError = useCallback((e: unknown) => {
    const body = (e as any)?.response?.data?.message;
    const text = (Array.isArray(body) ? body.join('. ') : body?.toString())
      || (e as any)?.message || t('error_generic');
    notify(text, 'error');
  }, [notify, t]);

  // A second dialog on top of an open one would strand the first `await` for ever, so the
  // one being replaced is answered as cancelled. Hard to reach by clicking (the backdrop
  // covers the page), trivial to reach from a timer or a socket.
  const replace = (next: Pending) => setPending((prev) => {
    if (prev) { if (prev.kind === 'ask') prev.resolve(null); else prev.resolve(false); }
    return next;
  });

  const ask = useCallback((opts: AskOpts) => new Promise<string | null>((resolve) => {
    setValue(opts.defaultValue ?? (opts.options?.[0]?.value ?? ''));
    replace({ kind: 'ask', opts, resolve });
  }), []);

  const confirm = useCallback((opts: ConfirmOpts) => new Promise<boolean>((resolve) => {
    replace({ kind: 'confirm', opts, resolve });
  }), []);

  // Opening a dialog puts the keyboard inside it: on the field where there is one, on the
  // confirming button otherwise. Without this the caret stays on the page button that
  // opened the dialog — now underneath the backdrop — so Escape reached nothing and Tab
  // walked the whole page before arriving at the two buttons.
  useEffect(() => {
    if (pending?.kind === 'ask') field.current?.focus();
    else if (pending) accept.current?.focus();
  }, [pending]);

  const close = (answer: string | null | boolean) => {
    if (!pending) return;
    if (pending.kind === 'ask') pending.resolve(answer as string | null);
    else pending.resolve(answer as boolean);
    setPending(null);
  };

  // What stops the answer being accepted, said in words. A button that is simply dead makes
  // the reader guess; this is the same rule the Q&A field follows.
  const blocked = (): string | null => {
    if (!pending || pending.kind !== 'ask') return null;
    const o = pending.opts;
    if (o.required && !value.trim()) return t('dialog_required');
    if (o.minLength && value.trim().length < o.minLength) {
      return t('dialog_min').replace('{min}', String(o.minLength));
    }
    if (o.type === 'date') {
      // Срок в прошлом — это не придирка к формату: счёт с просроченной датой приходит
      // заказчику уже нарушенным, и разбираться в этом будет человек, а не поле ввода.
      if (!value) return t('dialog_required');
      if (o.minDate && value < o.minDate) return t('dialog_date_past');
    }
    if (o.type === 'number') {
      const n = Number(value);
      if (value.trim() === '' || !Number.isFinite(n)) return t('dialog_required');
      if (o.integer && !Number.isInteger(n)) return t('dialog_integer');
      const min = o.min ?? -Infinity;
      const max = o.max ?? Infinity;
      if (n < min || n > max) {
        return t('dialog_range').replace('{min}', String(o.min ?? '')).replace('{max}', String(o.max ?? ''));
      }
    }
    return null;
  };
  const why = blocked();

  // Memoised: the provider re-renders on every keystroke in the dialog, and a fresh object
  // here would re-render every page that calls useDialogs() — a 200-row invoice table among
  // them — once per character typed.
  const api = useMemo(() => ({ notify, notifyError, ask, confirm }), [notify, notifyError, ask, confirm]);

  return (
    <Ctx.Provider value={api}>
      {children}
      {/* Escape is handled on the BACKDROP, not on the form: for a confirm there is no
          field, so the event starts on one of the two buttons — inside the form either way
          — and bubbles out here, while a key pressed anywhere else in the overlay would have
          missed a handler sitting on the form alone. */}
      {pending && (
        <div className="modal-back"
          onKeyDown={(e) => { if (e.key === 'Escape') close(pending.kind === 'ask' ? null : false); }}
          onMouseDown={(e) => {
            // Clicking the page outside the dialog cancels it, like the native box did.
            if (e.target === e.currentTarget) close(pending.kind === 'ask' ? null : false);
          }}>
          <form className="modal" role="dialog" aria-modal="true" aria-labelledby="dialog-title"
            onSubmit={(e) => {
              e.preventDefault();
              if (why) return;
              close(pending.kind === 'ask' ? value : true);
            }}>
            <h3 id="dialog-title" style={{ margin: 0 }}>{pending.opts.title}</h3>
            {/* A visible label only where it says something the title does not: with no
                `label` the question sits directly above the field and IS its name, and
                repeating it word for word read as a stutter («OTIF score / OTIF score»).
                The control is still named for a screen reader, by the title. */}
            {pending.kind === 'ask' && (
              <div className="filter-field" style={{ marginTop: 12 }}>
                {pending.opts.label && <label htmlFor="dialog-input">{pending.opts.label}</label>}
                {pending.opts.options ? (
                  <select id="dialog-input" data-testid="dialog-input"
                    aria-labelledby={pending.opts.label ? undefined : 'dialog-title'}
                    ref={(el) => { field.current = el; }}
                    value={value} onChange={(e) => setValue(e.target.value)}>
                    {pending.opts.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : (
                  <input id="dialog-input" data-testid="dialog-input"
                    aria-labelledby={pending.opts.label ? undefined : 'dialog-title'}
                    ref={(el) => { field.current = el; }}
                    type={pending.opts.type === 'number' ? 'number'
                      : pending.opts.type === 'date' ? 'date' : 'text'}
                    min={pending.opts.type === 'date' ? pending.opts.minDate : pending.opts.min}
                    max={pending.opts.max}
                    step={pending.opts.integer ? 1 : undefined}
                    value={value} onChange={(e) => setValue(e.target.value)} />
                )}
              </div>
            )}
            {pending.opts.hint && <div className="hint" style={{ marginTop: 8 }}>{pending.opts.hint}</div>}
            {why && <div className="error" style={{ marginTop: 6 }}>{why}</div>}
            {/* Main action first, then the way out — the order the rest of the product uses. */}
            <div className="modal-actions">
              <button type="submit" data-testid="dialog-confirm" disabled={!!why} ref={accept}
                className={`btn ${pending.opts.danger ? 'danger' : ''}`}>
                {pending.opts.confirmLabel ?? t('confirm')}
              </button>
              <button type="button" className="btn ghost" data-testid="dialog-cancel"
                onClick={() => close(pending.kind === 'ask' ? null : false)}>{t('cancel')}</button>
            </div>
          </form>
        </div>
      )}
      {/* `role="status"` with an assertive live region, not `role="alert"`: the list-state
          error band already owns the alert role, and the browser specs find it by that. */}
      <div className="toasts">
        {toasts.map((x) => (
          <div key={x.id} className={`toast ${x.kind}`} data-testid="toast"
            role="status" aria-live={x.kind === 'error' ? 'assertive' : 'polite'}>
            <span>{x.text}</span>
            <button type="button" className="btn small ghost" onClick={() => dismiss(x.id)}>✕ {t('close')}</button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
