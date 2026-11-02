import { useI18n } from '../i18n';

// A long explanation, folded into the line that offers it.
//
// Three screens carried a 180–300 character grey paragraph between the toolbar and the
// table — the kind of text that is read once, never again, and is in the way for ever
// after. The text itself is worth keeping, so it moves into the hint bubble and the page
// keeps a short, worded invitation to read it. A word rather than an ⓘ: an unlabelled icon
// has already been read here as "nothing to see".
//
// A <button> and not a <span>: the bubble opens on hover AND on keyboard focus, and only a
// real control is reachable by Tab. Nothing happens on click, by design — the bubble is
// already open by then, and on touch the tap is what opens it (see stampTips in narrow.ts).
export function Explain({ text }: { text: string }) {
  const { t } = useI18n();
  return (
    <button type="button" className="linklike explain" data-tip={text} onClick={(e) => e.preventDefault()}>
      {t('what_is_this')}
    </button>
  );
}
