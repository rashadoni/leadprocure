import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useI18n } from '../i18n';
import { GUIDES, SECTION_TITLE_KEY, SectionGuide } from '../guides';

// Section help video, presented as a CARD IN THE FLOW at the top of the section — not a
// floating overlay. The old widget sat fixed in the bottom-right corner and covered the
// working screen; this one occupies its own row, so nothing is ever hidden behind it.
// Clicking expands into a centered modal; the × dismisses the card (remembered per
// section in localStorage).
//
// The root carries data-help-video-widget: scripts/produce-guides.mjs hides that selector
// while recording, so the help card never appears inside the guide it belongs to.

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

const DISMISSED = 'guide_dismissed';
const dismissedSet = (): Set<string> => {
  try { return new Set(JSON.parse(localStorage.getItem(DISMISSED) ?? '[]')); } catch { return new Set(); }
};

export default function Guide() {
  const { pathname } = useLocation();
  const { t } = useI18n();
  const guide = resolveGuide(pathname);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(dismissedSet);

  // a new section starts collapsed, whatever the previous one was doing
  useEffect(() => { setOpen(false); }, [pathname]);

  // Esc closes the expanded player, like any modal on the page.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!guide || dismissed.has(guide.key)) return null;

  // Recordings are Azerbaijani only — see guides.ts. Asking for the interface language
  // would 404 on every non-az UI and fall back a moment later, so ask for az directly.
  const videoUrl = `/guides/${guide.key}.az.webm`;
  const posterUrl = `/guides/${guide.key}.az.png`;
  const titleKey = resolveTitleKey(pathname);
  const title = titleKey ? t(titleKey) : '';

  const hide = () => {
    const next = new Set(dismissed).add(guide.key);
    localStorage.setItem(DISMISSED, JSON.stringify([...next]));
    setDismissed(next);
  };

  return (
    <>
      <div className="help-card" data-help-video-widget>
        <button className="help-thumb" onClick={() => setOpen(true)} aria-label={t('guide_open')}>
          <img src={posterUrl} alt="" />
          <span className="help-play">▶</span>
        </button>
        <div className="help-text">
          <div className="help-kicker">🎥 {t('guide')}</div>
          {title && <div className="help-title">{title}</div>}
          <div className="help-sub">{t('guide_sub')}</div>
        </div>
        <div className="help-actions">
          <button className="btn help-open" onClick={() => setOpen(true)}>▶ {t('guide_open')}</button>
          <button className="help-x" onClick={hide} aria-label="✕">✕</button>
        </div>
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
