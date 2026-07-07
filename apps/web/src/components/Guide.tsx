import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useI18n } from '../i18n';
import { GUIDES, SectionGuide, TourStep } from '../guides';

// Intercom-style section guide: a floating video thumbnail (screen recording of THIS
// section on demo data) + an interactive spotlight tour over the live page elements.
// Resolved by route; sections without a guide render nothing.

function resolveGuide(pathname: string): SectionGuide | null {
  if (GUIDES[pathname]) return GUIDES[pathname];
  // detail pages: longest prefix entry wins (e.g. /buyer/events/:id)
  const prefix = Object.keys(GUIDES)
    .filter((k) => k.endsWith('/') && pathname.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? GUIDES[prefix] : null;
}

function Spotlight({ steps, onDone }: { steps: TourStep[]; onDone: () => void }) {
  const { t, lang } = useI18n();
  const [i, setI] = useState(0);
  const present = useMemo(
    () => steps.filter((s) => document.querySelector(s.selector)),
    [steps],
  );
  const step = present[i];
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!step) return;
    const el = document.querySelector(step.selector);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const update = () => setRect(el.getBoundingClientRect());
    const timer = setTimeout(update, 350); // after smooth scroll
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { clearTimeout(timer); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDone(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDone]);

  if (!step || !rect) return null;
  const below = rect.bottom + 170 < window.innerHeight;
  return (
    <div className="tour-layer" onClick={onDone}>
      <div
        className="tour-spot"
        style={{ top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 }}
      />
      <div
        className="tour-tip"
        onClick={(e) => e.stopPropagation()}
        style={{
          top: below ? rect.bottom + 14 : Math.max(10, rect.top - 160),
          left: Math.min(Math.max(10, rect.left), window.innerWidth - 340),
        }}
      >
        <b>{step.title[lang] ?? step.title.ru}</b>
        <p>{step.text[lang] ?? step.text.ru}</p>
        <div className="tour-nav">
          <span className="hint">{i + 1} / {present.length}</span>
          {i > 0 && <button className="btn small ghost" onClick={() => setI(i - 1)}>‹ {t('prev')}</button>}
          {i < present.length - 1
            ? <button className="btn small" onClick={() => setI(i + 1)}>{t('next')} ›</button>
            : <button className="btn small" onClick={onDone}>✓ OK</button>}
        </div>
      </div>
    </div>
  );
}

export default function Guide() {
  const { pathname } = useLocation();
  const { t, lang } = useI18n();
  const guide = resolveGuide(pathname);
  const [video, setVideo] = useState(false);
  const [tour, setTour] = useState(false);
  const [hidden, setHidden] = useState(() => sessionStorage.getItem('guide_hidden') === '1');

  useEffect(() => { setVideo(false); setTour(false); }, [pathname]);

  if (!guide || hidden) return null;
  // per-language asset, with a graceful fallback to the Russian recording if a language's
  // video/poster isn't present yet (e.g. produced later).
  const videoUrl = `/guides/${guide.key}.${lang}.webm`;
  const videoFallback = `/guides/${guide.key}.ru.webm`;
  const posterUrl = `/guides/${guide.key}.${lang}.png`;
  return (
    <>
      <div className="guide-widget">
        <button className="guide-close" title="✕"
          onClick={() => { sessionStorage.setItem('guide_hidden', '1'); setHidden(true); }}>✕</button>
        <div className="guide-thumb" onClick={() => setVideo(true)}>
          <img src={posterUrl} alt="" onError={(e) => { (e.target as HTMLImageElement).src = `/guides/${guide.key}.ru.png`; }} />
          <div className="guide-play">▶</div>
        </div>
        <div className="guide-label">{t('guide')}</div>
        {guide.tour && guide.tour.length > 0 && (
          <button className="btn small ghost" style={{ width: '100%' }} onClick={() => setTour(true)}>
            🧭 {t('tour')}
          </button>
        )}
      </div>

      {video && (
        <div className="guide-modal" onClick={() => setVideo(false)}>
          <video key={videoUrl} src={videoUrl} poster={posterUrl} controls autoPlay
            onClick={(e) => e.stopPropagation()}
            onError={(e) => {
              const v = e.target as HTMLVideoElement;
              if (!v.src.endsWith(`${guide.key}.ru.webm`)) v.src = videoFallback;
            }} />
        </div>
      )}
      {tour && guide.tour && <Spotlight steps={guide.tour} onDone={() => setTour(false)} />}
    </>
  );
}
