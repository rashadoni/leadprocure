import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useI18n } from '../i18n';
import { GUIDES, SECTION_TITLE_KEY, SectionGuide } from '../guides';

// Section help video, offered as ONE LINE above the section — not a floating overlay and
// no longer a 190px card. The card pushed the heading the reader came for below the fold
// and cost three tab stops (thumbnail, open, dismiss) before any content on every page;
// worse, it was dismissed per section, so clearing it from sight took twelve closes.
// Clicking opens the player in a centered modal. Hiding it is ONE switch for the whole
// product, shared with the checkbox in Settings.
//
// The root carries data-help-video-widget: scripts/produce-guides.mjs hides that selector
// while recording, so the help line never appears inside the guide it belongs to.

function resolveGuide(pathname: string): SectionGuide | null {
  if (GUIDES[pathname]) return GUIDES[pathname];
  // detail pages: longest prefix entry wins (e.g. /buyer/events/:id)
  const prefix = Object.keys(GUIDES)
    .filter((k) => k.endsWith('/') && pathname.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? GUIDES[prefix] : null;
}

// same longest-prefix rule as the guide itself, so a detail page is headed by its section
function resolveTitleKey(pathname: string): string | undefined {
  if (SECTION_TITLE_KEY[pathname]) return SECTION_TITLE_KEY[pathname];
  const prefix = Object.keys(SECTION_TITLE_KEY)
    .filter((k) => k.endsWith('/') && pathname.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? SECTION_TITLE_KEY[prefix] : undefined;
}

// One key, not one per section. The old `guide_dismissed` list is simply no longer read:
// whoever had hidden a few sections sees a single line there again, which is the point.
const HIDDEN = 'guide_hidden';
const EVENT = 'guides-visibility';

// The switch itself lives in this module variable, with localStorage only remembering it
// between visits. Reading storage back inside the listeners would break in a private
// window, where the write throws and the read then answers «visible»: the component that
// flipped it would hide while the sidebar went on thinking otherwise — and the way back,
// which only the sidebar draws, would never appear.
let hidden = ((): boolean => {
  try { return localStorage.getItem(HIDDEN) === '1'; } catch { return false; }
})();

export const guidesHidden = (): boolean => hidden;
/** Flips the one switch and tells every mounted reader of it: the bar and the sidebar. */
export const setGuidesHidden = (next: boolean): void => {
  hidden = next;
  try { localStorage.setItem(HIDDEN, next ? '1' : '0'); } catch { /* private window */ }
  window.dispatchEvent(new Event(EVENT));
};

/**
 * The switch, for whoever draws a control over it. The way back lives in the sidebar
 * rather than in Settings because suppliers have no Settings page at all — a switch one
 * role cannot reach is a one-way door.
 */
export function useGuidesHidden(): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState(guidesHidden);
  useEffect(() => {
    const sync = () => setValue(guidesHidden());
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);
  // No extra setState here: the event is dispatched synchronously and reaches every
  // subscriber, this one included, so both components move together or neither does.
  return [value, setGuidesHidden];
}

export default function Guide() {
  const { pathname } = useLocation();
  const { t } = useI18n();
  const guide = resolveGuide(pathname);
  const [open, setOpen] = useState(false);
  const [isHidden, setHidden] = useGuidesHidden();

  // a new section starts collapsed, whatever the previous one was doing
  useEffect(() => { setOpen(false); }, [pathname]);

  // Esc closes the expanded player, like any modal on the page.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!guide || isHidden) return null;

  // Recordings are Azerbaijani only — see guides.ts. Asking for the interface language
  // would 404 on every non-az UI and fall back a moment later, so ask for az directly.
  const videoUrl = `/guides/${guide.key}.az.webm`;
  const posterUrl = `/guides/${guide.key}.az.png`;
  const titleKey = resolveTitleKey(pathname);
  const title = titleKey ? t(titleKey) : '';

  return (
    <>
      {/* Two controls, both of them words: open this section's guide, or stop being offered
          one anywhere. The section's own name rides on the first so the line says what it
          would play. */}
      <div className="help-bar" data-help-video-widget>
        {/* `tip-below`: this bar is the FIRST element on the page, and a bubble drawn above
            it is clipped by the top of the window with nowhere to scroll — including the
            one line that says how to bring the guides back. */}
        <button className="btn small ghost tip-below" onClick={() => setOpen(true)} data-tip={t('guide_sub')}>
          🎥 {t('guide')}{title ? `: ${title}` : ''}
        </button>
        <button className="btn small ghost tip-below" data-tip={t('guide_hide_all_tip')}
          onClick={() => setHidden(true)}>
          ✕ {t('guide_hide_all')}
        </button>
      </div>

      {open && (
        <div className="help-modal" onClick={() => setOpen(false)}>
          <div className="help-modal-inner" onClick={(e) => e.stopPropagation()}>
            <video key={videoUrl} src={videoUrl} poster={posterUrl} controls autoPlay />
            <button className="btn ghost small help-collapse" onClick={() => setOpen(false)}>
              ⤡ {t('guide_collapse')}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
