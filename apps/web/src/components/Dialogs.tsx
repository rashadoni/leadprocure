import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
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

export type AskOpts = {
  /** The question, in words. Also the field's label unless `label` says otherwise. */
  title: string;
  label?: string;
  defaultValue?: string;
  /** An empty answer is refused, and the button says why instead of simply being dead. */
  required?: boolean;
  type?: 'text' | 'number';
  min?: number;
  max?: number;
  /** Renders a list instead of a free field — a choice nobody can mistype. */
  options?: { value: string; label: string }[];
  /** Said under the field: what this answer will do, or where it will show up. */
  hint?: string;
  confirmLabel?: string;
};

export type ConfirmOpts = {
  title: string;
  hint?: string;
  confirmLabel?: string;
  /** Paints the confirming button as destructive — deletes and disconnects. */
  danger?: boolean;
};

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

  const ask = useCallback((opts: AskOpts) => new Promise<string | null>((resolve) => {
    setValue(opts.defaultValue ?? (opts.options?.[0]?.value ?? ''));
    setPending({ kind: 'ask', opts, resolve });
  }), []);

  const confirm = useCallback((opts: ConfirmOpts) => new Promise<boolean>((resolve) => {
    setPending({ kind: 'confirm', opts, resolve });
  }), []);

  // Opening a dialog puts the keyboard where the answer goes. Without this the caret stays
  // on whatever button opened it, and Enter re-opens the dialog instead of answering it.
  useEffect(() => { if (pending?.kind === 'ask') field.current?.focus(); }, [pending]);

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
    if (o.type === 'number') {
      const n = Number(value);
      if (value.trim() === '' || !Number.isFinite(n)) return t('dialog_required');
      const min = o.min ?? -Infinity;
      const max = o.max ?? Infinity;
      if (n < min || n > max) {
        return t('dialog_range').replace('{min}', String(o.min ?? '')).replace('{max}', String(o.max ?? ''));
      }
    }
    return null;
  };
  const why = blocked();

  return (
    <Ctx.Provider value={{ notify, notifyError, ask, confirm }}>
      {children}
      {pending && (
        <div className="modal-back" onMouseDown={(e) => {
          // Clicking the page outside the dialog cancels it, like the native box did.
          if (e.target === e.currentTarget) close(pending.kind === 'ask' ? null : false);
        }}>
          <form className="modal" role="dialog" aria-modal="true" aria-labelledby="dialog-title"
            onKeyDown={(e) => { if (e.key === 'Escape') close(pending.kind === 'ask' ? null : false); }}
            onSubmit={(e) => {
              e.preventDefault();
              if (why) return;
              close(pending.kind === 'ask' ? value : true);
            }}>
            <h3 id="dialog-title" style={{ margin: 0 }}>{pending.opts.title}</h3>
            {pending.kind === 'ask' && (
              <div className="filter-field" style={{ marginTop: 12 }}>
                <label htmlFor="dialog-input">{pending.opts.label ?? pending.opts.title}</label>
                {pending.opts.options ? (
                  <select id="dialog-input" data-testid="dialog-input"
                    ref={(el) => { field.current = el; }}
                    value={value} onChange={(e) => setValue(e.target.value)}>
                    {pending.opts.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : (
                  <input id="dialog-input" data-testid="dialog-input"
                    ref={(el) => { field.current = el; }}
                    type={pending.opts.type === 'number' ? 'number' : 'text'}
                    min={pending.opts.min} max={pending.opts.max}
                    value={value} onChange={(e) => setValue(e.target.value)} />
                )}
              </div>
            )}
            {(pending.opts.hint || why) && (
              <div className={why ? 'error' : 'hint'} style={{ marginTop: 8 }}>{why ?? pending.opts.hint}</div>
            )}
            {/* Main action first, then the way out — the order the rest of the product uses. */}
            <div className="modal-actions">
              <button type="submit" data-testid="dialog-confirm" disabled={!!why}
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
