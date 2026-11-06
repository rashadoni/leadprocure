// A tooltip is a hint, not a page. These few dictionary entries run to 230–560 characters
// and were written to be read in the open; the bubble gets their first sentence and the
// reader gets the rest from the `Explain` beside it.
//
// 200, not 120: the bubble is 360px wide, where 200 characters is four lines. Cutting at
// 120 was throwing away the second half of seven ordinary hints that had nowhere else to
// be said — «only AZN», «cancelled awards do not count», the CSV column list — which is
// not shortening, it is deleting. Only text that IS repeated in an Explain is cut now.
//
// Cut at a sentence end, never at a character count: a bubble that stops mid-word reads
// as a bug, and shortening a translation by hand would mean writing three new ones that
// nobody reviewed.
export function hintOf(text: string, max = 200): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  // A FULL STOP is the only cut. Both an em-dash and a semicolon were in this list and
  // neither ends a sentence — they join clauses, and a bubble that stops at one reads as
  // unfinished («…sorğunun təsdiqi rədd edilir;» was the semicolon's version of it).
  //
  // The dash was also cut wrongly: `lastIndexOf(' — ')` points at the SPACE, so `+1` kept
  // the space and threw the dash away with everything after it.
  // The Russian spend_hint ended at «а ещё не принятый » — trailing space and all — and
  // lost «— не считается нигде», which is the rule the whole sentence exists to state.
  // Invisible in az and en, where the same text ends on a full stop, and invisible to the
  // browser walk, which runs the interface in English. That is why this is now asked of
  // the dictionary instead, in all three languages at once (tests/hint-of.spec.ts).
  const stop = cut.lastIndexOf('. ');
  if (stop > 40) return text.slice(0, stop + 1);
  const space = cut.lastIndexOf(' ');
  return (space > 40 ? cut.slice(0, space) : cut) + '…';
}
