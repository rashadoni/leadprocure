import { isValidElement, ReactNode } from 'react';
import { menuItems, RowMenu } from './RowMenu';

// The action cell of a table row. Buttons used to be written straight into the <td>
// separated by a literal {' '}, so they wrapped wherever they happened to land: five
// buttons of five different widths over two or three ragged rows, with the destructive one
// first because that was the order the conditions were written in.
//
// Two rules, and they are the whole component:
//   · one row, one flex line, equal gaps — and that is now what the stylesheet says too:
//     it used to say `flex-wrap: wrap` with a 92px floor under every button, which lined
//     the column up by making its rows five times taller. What does not fit goes into a
//     RowMenu (components/RowMenu.tsx), it does not go onto a second line;
//   · reading order is what matters, not source order — the primary action leads, ordinary
//     ones follow, and anything destructive is pushed to the end behind a divider.
//
// `danger` is a separate slot rather than a flag on a button so a page cannot accidentally
// put "Cancel" first again. Giving it its own slot is also what lets the divider exist.
export function Actions({ children, danger }: { children?: ReactNode; danger?: ReactNode }) {
  // A slot fed by `rows.filter(...).map(...)` arrives as an array, and an EMPTY array is
  // still truthy — without this the divider would draw with nothing behind it.
  //
  // A <RowMenu> is asked what is INSIDE it, not whether it is there. It renders null when
  // it has no items, but as an element it is a perfectly truthy child, so a cell holding
  // nothing but a menu with nothing in it counted as full and the «—» below never drew:
  // on a phone, where every cell prints its column name, those rows said «ACTIONS:» and
  // then stopped. One rule here rather than a condition repeated at six call sites.
  const has = (n: ReactNode): boolean => {
    if (Array.isArray(n)) return n.some(has);
    // Asked through `menuItems`, so a menu holding nothing but a separator counts as empty
    // here too — the same answer the menu itself gives when it decides not to render.
    if (isValidElement(n) && n.type === RowMenu) {
      return menuItems((n.props as { children?: ReactNode }).children).length > 0;
    }
    return n != null && n !== false && n !== true && n !== '' && n !== 0;
  };
  // An empty action cell reads as a hole in the table; every other column says "—".
  if (!has(children) && !has(danger)) return <span className="hint">—</span>;
  return (
    <div className="actions">
      {children}
      {has(danger) && <span className="actions-sep" aria-hidden="true" />}
      {danger}
    </div>
  );
}
