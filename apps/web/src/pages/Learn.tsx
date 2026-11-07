import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../i18n';
import { useAuth } from '../auth/auth';
import { COURSE, COURSE_LESSONS, Lesson } from '../guides';
import { Explain } from '../components/Explain';

// The whole product as one path, for somebody who has just been given a login.
//
// Every recording here already existed; what did not exist was an ORDER. The per-section
// bar (components/Guide.tsx) answers «what is this page», which is the right question once
// you know what the pages are and the wrong one on your first day: it is reachable only by
// walking into a section, says nothing about what to open next, and remembers nothing. So
// this page keeps the same player and adds the three things a course needs — a sequence, a
// mark for what is done, and the way back into the product to try it.
//
// Both tracks are shown to everybody on purpose. A buyer who sells this product has to
// know what the supplier sees, and the recordings are static files that no role gates.
// What IS gated is the «open the section» button: it is drawn only when the viewer's own
// role may open that route (src/roles.ts, the same array the router guards it with), so it
// never bounces anyone to the home page.

const WATCHED = 'learn_watched';

// Per-browser, like every other remembered preference here. In a private window the write
// throws and the read answers empty — the page then simply shows no ticks, which is true
// rather than broken, so nothing else needs to know.
function readWatched(): string[] {
  try {
    const raw = localStorage.getItem(WATCHED);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
// Rounded up: «43 min» for 42:45 is honest about the hour it will take, where 42 reads as
// a promise the recordings do not keep.
const minutes = (sec: number) => Math.ceil(sec / 60);

export default function Learn() {
  const { t } = useI18n();
  const { session } = useAuth();
  const [watched, setWatched] = useState<string[]>(readWatched);
  const [playing, setPlaying] = useState<Lesson | null>(null);

  const mark = (key: string) => {
    setWatched((prev) => {
      if (prev.includes(key)) return prev;
      const next = [...prev, key];
      try { localStorage.setItem(WATCHED, JSON.stringify(next)); } catch { /* private window */ }
      return next;
    });
  };

  // Esc closes the player, as it does everywhere else in the product.
  useEffect(() => {
    if (!playing) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPlaying(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playing]);

  const total = COURSE_LESSONS.length;
  const doneCount = COURSE_LESSONS.filter((l) => watched.includes(l.key)).length;
  const totalMin = minutes(COURSE_LESSONS.reduce((s, l) => s + l.sec, 0));
  // Where to carry on: the first lesson not yet watched, in course order. With none left
  // every row offers «again» and nothing is singled out.
  const next = COURSE_LESSONS.find((l) => !watched.includes(l.key));
  const role = session?.org.role ?? '';

  return (
    <>
      <h1>{t('learn')}</h1>

      <div className="card learn-head">
        <div className="learn-head-top">
          <p className="muted learn-lead">
            {t('learn_lead')} <Explain text={t('learn_lead_tip')} />
          </p>
          <div className="learn-count" data-testid="learn-count">
            {t('learn_done')}: <b>{doneCount} / {total}</b>
            <span className="muted"> · {totalMin} {t('learn_min')}</span>
          </div>
        </div>
        {/* A plain measure of the same two numbers — nothing is conveyed by the bar alone. */}
        <div className="learn-progress" role="presentation">
          <div style={{ width: `${total ? (doneCount / total) * 100 : 0}%` }} />
        </div>
        <p className="muted learn-note">{t('learn_lang_note')}</p>
      </div>

      <div className="learn-grid">
        {COURSE.map((track) => {
          const trackMin = minutes(track.lessons.reduce((s, l) => s + l.sec, 0));
          return (
            <div className="card learn-track" key={track.id}>
              <h3 className="learn-track-title">{t(track.titleKey)}</h3>
              <div className="muted learn-track-sub">
                {t('learn_count')}: {track.lessons.length} · {trackMin} {t('learn_min')}
              </div>
              <ol className="learn-list">
                {track.lessons.map((lesson, i) => {
                  const done = watched.includes(lesson.key);
                  const isNext = next?.key === lesson.key;
                  return (
                    <li className={`learn-row${isNext ? ' is-next' : ''}`} key={lesson.key}
                      data-testid="learn-row" data-lesson={lesson.key}>
                      <span className={`learn-num${done ? ' is-done' : ''}`} aria-hidden="true">
                        {done ? '✓' : i + 1}
                      </span>
                      <span className="learn-title">{t(lesson.titleKey)}</span>
                      <span className="muted learn-len">{mmss(lesson.sec)}</span>
                      {/* Words on the button, and the word says which of the three states
                          this row is in: the one to carry on with, an unseen one, a repeat. */}
                      <button className={`btn small${isNext ? '' : ' ghost'} learn-play`}
                        data-testid="learn-play" onClick={() => setPlaying(lesson)}>
                        ▶ {isNext ? t('learn_continue') : done ? t('learn_again') : t('learn_watch')}
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>
          );
        })}
      </div>

      <div className="card">
        <h3>{t('learn_how')}</h3>
        <p className="muted">{t('learn_how_body')}</p>
        {/* A second line here used to name the two supplier sections that had no recording
            — /supplier/catalogs and /supplier/contracts. Both are recorded since
            2026-11-07 and sit in the supplier track below, so the caveat was removed
            together with its `learn_gap` strings rather than left standing as a lie. */}
      </div>

      {playing && (
        <div className="help-modal" onClick={() => setPlaying(null)}>
          <div className="help-modal-inner" onClick={(e) => e.stopPropagation()}>
            {/* The recordings are Azerbaijani only — see the note in guides.ts. Asking for
                the interface language would 404 on every other UI language. */}
            <video data-testid="learn-video" key={playing.key} src={`/guides/${playing.key}.az.webm`}
              poster={`/guides/${playing.key}.az.png`} controls autoPlay
              // The recordings live in Git LFS. A checkout or a build that did not
              // materialise them serves a 132-byte pointer labelled video/webm, and the
              // element fails silently — so say it out loud to whoever is building, not to
              // the user, for whom a missing file is nothing they can act on.
              onError={() => {
                if (import.meta.env.DEV) console.warn(`guide video missing: ${playing.key}.az.webm — git lfs pull?`);
              }}
              // Played to the end is the only thing this page treats as «watched»: a mark
              // set on opening would tick the whole course for anyone who clicked down the
              // list, which is worse than no mark at all.
              onEnded={() => mark(playing.key)} />
            <div className="learn-modal-bar">
              <span className="learn-modal-title">{t(playing.titleKey)}</span>
              {playing.to && playing.roles?.includes(role) && (
                <Link className="btn small ghost" data-testid="learn-goto" to={playing.to} onClick={() => setPlaying(null)}>
                  {t('learn_goto')} →
                </Link>
              )}
              <button className="btn ghost small" onClick={() => setPlaying(null)}>
                ⤡ {t('guide_collapse')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
