import { ReactNode, useState } from 'react';
import { useI18n } from '../i18n';

// A long explanation, disclosed ON THE PAGE.
//
// This used to put the paragraph inside a `data-tip` bubble, and that was the wrong idea
// twice over. A 240px-wide bubble turns 300 characters into a ten-line black slab that
// opens on hover, lands on top of the table the reader is looking at, and vanishes the
// moment they move the mouse to read it — the owner filmed exactly that on the budgets
// page: 561 characters of explanation covering three rows of figures. A hover bubble is
// for a hint of a few words. Documentation is not a hint.
//
// So the text now opens in the flow, under the line that offered it: nothing is covered,
// the reader can move the mouse, select the text, and it stays until they close it. The
// trigger keeps its word («Bu nə deməkdir?») rather than an ⓘ, which has twice been read
// here as "nothing to see", and it says which way it is about to go with ▾/▴.
//
// Works on touch for the same reason — a tap is a click, where a hover bubble needed a
// special case in narrow.ts to be reachable at all.
export function Explain({ text, children }: { text?: string; children?: ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="linklike explain" aria-expanded={open}
        onClick={() => setOpen((v) => !v)}>
        {t('what_is_this')} {open ? '▴' : '▾'}
      </button>
      {/* a <span>, not a <p>: two call sites already wrap this in a paragraph, and a
          block element inside <p> ends it early — the text would escape its own container. */}
      {open && <span className="explain-body">{children ?? text}</span>}
    </>
  );
}

// Re-exported so call sites keep one import, and kept in a plain .ts file so a test can
// load it without pulling JSX and React in behind it.
export { hintOf } from './hint';
