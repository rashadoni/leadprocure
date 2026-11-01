import { useEffect } from 'react';

// ── Narrow screens: what a table row needs before CSS can draw it as a card ──
//
// Below NARROW the stylesheet stops laying tables out as tables: `thead` goes away and
// every cell becomes a "name: value" line (see the narrow block in styles.css). A cell on
// its own cannot say which column it came from, and CSS cannot reach a table's header from
// its body — so the header text has to be ON the cell, as `data-label`, for
// `td::before { content: attr(data-label) }` to print.
//
// This is ONE mechanism for all thirty-five tables in the product, called once in the
// shell, rather than a `data-label` written by hand into every `<td>` on nineteen pages:
// the labels then cannot drift from the headers above them, and a table added later is
// covered without anyone remembering this file exists.
//
// It runs only while the narrow layout is on. Above the breakpoint the observer is
// disconnected and what it stamped is taken back off, so the wide layout — and the browser
// specs that read the DOM at 1280 — see exactly the markup the pages wrote.
export const NARROW = '(max-width: 1100px)';

// Our own marks, so leaving narrow mode removes what we added and nothing else.
const LABEL = 'data-label';
const TIPFOCUS = 'data-tipfocus';

// `tBodies`/`rows`/`cells` are each scoped to their OWN table, which is what makes nested
// tables (a request's items inside its expanded row) work: the inner table's rows belong
// to the inner table's tbody, so they take the inner table's headers, not the outer ones.
function stampTables(): void {
  for (const table of Array.from(document.querySelectorAll('table'))) {
    const head = table.tHead;
    const headRow = head && head.rows.length ? head.rows[head.rows.length - 1] : null;
    // Column index → header text. A header spanning several columns names only the first
    // of them; the rest get nothing, which is better than a label that is not theirs.
    const labels: string[] = [];
    if (headRow) {
      for (const cell of Array.from(headRow.cells)) {
        const text = (cell.textContent ?? '').trim();
        for (let i = 0; i < (cell.colSpan || 1); i++) labels.push(i === 0 ? text : '');
      }
    }
    for (const body of Array.from(table.tBodies)) {
      for (const row of Array.from(body.rows)) {
        let col = 0;
        for (const cell of Array.from(row.cells)) {
          const span = cell.colSpan || 1;
          // A cell spanning the row is an expansion panel, not a value in a column — it is
          // left unlabelled and the stylesheet gives it the whole width of the card.
          const label = span === 1 ? labels[col] ?? '' : '';
          if (label) {
            if (cell.getAttribute(LABEL) !== label) cell.setAttribute(LABEL, label);
          } else if (cell.hasAttribute(LABEL)) {
            cell.removeAttribute(LABEL);
          }
          col += span;
        }
      }
    }
  }
}

// The hint bubble is drawn by `::after` on `[data-tip]`, opened by `:hover` and `:focus`.
// On a phone there is no hover at all, and most of the elements carrying a hint — a status
// pill, a column heading, a KPI tile — are plain <span>/<div>, which cannot take focus
// either: the explanation was simply unreachable by touch.
//
// `tabindex="-1"` is the one way in that costs nothing: a tap focuses the element (so the
// existing `:focus::after` rule opens the bubble and it stays open until the next tap),
// while the Tab order is untouched — this product has already had to take the help out of
// the first three Tab stops of every page once. Natively focusable controls are skipped,
// because `tabindex="-1"` would take a real button OUT of the Tab order.
function stampTips(): void {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-tip]'))) {
    if (el.matches('a[href], button, input, select, textarea, [tabindex]')) continue;
    el.setAttribute('tabindex', '-1');
    el.setAttribute(TIPFOCUS, '');
  }
}

function clearStamps(): void {
  for (const el of Array.from(document.querySelectorAll(`[${LABEL}]`))) el.removeAttribute(LABEL);
  for (const el of Array.from(document.querySelectorAll(`[${TIPFOCUS}]`))) {
    el.removeAttribute('tabindex');
    el.removeAttribute(TIPFOCUS);
  }
}

// Called once, from the shell every authenticated page renders inside.
export function useNarrowLayout(): void {
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(NARROW);
    let observer: MutationObserver | null = null;
    let frame = 0;
    // Rows arrive from the API long after this effect runs, and a page re-renders on every
    // filter and page change — so the stamping follows the DOM instead of a render.
    // Coalesced into one frame: a list of twenty rows is one burst of mutations, not twenty.
    // The observer watches childList only, so writing attributes cannot wake it again.
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; stampTables(); stampTips(); });
    };
    const apply = () => {
      if (mq.matches) {
        if (!observer) {
          observer = new MutationObserver(schedule);
          observer.observe(document.body, { childList: true, subtree: true });
        }
        stampTables();
        stampTips();
      } else {
        observer?.disconnect();
        observer = null;
        if (frame) { cancelAnimationFrame(frame); frame = 0; }
        clearStamps();
      }
    };
    apply();
    mq.addEventListener('change', apply);
    return () => {
      mq.removeEventListener('change', apply);
      observer?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
}
