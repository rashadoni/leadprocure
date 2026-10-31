import { ReactNode } from 'react';

// The action cell of a table row. Buttons used to be written straight into the <td>
// separated by a literal {' '}, so they wrapped wherever they happened to land: five
// buttons of five different widths over two or three ragged rows, with the destructive one
// first because that was the order the conditions were written in.
//
// Two rules, and they are the whole component:
//   · one row, one flex line, equal gaps, a floor on button width so a short label and a
//     long one still line up down the column;
//   · reading order is what matters, not source order — the primary action leads, ordinary
//     ones follow, and anything destructive is pushed to the end behind a divider.
//
// `danger` is a separate slot rather than a flag on a button so a page cannot accidentally
// put "Cancel" first again. Giving it its own slot is also what lets the divider exist.
export function Actions({ children, danger, dense }: { children?: ReactNode; danger?: ReactNode; dense?: boolean }) {
  // A slot fed by `rows.filter(...).map(...)` arrives as an array, and an EMPTY array is
  // still truthy — without this the divider would draw with nothing behind it.
  const has = (n: ReactNode): boolean =>
    Array.isArray(n) ? n.some(has)
      : n != null && n !== false && n !== true && n !== '' && n !== 0;
  // An empty action cell reads as a hole in the table; every other column says "—".
  if (!has(children) && !has(danger)) return <span className="hint">—</span>;
  return (
    <div className={`actions${dense ? ' actions-dense' : ''}`}>
      {children}
      {has(danger) && <span className="actions-sep" aria-hidden="true" />}
      {danger}
    </div>
  );
}
