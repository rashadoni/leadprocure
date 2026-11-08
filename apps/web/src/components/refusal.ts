// What a refusal says, in the language the reader chose.
//
// Every «no» from the server arrived as its English sentence and was printed verbatim:
// «Bid items required», «Incomplete lot bid is non-responsive…», «Below MOQ (10) for A4
// paper» — on a screen the supplier had set to Azerbaijani. The product spoke three
// languages until it had to refuse something.
//
// The server already carries a `code` beside the message on the refusals that matter
// (budgets and the self-approval guard did it first; the bid, the auction and the catalogue
// do now). So translation needs no new protocol: a code becomes the key `err_<CODE>`, and
// when that key is missing the English message still shows. Nothing is swallowed — an
// untranslated refusal reads exactly as it did before, which is why adding a code to a
// throw is safe on its own and adding the three strings is a separate, optional step.
export function refusalText(t: (k: string) => string, e: unknown): string {
  const data = (e as any)?.response?.data;
  const code = typeof data?.code === 'string' ? data.code : '';
  if (code) {
    const key = `err_${code}`;
    const said = t(key);
    // `t` returns the key itself when it has no entry — that is the whole test for «is
    // this one translated yet».
    if (said !== key) {
      // …and the numbers come with it. The English sentence carried them inside itself
      // («Below MOQ (5) for A4 kağız»), so a translation without them would be POORER than
      // the text it replaces — «the quantity is below the minimum» leaves the reader
      // guessing what the minimum is. The server already puts those fields in the body;
      // the placeholder syntax is the one the notifications use (`notifText`).
      return said
        .replace(/\{(\w+)\}/g, (_, field: string) => {
          const value = data?.[field];
          return value == null ? '' : String(value);
        })
        // A field the server did not send leaves an empty pair of brackets AND the space
        // in front of it: «Минимальная партия — 5 , а в заказе меньше» — a comma pushed off
        // its word reads as a typo in the product's own voice. Brackets go, then the gap
        // they left, then the space before whatever punctuation followed.
        .replace(/\(\s*\)|«\s*»/g, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/\s+([,.;:!?])/g, '$1')
        .trim();
    }
  }
  const body = data?.message;
  return (Array.isArray(body) ? body.join('. ') : body?.toString())
    || (e as any)?.message
    || t('error_generic');
}
