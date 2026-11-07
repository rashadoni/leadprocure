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
    if (said !== key) return said;
  }
  const body = data?.message;
  return (Array.isArray(body) ? body.join('. ') : body?.toString())
    || (e as any)?.message
    || t('error_generic');
}
