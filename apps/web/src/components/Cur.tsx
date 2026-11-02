// The currency code of a money column, printed once in its heading.
//
// It sits on its own line on purpose: written beside the word ("Məbləğ (AZN)") it set the
// column's width, and four such headings cost more room than printing the code on all
// twenty-four figures had. Null means the rows disagree on currency, and then every cell
// carries its own code and the heading says nothing — see `tableCurrency`.
export function Cur({ of }: { of: string | null }) {
  return of ? <span className="th-cur">{of}</span> : null;
}
