import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';

// The rest of a row's actions, behind one named button.
//
// `Actions` already said a row's buttons belong on one line. The stylesheet it shipped with
// said `flex-wrap: wrap` and `min-width: 92px` per button, so in a column 150px wide every
// button took a line of its own: six actions on a budget made a 235px row, and six budgets
// filled a screen and a half with nothing but buttons. Measured on the running stand, not
// read off the markup — that is how the contradiction survived a review in the first place.
//
// So the row keeps ONE action visible, the one its state is actually waiting for, and the
// others move in here. The trigger is a word, never three dots: the owner has twice read an
// unlabelled control as "there is nothing here" (an icon with no caption, a row that opened
// on a click to its title), and a menu nobody opens is worse than a long row.
//
// Children are the page's ordinary `<button className="btn small ghost">`s, unchanged. The
// stylesheet restyles them inside `.menu-pop` into full-width menu items, so a page moves a
// button in or out of the menu by moving one line, and `data-tip` keeps working where it is.
export function RowMenu({ children, label }: { children?: ReactNode; label?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const box = useRef<HTMLSpanElement>(null);

  // An empty slot must not draw a trigger that opens nothing. `{cond && <button/>}` yields
  // `false`, and an array of those is still truthy — the same trap `Actions` documents.
  const has = (n: ReactNode): boolean =>
    Array.isArray(n) ? n.some(has) : n != null && n !== false && n !== true && n !== '' && n !== 0;
  if (!has(children)) return null;

  return (
    <span className="menu" ref={box}>
      <button type="button" className="btn small ghost" aria-haspopup="menu" aria-expanded={open}
        onClick={(e) => {
          // Measured against the viewport at the moment of opening: the last rows of a long
          // table sit at the bottom of the window, and a menu drawn downwards there is
          // simply off screen. 44px a line plus the padding is enough to decide.
          const r = e.currentTarget.getBoundingClientRect();
          setUp(window.innerHeight - r.bottom < 240 && r.top > 240);
          setOpen((v) => !v);
        }}>
        {label ?? t('row_more')} {open ? '▴' : '▾'}
      </button>
      {open && (
        <Pop onClose={() => setOpen(false)} boxRef={box} up={up}>{children}</Pop>
      )}
    </span>
  );
}

function Pop({ children, onClose, boxRef, up }:
  { children: ReactNode; onClose: () => void; boxRef: React.RefObject<HTMLSpanElement | null>; up: boolean }) {
  const pop = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    // `mousedown`, not `click`: a menu item that re-renders the row (approve, close, delete)
    // unmounts before a `click` on the document ever fires, and the listener then closes a
    // menu that is already gone — harmless, but it also means the FIRST outside click after
    // such an action was being swallowed. Down-events happen before any of that.
    const away = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [boxRef, onClose]);

  // A row near the right edge of a wide table, and every row in the narrow card layout,
  // would otherwise hang the menu off the side of the page. The popup is right-aligned to
  // its trigger by CSS; this only pulls it back when that still leaves it off screen.
  useLayoutEffect(() => {
    const el = pop.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.left < 8) el.style.transform = `translateX(${Math.ceil(8 - r.left)}px)`;
  }, []);

  return (
    <span className={`menu-pop${up ? ' menu-up' : ''}`} ref={pop} role="menu"
      // Any item click closes the menu. Items are the page's own buttons with their own
      // handlers; this rides the bubble rather than wrapping every child.
      onClick={() => onClose()}>
      {children}
    </span>
  );
}

// A divider before the destructive tail of a menu, mirroring `actions-sep` in the row.
export function MenuSep() {
  return <span className="menu-sep" aria-hidden="true" />;
}
