#!/usr/bin/env node
// Produces the narrated section-guide videos: apps/web/public/guides/<key>.az.webm
// (+ <key>.az.png poster), one recording per section of the product.
//
// AZERBAIJANI ONLY (owner's decision, 2026-11-01). The recorder still accepts ru and en —
// pass them as the first argument — but nothing in the product loads them: the help bar in
// apps/web/src/components/Guide.tsx asks for the .az file whatever the interface language
// is, so producing the other two only burns TTS quota. The two leftover buyer-settings
// .ru/.en files were deleted in the same change.
//
// The video is never time-boxed: each scene is held for exactly its narration length (TTS
// is measured FIRST, then muxed over the recording with adelay+amix). A visible cursor
// performs the workflow — typing, hovering the tooltips the UI pass added, clicking —
// during the narration. Scene beats are FRACTIONS of the narration (h.holdUntil(0.4)),
// never fixed sleeps, so a re-recorded line of a different length still lands right.
//
// Usage: node scripts/produce-guides.mjs [BASE_URL] [langs=az] [keys…]
//   Env (Leadprocure/.env): GEMINI_API_KEY + AZURE_SPEECH_KEY/REGION
//   RESEED=1 re-seeds the stand first — and demo-target.mjs REFUSES anything that is not
//   an explicitly labelled disposable stack. Never point this at production.
//
// TTS engine per language (see ENGINE): az → Gemini (Google AI Studio), ru and en → Azure.
// Azerbaijani on Gemini is the owner's decision (2026-11-01). Azure's az-AZ-BanuNeural is
// kept in AZURE_VOICE and still reachable with TTS_AZ=azure, but it was judged too weak by
// ear — a listening decision, not a capability limit.
// The language is passed EXPLICITLY (XLANG → speechConfig.languageCode): Google lists
// Azerbaijani twice, northern (az-AZ, Latin) and southern (the Iranian variant), and a
// model left to guess may pick the wrong one. The voice is Kore, also the owner's pick.
// Measuring comes first and stays engine-agnostic: every engine writes an mp3, ffprobe
// measures THAT file, and the scene is held for exactly as long. So swapping the model
// changes the pacing by itself and nothing has to be re-timed by hand.
//
// The scenarios themselves were re-written on 2026-11-01 against the interface AFTER the
// October UI pass — see the comment over SECTIONS below.

import { createRequire } from 'module';
import { createHash } from 'crypto';
import { execSync,execFileSync } from 'child_process';
import {assertDemoTarget} from './demo-target.mjs';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = require(join(ROOT, 'apps/web/node_modules/@playwright/test'));
const OUT = join(ROOT, 'apps/web/public/guides');
mkdirSync(OUT, { recursive: true });

const rawArgs = process.argv.slice(2);
const BASE = rawArgs[0]?.startsWith('http') ? rawArgs.shift() : 'http://localhost:8080';
// Azerbaijani by default: the app ships one recording per section (see apps/web/src/guides.ts).
// Other languages still record on request — pass them as the first argument — but nothing
// in the UI reads them, so producing all three only burns TTS quota.
const LANGS = (rawArgs[0] && /^(az|ru|en)(,(az|ru|en))*$/.test(rawArgs[0])) ? rawArgs.shift().split(',') : ['az'];
const ONLY = rawArgs;

if (existsSync(join(ROOT, '.env'))) {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    // GEMINI_API_KEY2..9 are honoured below, but this loader only matched the unnumbered
    // name — so a spare key parked in .env was invisible and the run died on quota with a
    // working key sitting right there.
    const m = line.match(/^(AZURE_[A-Z_]+|GEMINI_API_KEY[0-9]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}
// Per-language TTS engine. Azure's Azerbaijani (Banu) is too weak → az on Gemini; English
// stays on Azure's free, solid Jenny to spare Gemini quota; ru on Gemini. Override per-lang
// via TTS_<LANG> env (e.g. TTS_RU=azure).
const ENGINE = {
  az: process.env.TTS_AZ ?? 'gemini',
  ru: process.env.TTS_RU ?? 'azure', // Dmitry: fast, unmetered; Gemini quota stays for az
  en: process.env.TTS_EN ?? 'azure',
};
const KEY = process.env.AZURE_SPEECH_KEY, REGION = process.env.AZURE_SPEECH_REGION;
const GEMINI_KEYS = (() => {
  const keys = [];
  for (const suffix of ['', '2', '3', '4', '5', '6', '7', '8', '9']) {
    const v = process.env[`GEMINI_API_KEY${suffix}`];
    if (v) for (const k of String(v).split(',').map((x) => x.trim()).filter(Boolean)) if (!keys.includes(k)) keys.push(k);
  }
  return keys;
})();
let gKeyIdx = 0;
const gExhausted = new Set();
const GEMINI_KEY = GEMINI_KEYS[0];
const AZURE_VOICE = { ru: 'ru-RU-DmitryNeural', az: 'az-AZ-BanuNeural', en: 'en-US-JennyNeural' };
const XLANG = { ru: 'ru-RU', az: 'az-AZ', en: 'en-US' };
// Kore is the owner's pick too (2026-11-01), approved on the same samples.
const GEMINI_VOICE = { az: 'Kore', ru: 'Kore', en: 'Kore' };
// gemini-3.8-flash-tts is the OWNER'S choice, made by ear on 2026-11-01 from three
// samples of the same Azerbaijani line (3.8-flash, 3.8-flash-lite, 2.5-preview) — so do
// not "upgrade" or "simplify" it away without playing the alternative to him first. It is
// also the only one of the three that is not a preview. Override with GEMINI_MODEL.
// Mind that 3.8 answers with a WAV container while 2.5 answers with headerless L16 —
// geminiTts handles both, see there.
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.8-flash-tts';

const P = (ms) => new Promise((r) => setTimeout(r, ms));
const dur = (f) => parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${f}"`).toString());
async function slowScroll(page, steps = 5, dy = 130, pause = 500) {
  for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, dy); await P(pause); }
}
// Accepts a CSS string OR a Locator, like moveTo/click do. It used to take strings only,
// and passing a locator stringified it into a bogus selector: the scroll never happened,
// the scene held its narration over a motionless screen, and freezedetect caught it.
const scrollTo = async (page, sel) => {
  const el = typeof sel === 'string' ? page.locator(sel).first() : sel.first?.() ?? sel;
  if (await el.count()) { await el.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {}); await P(700); }
};
const type = async (page, sel, text, delay = 85) => { const el = page.locator(sel).first(); await el.click(); await el.pressSequentially(text, { delay }); };

// ---- visible cursor overlay (Playwright doesn't render the mouse into the video) ----
// Injects a green pointer that glides to each target before an action, so the recording
// shows the workflow being performed: moving, filling, hovering (tooltips pop), clicking.
const CURSOR_JS = () => {
  if (window.__cur) return;
  const c = document.createElement('div');
  c.id = '__cur';
  c.style.cssText = 'position:fixed;z-index:2147483647;left:640px;top:360px;width:26px;height:26px;pointer-events:none;transition:left .55s cubic-bezier(.22,.61,.36,1),top .55s cubic-bezier(.22,.61,.36,1);filter:drop-shadow(0 2px 3px rgba(0,0,0,.4));';
  c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M4 2.5l15.5 6.7-6.4 1.8L9.7 20.5 4 2.5z" fill="#0f3d2e" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  document.body.appendChild(c);
  window.__cur = c;
  window.__moveCur = (x, y) => { c.style.left = x + 'px'; c.style.top = y + 'px'; };
};
const injectCursor = (page) => page.evaluate(CURSOR_JS).catch(() => {});
// Which scene is on screen right now, and how many cursor targets were never found.
// A missed target used to be SILENT: moveToLoc returned false, no scene checks the return
// value, and the result on screen is a motionless cursor that looks exactly like a pause
// the narration meant to leave. So "no misses" was a hope. SCENE is set by the run loop
// before each scene; MISSES is printed at the end, and makes the claim checkable.
let SCENE = '?';
let MISSES = 0;
const describe = (loc) => String(loc).replace(/^Locator@/, '').slice(0, 90);

async function moveToLoc(page, loc, hold = 650) {
  await injectCursor(page); // re-inject after any navigation wiped the overlay
  // Bounded for the same reason as boundingBox below — and this one is sneakier, because
  // the .catch() hides the failure while the twenty seconds are spent anyway.
  await loc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
  // boundingBox() has NO timeout of its own, so it inherits the context default (20s). An
  // element that is in the DOM but not rendered — a button a row's state does not show, a
  // panel that did not open — then costs the scene twenty seconds of a motionless screen,
  // and `⏱ действия дольше озвучки` is the only trace. Three sections lost 25–35s to this
  // on the first real run. A cursor that cannot reach its target should give up in two
  // seconds and let the scene go on: the narration still plays, nothing is lost but the
  // pointer move.
  const box = await loc.boundingBox({ timeout: 2000 }).catch(() => null);
  if (!box) {
    MISSES++;
    console.log(`  ✗ ${SCENE}: цель не найдена — ${describe(loc)}`);
    return false;
  }
  const x = Math.round(box.x + Math.min(box.width / 2, 70));
  const y = Math.round(box.y + box.height / 2);
  await page.evaluate(([x, y]) => window.__moveCur && window.__moveCur(x, y), [x, y]);
  await page.mouse.move(x, y);
  await P(hold);
  return true;
}
const L = (page, sel) => (typeof sel === 'string' ? page.locator(sel).first() : sel);
// То же, но ВСЕГДА один элемент: переданный локатор мог найти несколько, и тогда
// boundingBox/waitFor падают на строгом режиме Playwright — промах, которого в разметке нет.
const L1 = (page, sel) => (typeof sel === 'string' ? page.locator(sel) : sel).first();
// Pick a <select> option by the START of its label. Options are often "CODE · Full name",
// and selectOption({label}) needs an EXACT match — a near-miss silently waits out the whole
// default timeout, which lands in the recording as a dead pause the voice track can't fill.
// The first clickable figure on the page may well be 0.00 — its document list is empty, so
// nothing opens and the next scene waits out a 20s timeout as dead air. Pick a number that
// actually has money behind it.
async function firstNonZero(page, sel) {
  const all = page.locator(sel);
  const n = await all.count();
  for (let i = 0; i < n; i++) {
    const txt = (await all.nth(i).innerText().catch(() => '')) || '';
    if (!/^0[.,]00/.test(txt.trim())) return all.nth(i);
  }
  return all.first();
}

async function selectByPrefix(page, sel, prefix) {
  const opt = page.locator(`${sel} option`).filter({ hasText: prefix }).first();
  if (!(await opt.count())) return false;
  const value = await opt.getAttribute('value');
  await page.locator(sel).selectOption(value).catch(() => {});
  return true;
}
// The rest of a row's actions moved behind one named button in PR #96
// (apps/web/src/components/RowMenu.tsx): «Tarixçə», «Köçür», «Dəyişdir» and every stop are
// no longer in the DOM until the menu is open. So a scene that points at one has to open it
// first — and must be able to find out that it is not on THIS stand (a budget's menu holds
// different items per status) instead of spending the scene on a motionless cursor.
// Returns the item's locator, or null.
// A form field addressed by its own LABEL, not by its position in the form. The budget
// form is seven fields of three kinds, and `form input` nth(0) means «whichever input is
// first today»: add a field above it and the cursor quietly types the plan's name into the
// category. Nothing is logged — the selector still matches something — so the only trace is
// a wrong word on screen in a finished recording. The UI smoke records this same trap on
// this same form (AGENTS.md: «never address form fields by position»); the cure is the same.
const budField = (p, label, tag = 'input') =>
  p.locator(`form div:has(> label:has-text("${label}")) ${tag}`).first();

async function openRowMenu(page, rowSel, itemText, h) {
  const row = page.locator(rowSel).first();
  if (!(await row.count())) return null;
  const trigger = row.locator('.menu > button').first();
  if (!(await trigger.count())) return null;
  // Idempotent on purpose: two consecutive scenes work the same row, and clicking an
  // already-open trigger would CLOSE it — the item would then be gone, not found.
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await h.click(trigger, 700);
  const item = row.locator('.menu-pop button').filter({ hasText: itemText }).first();
  return (await item.count()) ? item : null;
}
// Closes an open row menu WITHOUT arming a focus ring.
//
// The menu already closes on a document-level `keydown` (RowMenu.tsx), so the trigger does
// not need to hold focus for Escape to work — and that is the whole point here. PR #104
// paints `:focus-visible` on buttons and links, and the browser arms it for whatever holds
// focus the moment a KEY is pressed: the trigger was focused by the click that opened the
// menu, so Escape would put a 2px green outline around «Daha çox» in a recording that is
// otherwise driven entirely by mouse. Dropping focus first is invisible on screen and makes
// the frame independent of the browser's focus heuristic instead of betting on it.
async function closeRowMenu(page) {
  await page.evaluate(() => { const el = document.activeElement; if (el instanceof HTMLElement) el.blur(); });
  await page.keyboard.press('Escape');
}
async function moveTo(page, sel, hold) { return moveToLoc(page, L(page, sel), hold); }
async function fillAt(page, sel, text, delay = 65) {
  const loc = L(page, sel);
  if (!(await moveToLoc(page, loc))) return;
  await loc.click({ delay: 40 }).catch(() => {});
  // Выделить прежнее значение, чтобы набор его ЗАМЕНИЛ, а не дописал. Два пути до этого
  // были неверны, и оба молча:
  //  · `selectText()` на <input type=number> не выделяет ничего — набранное «20» в поле
  //    «Say» со значением 1 давало «120», и в кадре, и в созданной заявке;
  //  · `fill('')` очищает поле, но оно управляемое: React пересчитывает `Number('')` в 0,
  //    возвращает в поле «0», и дальше набор даёт «020» — замерено, глава оборвалась на
  //    этой самой проверке.
  // Выделение с клавиатуры работает и там, и там: первая набранная буква заменяет
  // выделенное, а набор остаётся видимым в кадре.
  await loc.press('ControlOrMeta+a').catch(() => {});
  await loc.pressSequentially(text, { delay });
  await P(300);
}
// Both bound their Playwright call: the default is 30s, and a swallowed timeout burns the
// whole scene as dead air. moveToLoc has already put the cursor there, so a hover that
// cannot pass the actionability check (typically the previous tooltip covering the target)
// still looks right on screen — it just must not cost half a minute.
async function hoverTip(page, sel, hold = 1500) {
  const loc = L(page, sel);
  if (!(await moveToLoc(page, loc))) return;
  await loc.hover({ timeout: 2500 }).catch(() => {});
  await P(hold); // let the CSS tooltip fade in and be readable
}
async function clickAt(page, sel, waitMs = 900) {
  const loc = L(page, sel);
  if (!(await moveToLoc(page, loc))) return;
  await loc.click({ timeout: 5000 }).catch(() => {});
  await P(waitMs);
}

// Beat-synchronised helpers passed to every scene as the 3rd argument. Actions are
// paced as FRACTIONS of the scene's narration (h.holdUntil(0.4)), never fixed sleeps:
// az narration runs much longer than en/ru, so fixed pauses tuned for az leave
// trailing silence on the shorter languages (ported from the leaddrive-v2 recorder).
function makeHelpers(page) {
  let t0 = Date.now(), ms = 6000;
  return {
    sleep: P,
    setSceneBudget(m) { t0 = Date.now(); ms = m || 6000; },
    async holdUntil(frac) {
      const target = t0 + Math.max(0, Math.min(1, frac)) * ms;
      const remain = target - Date.now();
      if (remain > 0) await P(remain);
    },
    loc: (sel) => L(page, sel),
    // Строгий поиск: ЕСТЬ ли на экране то, без чего сцена бессмысленна. Обычный moveTo
    // при промахе только считает промах и идёт дальше — для экскурсии это верно (пропала
    // одна подсказка курсора), а для сквозной истории нет: если «Создать» не нашлось,
    // заявки не появилось, и следующие главы снимают пустые экраны. Сцена, которая
    // ДЕЙСТВУЕТ, объявляет `must: true` и берёт цели через need/needClick — тогда промах
    // обрывает прогон с именем сцены и названием того, чего не хватило.
    async need(sel, what, timeout = 8000) {
      const loc = L1(page, sel);
      try { await loc.waitFor({ state: 'visible', timeout }); }
      catch { throw new Error(`на экране нет «${what}» (${typeof sel === 'string' ? sel : describe(loc)})`); }
      return loc;
    },
    async needClick(sel, what, wait = 900) {
      const loc = L1(page, sel);
      try { await loc.waitFor({ state: 'visible', timeout: 8000 }); }
      catch { throw new Error(`нечего нажать: «${what}» (${typeof sel === 'string' ? sel : describe(loc)})`); }
      await moveToLoc(page, loc);
      await loc.click({ timeout: 5000 });
      await P(wait);
      return loc;
    },
    // Заполнение с проверкой того, что значение действительно попало в поле. Поле может
    // быть управляемым (React), и `pressSequentially` в отключённое или перерисованное
    // поле оставляет его пустым — в кадре это выглядит как набранный текст, которого нет.
    async needFill(sel, text, what) {
      const loc = L1(page, sel);
      try { await loc.waitFor({ state: 'visible', timeout: 8000 }); }
      catch { throw new Error(`нет поля «${what}» (${typeof sel === 'string' ? sel : describe(loc)})`); }
      await fillAt(page, loc, text);
      const got = await loc.inputValue().catch(() => null);
      if (got !== text) throw new Error(`поле «${what}» получило «${got}», а не «${text}»`);
      return loc;
    },
    moveTo: (sel, hold = 450) => moveTo(page, sel, hold),
    hover: (sel, hold = 900) => hoverTip(page, sel, hold),
    click: (sel, wait = 600) => clickAt(page, sel, wait),
    fill: (sel, text) => fillAt(page, sel, text),
    scrollTo: (sel) => scrollTo(page, sel),
    wheel: (dy) => page.mouse.wheel(0, dy),
  };
}

// Route each language to its engine; both write an mp3 to `out`, so the duration probe +
// ffmpeg mux are engine-agnostic.
// Narration cache: identical text+voice is synthesized once and reused across runs —
// the record→verify→fix→re-record loop would otherwise burn the daily Gemini quota
// on unchanged az lines.
const TTS_CACHE = join(ROOT, 'scripts/.tts-cache');
mkdirSync(TTS_CACHE, { recursive: true });
async function tts(text, lang, out) {
  const voice = ENGINE[lang] === 'azure' ? AZURE_VOICE[lang] : `gemini-${GEMINI_VOICE[lang]}`;
  const key = createHash('sha256').update(`${voice}|${lang}|${text}`).digest('hex').slice(0, 32);
  const cached = join(TTS_CACHE, `${key}.mp3`);
  if (existsSync(cached)) { copyFileSync(cached, out); return; }
  await (ENGINE[lang] === 'azure' ? azureTts(text, lang, out) : geminiTts(text, lang, out));
  copyFileSync(out, cached);
}

async function azureTts(text, lang, out) {
  if (!KEY || !REGION) throw new Error('AZURE_SPEECH_KEY / AZURE_SPEECH_REGION not set (needed for ' + lang + ')');
  const ssml = `<speak version='1.0' xml:lang='${XLANG[lang]}'><voice name='${AZURE_VOICE[lang]}'><prosody rate='+4%'>${text}</prosody></voice></speak>`;
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`https://${REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: 'POST',
        headers: { 'Ocp-Apim-Subscription-Key': KEY, 'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-24khz-96kbitrate-mono-mp3', 'User-Agent': 'leadprocure-guides' },
        body: ssml,
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`Azure TTS ${res.status}: ${(await res.text()).slice(0, 160)}`);
      writeFileSync(out, Buffer.from(await res.arrayBuffer()));
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < 4) await P(1500 * attempt);
    }
  }
  throw lastErr;
}

// Gemini native TTS (Google AI Studio). Returns raw 16-bit PCM (L16 24kHz mono) inline;
// we transcode to mp3 so the duration probe + ffmpeg mux stay unchanged.
async function geminiTts(text, lang, out) {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY not set');
  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      // Say the language, never leave it to the model's guess. Google lists Azerbaijani
      // TWICE — northern (az-AZ, Azerbaijan, Latin script) and southern (the Iranian
      // variant, a different norm and a different script). XLANG already holds az-AZ for
      // Azure's SSML, so both engines are told the same thing from one place.
      speechConfig: {
        languageCode: XLANG[lang],
        voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_VOICE[lang] } },
      },
    },
  };
  let lastErr;
  // The last per-minute refusal, kept for the throw at the bottom. Every OTHER way out of
  // this loop either returns or throws something, but the rate-limit path only `continue`s
  // — so ten minute-limit refusals in a row fell out of the loop with `lastErr` still
  // undefined and `throw lastErr` threw UNDEFINED. Seven minutes of waiting, then
  // `FAILED: undefined` and nothing to act on.
  let last429 = '';
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEYS[gKeyIdx]}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) },
      );
      // 429 = per-minute rate/quota cap on the TTS preview model. The window rolls every
      // ~60s, so wait it out (short backoff throws away the whole run) rather than fail.
      // A key that is REFUSED is not a key that is busy. 401/403 means revoked, mistyped
      // or not entitled to this model, and retrying it ten times with backoff spends ~90s
      // and then kills a run that the OTHER keys could have finished. A stale third key in
      // `.env` did exactly that. Burn it like an exhausted one and carry on; only if every
      // key is gone is there nothing left to try.
      if (res.status === 401 || res.status === 403) {
        const why = (await res.text().catch(() => '')).slice(0, 120).replace(/\s+/g, ' ');
        gExhausted.add(gKeyIdx);
        const next = GEMINI_KEYS.findIndex((_, i) => !gExhausted.has(i));
        if (next === -1) throw new Error(`Gemini: no usable key left (last one answered ${res.status}: ${why})`);
        console.log(`  · Gemini key #${gKeyIdx + 1} REFUSED (${res.status}) — dropping it, switching to key #${next + 1}`);
        gKeyIdx = next; continue;
      }
      if (res.status === 429) {
        const bodyText = await res.text().catch(() => '');
        // Say WHICH quota, from Google's own answer. "Daily cap" used to be a guess off a
        // /PerDay/ match on the whole body, and a per-MINUTE 429 whose body merely mentions
        // a per-day limit reads identically — so a run that only needed to wait a minute
        // burned every key instead. The quotaId is the fact; print it either way.
        let ids = [];
        try {
          for (const d of (JSON.parse(bodyText).error?.details ?? []))
            for (const v of (d.violations ?? [])) if (v.quotaId) ids.push(v.quotaId);
        } catch { /* non-JSON body: fall back to the regex below */ }
        const perDay = ids.length ? ids.some((q) => /PerDay/i.test(q)) : /PerDay/i.test(bodyText);
        const named = ids.length ? ids.join(', ') : '(quota not named in the answer)';
        if (perDay) {
          gExhausted.add(gKeyIdx);
          const next = GEMINI_KEYS.findIndex((_, i) => !gExhausted.has(i));
          if (next === -1) throw new Error(`Gemini: all keys hit their DAILY quota [${named}]`);
          console.log(`  · Gemini key #${gKeyIdx + 1} daily cap [${named}] — switching to key #${next + 1}`);
          gKeyIdx = next; continue;
        }
        last429 = named;
        const wait = Math.min(62000, 18000 * attempt);
        console.log(`  · Gemini 429 [${named}] — waiting ${Math.round(wait / 1000)}s, retry ${attempt}/10`);
        await P(wait);
        continue;
      }
      if (!res.ok) throw new Error(`Gemini TTS ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const j = await res.json();
      const part = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
      if (!part) throw new Error('Gemini TTS: no audio in response');
      // Two answer shapes, and guessing wrong is audible: 2.5-preview returns HEADERLESS
      // L16 (its rate only in the mime type), 3.8 returns a WAV CONTAINER. Reading a WAV as
      // raw s16le prepends its 44-byte header as a click and, if the file's real rate is
      // not the assumed one, shifts the pitch of the whole line. So when there is a
      // container, let ffmpeg read it; only headerless audio gets the rate supplied.
      const mime = part.inlineData.mimeType ?? '';
      const isWav = /wav/i.test(mime);
      const raw = `${out}.${isWav ? 'wav' : 'pcm'}`;
      writeFileSync(raw, Buffer.from(part.inlineData.data, 'base64'));
      const rate = (mime.match(/rate=(\d+)/) || [])[1] || '24000';
      const input = isWav ? `-i "${raw}"` : `-f s16le -ar ${rate} -ac 1 -i "${raw}"`;
      execSync(`ffmpeg -y -loglevel error ${input} -codec:a libmp3lame -q:a 3 "${out}"`);
      await P(1200); // gentle pacing to stay under the per-minute cap
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < 10) await P(2000 * attempt);
    }
  }
  throw lastErr ?? new Error(
    `Gemini TTS: 10 попыток подряд упёрлись в лимит частоты [${last429 || 'квота не названа'}] — озвучка не получена`);
}

// ---------------- сквозная история: одни данные на все главы ----------------
// Главы снимаются ПОДРЯД на одном стенде и продолжают друг друга: заявка из главы «Сорғулар»
// становится тендером в следующей, ставка поставщика — присуждением, присуждение — договором,
// заказом, приёмкой и счётом. Поэтому текст, который актёр набирает в форме, объявлен ОДИН
// раз здесь, а не в сценах: глава, которая ищет свою строку в таблице, ищет её по этому же
// названию.
//
// Записи азербайджанские (решение владельца 01.11.2026, см. шапку файла), поэтому и данные
// на стенде азербайджанские — отдельной карты по языкам тут нет. Прежние FILL/NAV/BTN были
// именно такой картой, объявленной по языкам и не читаемой ни одной сценой: переписывание
// сценариев 01.11.2026 зашило строки внутрь сцен и карты остались мёртвыми.
//
// Числа подобраны так, чтобы одна покупка прошла всю историю и ни одна глава не показывала
// чепухи:
//  · смета 64 000 ₼ ВЫШЕ порога прямого заказа (демо-политика: до 50 000 ₼ — DIRECT, выше —
//    RFQ), иначе тендера не будет вовсе;
//  · она же УМЕЩАЕТСЯ в квартальный план отдела OPS (150 000 ₼ после правки наполнения) —
//    иначе глава про бюджет показывала бы отдел, перерасходовавший в разы, то есть свойство
//    демо-данных, а не продукта;
//  · ставка поставщика ниже сметы ровно настолько, чтобы экономия была видимой цифрой
//    (58 000 ₼ против 64 000 ₼ — 6 000 ₼, 9,4%), и её же потом читают витрина и аналитика.
const STORY = {
  title: 'Satış şöbəsi üçün ofis mebeli',
  category: 'OFFICE',
  items: [
    { name: 'İş masası 140×70', qty: '20', price: '1800' },  // 36 000 ₼
    { name: 'Ofis oturacağı', qty: '20', price: '1400' },    // 28 000 ₼
  ],                                                         // смета: 64 000 ₼ → RFQ
  bid: ['1650', '1250'],                                     // ставка Supply One: 58 000 ₼
  bid2: ['1700', '1350'],                                    // ставка Baku Metal: 61 000 ₼
  deliveryDays: '14',
  supplier: 'Supply One',
  supplier2: 'Baku Metal',
};
// Своя строка истории в любой таблице заявок. По названию, а не по номеру: номер выдаёт
// база при создании, и сцена его знать не может.
const ROW = `tbody tr:has-text("${STORY.title}")`;

const API_URL = process.env.DEMO_API ?? 'http://localhost:3000';

// Правка стенда МЕЖДУ главами — только для того, чего в продукте нельзя сделать быстрее
// времени. Срок тендера — сутки; ждать их в записи нельзя, а выставить статус руками значит
// снять состояние, которого продукт сам не делает. Поэтому срок переводится в прошлое, а
// закрывает тендер ТА ЖЕ функция `close_due_events()`, что и расписание (на стенде оно
// выключено: DISABLE_SCHEDULERS=1).
//
// База называется явно и ДОЛЖНА быть помечена как стенд: это единственное, что отделяет
// запись роликов от боевой базы, у которой имя без суффикса.
const standSql = (sql) => {
  const pg = process.env.GUIDES_PG_CONTAINER, db = process.env.GUIDES_DB;
  if (!pg || !db) throw new Error('главе нужна правка стенда: задайте GUIDES_PG_CONTAINER и GUIDES_DB');
  if (!/_(guides|demo|walkthrough)$/.test(db)) {
    throw new Error(`отказ: «${db}» не похоже на стенд — имя базы должно кончаться на _guides, _demo или _walkthrough`);
  }
  return execFileSync('docker', ['exec', '-i', pg, 'psql', '-U', 'leadprocure_owner', '-d', db, '-At', '-f', '-'],
    { encoding: 'utf8', input: sql }).trim();
};
if (process.env.RESEED) assertDemoTarget(process.env,API_URL);

// ---------------- scenes: Azerbaijani narration + camera action ----------------
// Re-written 2026-11-01 against the interface AFTER the full UI pass of October
// (docs/ui-ux-audit-2026-10-31.md, PRs #60–#81). Every scene was checked against the
// page that renders it; where the pass moved a column, put words on an icon button or
// replaced four buttons with one control, the scene says what is on screen TODAY.
//
// Rules this block keeps, so a later edit does not quietly break a recording:
//  · name the control by the WORDS the interface shows (apps/web/src/i18n.tsx, az) —
//    the audit put a word on every icon button precisely so it could be named;
//  · prefer data-testid, then a heading's own text, then a button's own text; a
//    positional selector (`td nth(3)`) only where the column order is asserted by the
//    browser specs, because that is the order a stray column insert would break first;
//  · a scene whose selector misses is logged and its narration plays over a still
//    screen — so never point at something that only exists in some states.
const SECTIONS = {
  // The front page: five figures, then the task feed — the part that answers "what is
  // waiting for me". The arrow at the end of a task row became the worded «Aç» button
  // in PR #68, so the narration names a button instead of describing an arrow.
  'buyer-dashboard': { role: 'buyer', path: '/buyer/dashboard', scenes: [
    { az: 'İdarə paneli — hər gün işə buradan başlayırsınız. Ekran iki suala cavab verir: pul harada dayanıb və indi sizdən hansı qərar gözlənilir. Yuxarıdaki beş göstəricidən başlayaq.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.4); await h.moveTo(p.locator('.card').nth(0)); await h.holdUntil(0.9); } },
    { az: 'Birinci rəqəm — ümumi xərc. Bura yalnız qalib seçilmiş təkliflərin məbləği düşür, ƏDV-siz və yalnız manatla. Üzərinə gətirin — izah özü açılır: bu, dövr üzrə deyil, bütün vaxt üzrə rəqəmdir.',
      do: async (p, l, h) => { await h.hover(p.locator('.card').nth(0), 1400); await h.holdUntil(0.6); await h.moveTo(p.locator('.card').nth(1)); await h.holdUntil(0.92); } },
    { az: 'İkinci — qənaət. Sistem sorğunun öz smetası ilə qalib təklifin məbləğini müqayisə edir. Təkliflər smetadan baha gəlsə, qənaət mənfi olur — rəqəm bəzədilmir.',
      do: async (p, l, h) => { await h.hover(p.locator('.card').nth(1), 1400); await h.holdUntil(0.6); await h.moveTo(p.locator('.card').nth(2)); await h.holdUntil(0.92); } },
    { az: 'Sonra üç yük göstəricisi: işdə olan tenderlər, təsdiq gözləyən sorğular və hələ bağlanmamış sifarişlər. Hər rəqəmin öz izahı var, çünki «üç» sözü nəyin üçü olduğunu demir.',
      do: async (p, l, h) => { await h.moveTo(p.locator('.card').nth(2)); await h.holdUntil(0.3); await h.hover(p.locator('.card').nth(3), 1100); await h.holdUntil(0.62); await h.hover(p.locator('.card').nth(4), 1100); await h.holdUntil(0.92); } },
    { az: 'İndi ekranın ən faydalı hissəsi — tapşırıqlar. Sistem bütün bölmələri özü gəzir və sizdən qərar gözləyən işləri bir siyahıya toplayır. Siz heç bir bölməni əl ilə yoxlamırsınız.',
      do: async (p, l, h) => { await h.scrollTo('h3'); await h.holdUntil(0.4); await h.moveTo('table'); await h.holdUntil(0.9); } },
    { az: 'Sol tərəfdəki nişan işin adını deyir: zərfləri aç, sifarişi təsdiqlə, qalibi seç, çatdırılmanı qəbul et. Yanında obyektin nömrəsi, adı, məbləği və tarixi var.',
      do: async (p, l, h) => { const r = p.locator('table tbody tr'); await h.moveTo(r.nth(0).locator('.badge')); await h.holdUntil(0.35); await h.moveTo(r.nth(1).locator('.badge')); await h.holdUntil(0.65); await h.moveTo(r.nth(1).locator('td').nth(1)); await h.holdUntil(0.92); } },
    { az: 'Sətrin sonunda «Aç» düyməsi var. Əvvəl orada yalnız ox dururdu — nişan işin adını deyirdi, basmaq lazım olan şey isə ekranın o biri başında idi və sözsüz. İndi düymə özü deyir ki, nə edəcək.',
      do: async (p, l, h) => { const r = p.locator('table tbody tr').nth(0); await h.moveTo(r); await h.holdUntil(0.45); await h.hover(r.locator('a.btn').last(), 1200); await h.holdUntil(0.92); } },
    { az: 'Düymə sizi düz lazım olan yerə aparır: sorğular siyahısına, tenderin kartına və ya müqavilələrə. Axtarmaq lazım gəlmir. İş görüləndən sonra sətir siyahıdan çıxır, ona görə boş siyahı — hər şeyin nəzarətdə olmasının ən sadə göstəricisidir.',
      do: async (p, l, h) => { await h.moveTo(p.locator('table tbody tr').last()); await h.holdUntil(0.5); await h.moveTo('table'); await h.holdUntil(0.9); } },
    { az: 'Aşağıda bildirişlər var və onlar sifariş üzrə qruplaşdırılıb: bir sifarişin bütün hadisələri — qaimə, status dəyişikliyi, qəbul, dəyişiklik qərarı — bir blokda durur. Əvvəl onlar vaxt üzrə dağınıq idi və «bu sifarişə nə oldu» sualı bütün siyahını oxumaq tələb edirdi.',
      do: async (p, l, h) => { await h.scrollTo('h3:text-is("Bildirişlər")'); await h.holdUntil(0.4); await h.moveTo('.card:has(h3:text-is("Bildirişlər")) table'); await h.holdUntil(0.92); } },
    { az: 'Hər bildirişi oxunmuş kimi işarələmək olar, yaxud hamısını birdən. Bildirişlər həm də e-poçtla gedir, ona görə sistemi bütün gün açıq saxlamağa ehtiyac yoxdur.',
      do: async (p, l, h) => { const c = p.locator('.card:has(h3:text-is("Bildirişlər"))'); const all = c.locator('button.btn').first(); if (await all.count()) await h.hover(all, 1200); await h.holdUntil(0.5); const one = c.locator('table button.btn').first(); if (await one.count()) await h.moveTo(one); await h.holdUntil(0.92); } },
    { az: 'Və nəhayət büdcə xəbərdarlığı. Hansısa şöbə planını aşarsa, bu barədə xəbər ilk növbədə burada, ön səhifədə görünür — hansı şöbə, hansı büdcə, nə qədər və faizlə. Yanında büdcələr bölməsinə keçid olur, beləliklə aşım gizli qalmır.',
      // The warning card exists only while something IS over plan. Pointing at a card
      // that is not there spends the whole scene on a motionless screen, so fall back to
      // the figures the page always has.
      do: async (p, l, h) => { await h.scrollTo('h1'); await h.holdUntil(0.3); const warn = p.locator('.card:has(a[href="/buyer/budgets"])').first(); if (await warn.count()) { await h.moveTo(warn); await h.holdUntil(0.65); await h.moveTo(warn.locator('a[href="/buyer/budgets"]')); } else { await h.moveTo(p.locator('.card').nth(0)); await h.holdUntil(0.65); await h.moveTo(p.locator('.card').nth(1)); } await h.holdUntil(0.92); } },
    // Ends on a real press. A navigation leaves the stand exactly as it was, which is why
    // it is the action this section gets: marking notifications read would empty this very
    // panel for every other recording made against the same stand.
    { az: 'Və indi göstərək, bu necə işləyir. Tapşırıq sətrindəki «Aç» düyməsini basırıq — və sistem bizi düz lazım olan yerə aparır, axtarmağa ehtiyac qoymadan. Panelin bütün mənası budur: siz bölmələri gəzmirsiniz, iş özü sizi çağırır.',
      do: async (p, l, h) => { await h.scrollTo('h3:text-is("Tapşırıqlar")'); await h.holdUntil(0.25); const open = p.locator('.card:has(h3:text-is("Tapşırıqlar")) tbody tr a.btn').first(); if (await open.count()) { await h.moveTo(open); await h.holdUntil(0.45); await h.click(open, 2000); await p.waitForSelector('h1', { timeout: 15000 }); await h.holdUntil(0.8); await h.moveTo('h1'); } else { await h.moveTo('table'); } await h.holdUntil(0.95); } },
  ]},
  // Requests. The pass changed this screen most: the table gained the author and the
  // method columns (separation of duties is visible now), and the four procedure
  // buttons became ONE dropdown with the policy's own choice preselected.
  // ГЛАВА 1 истории: новый сотрудник заводит заявку, согласующий её утверждает.
  //
  // Один экран, два актёра — ровно то, ради чего съёмщик научился писать раздел несколькими
  // прогонами: заявку в продукте заводит BUYER_USER, а утверждает BUYER_APPROVER, и снимать
  // оба действия администратором значило бы показывать не то, что увидит зритель на своём
  // месте (у администратора на этом экране есть кнопки, которых у автора заявки нет).
  //
  // Сцены, которые СОЗДАЮТ данные, помечены `must`. Для экскурсии промах стоил одну
  // неподвижную сцену; здесь он стоит всю историю: если заявка не создалась, в следующей
  // главе нечего объявлять тендером. Поэтому они берут цели через need/needClick/needFill —
  // промах обрывает прогон с именем сцены.
  'buyer-requests': { role: 'requester', path: '/buyer/requests', scenes: [
    { az: 'Hər satınalma sorğudan başlayır. Mən Əməliyyat şöbəsində yeni işçiyəm, satış şöbəsinə mebel lazımdır. Reyestr boşdur: bu, sistemdə ilk gündür.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.45); await h.moveTo('.card'); await h.holdUntil(0.92); } },
    { az: 'Formanı «Yeni sorğu» düyməsi açır. Başlıq bir cümlədə nəyin və nə üçün alındığını deyir — təsdiqləyən ilk olaraq məhz bunu oxuyur.',
      must: true,
      do: async (p, l, h) => { await h.needClick('[data-testid=req-new]', '«Yeni sorğu» düyməsi', 700); await h.holdUntil(0.35); await h.needFill('[data-testid=req-title]', STORY.title, 'Başlıq'); await h.holdUntil(0.95); } },
    { az: 'Kateqoriya iki şeyi həll edir: pul hansı büdcədən gedəcək və satınalma hansı metodla olacaq. Şöbəni boş buraxıram — sistem mənim öz şöbəmi qoyur.',
      must: true,
      do: async (p, l, h) => { await h.needFill('[data-testid=req-category]', STORY.category, 'Kateqoriya'); await h.holdUntil(0.55); await h.need('[data-testid=req-department]', 'Şöbə sahəsi'); await h.moveTo('[data-testid=req-department]'); await h.holdUntil(0.95); } },
    { az: 'Mövqelər: ad, say və vahid qiymətin smetası. İkinci sətri «Mövqelər» düyməsi əlavə edir. Cəm aşağıda özü yığılır — mən onu yazmıram, server hesablayır.',
      must: true,
      do: async (p, l, h) => {
        await h.needFill('[data-testid=item-name-0]', STORY.items[0].name, 'birinci mövqenin adı');
        await h.needFill('[data-testid=item-qty-0]', STORY.items[0].qty, 'birinci mövqenin sayı');
        await h.needFill('[data-testid=item-price-0]', STORY.items[0].price, 'birinci mövqenin qiyməti');
        await h.holdUntil(0.45);
        await h.needClick('form button.ghost', '«Mövqelər» düyməsi', 500);
        await h.needFill('[data-testid=item-name-1]', STORY.items[1].name, 'ikinci mövqenin adı');
        await h.needFill('[data-testid=item-qty-1]', STORY.items[1].qty, 'ikinci mövqenin sayı');
        await h.needFill('[data-testid=item-price-1]', STORY.items[1].price, 'ikinci mövqenin qiyməti');
        await h.moveTo('[data-testid=req-total]'); await h.holdUntil(0.96);
      } },
    { az: 'Yarat — sorğu qaralama kimi yazılır və nömrə alır. Altmış dörd min manat: bu rəqəm sorğunun taleyini həll edir, çünki metodu məbləğ seçir.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick('form button.btn:not(.ghost):not([type=button])', '«Yarat» düyməsi', 1500);
        const row = await h.need(ROW, 'yeni sorğunun sətri');
        await h.scrollTo(row); await h.holdUntil(0.5);
        await h.moveTo(row.locator('td').nth(0)); await h.holdUntil(0.7);
        await h.moveTo(row.locator('td.num').first()); await h.holdUntil(0.96);
      } },
    { az: 'Göndər — sorğu təsdiqə gedir. Mənim sətirimdə təsdiq düyməsi yoxdur: öz sorğusunu heç kim təsdiqləyə bilməz, bu qayda sistemin özündədir.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick(`${ROW} [data-testid=req-submit]`, '«Göndər» düyməsi', 1400);
        await h.need(`${ROW} .badge.SUBMITTED`, 'göndərilmiş statusu');
        // Обратная проверка: сцена УТВЕРЖДАЕТ, что у автора кнопки согласования нет. Если
        // она появится, запись расскажет неправду — поэтому прогон обрывается здесь.
        if (await p.locator(`${ROW} [data-testid=req-approve]`).count()) {
          throw new Error('у автора заявки есть кнопка утверждения — озвучка говорит обратное');
        }
        await h.moveTo(`${ROW} .badge`); await h.holdUntil(0.6);
        await h.moveTo(`${ROW} td:last-child`); await h.holdUntil(0.96);
      } },
    { as: 'approver',
      az: 'Eyni ekran, təsdiqləyənin gözü ilə. Sorğu onu gözləyir, və bu sətirdə «Təsdiqlə» düyməsi var — çünki sorğunu o yazmamışdır.',
      must: true,
      do: async (p, l, h) => {
        const row = await h.need(ROW, 'təsdiq gözləyən sorğu');
        await h.scrollTo(row); await h.holdUntil(0.4);
        await h.moveTo(row.locator('.badge')); await h.holdUntil(0.65);
        await h.need(`${ROW} [data-testid=req-approve]`, '«Təsdiqlə» düyməsi');
        await h.hover(`${ROW} [data-testid=req-approve]`, 1300); await h.holdUntil(0.96);
      } },
    { as: 'approver',
      az: 'Birinci klik təsdiq etmir, sorğunun içini açır: mövqelər, qiymətlər və büdcəyə təsiri — hansı plandan nə qədər gedəcək və faiz neçə olacaq.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick(`${ROW} [data-testid=req-approve]`, '«Təsdiqlə» düyməsi', 1600);
        const inside = await h.need('tbody tr td[colspan]', 'açılmış sorğunun içi');
        await h.scrollTo(inside); await h.holdUntil(0.4);
        await h.moveTo(inside.locator('table')); await h.holdUntil(0.66);
        const impact = await h.need('tbody tr td[colspan] b', 'büdcəyə təsiri');
        await h.moveTo(impact); await h.holdUntil(0.96);
      } },
    { as: 'approver',
      az: 'İkinci klik — təsdiq. Metod sütununda RFQ yazılır: məbləğ birbaşa sifariş həddindən yuxarıdır, deməli qapalı tender olacaq. Növbəti addım satınalma mütəxəssisindədir.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick(`${ROW} [data-testid=req-approve]`, '«Təsdiqi təsdiq et» düyməsi', 1800);
        await h.need(`${ROW} .badge.APPROVED`, 'təsdiqlənmiş statusu');
        await h.moveTo(`${ROW} .badge`); await h.holdUntil(0.45);
        await h.moveTo(`${ROW} td:nth-child(9)`); await h.holdUntil(0.7);
        await h.need(`${ROW} [data-testid=req-announce]`, '«Elan et» düyməsi');
        await h.hover(`${ROW} [data-testid=req-announce]`, 1300); await h.holdUntil(0.96);
      } },
  ]},
  // ГЛАВА 2 истории: закупщик превращает утверждённую заявку в закрытый тендер.
  //
  // Начинается НЕ на своей странице, а на заявках: тендер в продукте рождается из заявки, и
  // первая кнопка истории — «Elan et» в её строке. Виджет на /buyer/events проигрывает эту
  // запись, и первые секунды показывают, откуда тендер берётся.
  //
  // Приглашаются ДВА поставщика: с одной ставкой тендер не показывает ни сравнения, ни
  // экономии, а присуждение единственной ставке продукт требует обосновывать письменно —
  // то есть одна ставка сняла бы совсем другую сцену.
  'buyer-events': { role: 'buyer', path: '/buyer/requests', scenes: [
    { az: 'Təsdiqlənmiş sorğu indi satınalma mütəxəssisindədir. Mənim işim onu tenderə çevirməkdir, və bu, sətirdəki «Elan et» düyməsindən başlayır.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.3); await h.moveTo(`${ROW} td:nth-child(2)`); await h.holdUntil(0.6); await h.hover(`${ROW} [data-testid=req-announce]`, 1300); await h.holdUntil(0.95); } },
    { az: 'Düymə prosedur seçimini açır: altı variant, hər biri öz izahı ilə. Siyasət altmış dörd min manat üçün qapalı tenderi seçib, ona görə o əvvəlcədən işarələnib.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick(`${ROW} [data-testid=req-announce]`, '«Elan et» düyməsi', 1200);
        await h.need('[role=dialog] [data-testid=dialog-input]', 'prosedur seçimi pəncərəsi');
        // Варианты адресуются значением радиокнопки, а не подписью: подпись переводится,
        // значение — это сама процедура.
        await h.moveTo('.pick:has(input[value="RFQ"])'); await h.holdUntil(0.45);
        await h.moveTo('.pick:has(input[value="OPEN"])'); await h.holdUntil(0.68);
        await h.moveTo('.pick:has(input[value="AUCTION"])'); await h.holdUntil(0.95);
      } },
    { az: 'Qapalı tender o deməkdir ki, qiymətlər möhürlənir: son tarixə qədər onları heç kim görmür, mən də. Təsdiq edirəm — sistem tenderi yaradır və kartını açır.',
      must: true,
      do: async (p, l, h) => {
        await h.moveTo('.pick:has(input[value="RFQ"])'); await h.holdUntil(0.3);
        await h.needClick('[data-testid=dialog-confirm]', 'təsdiq düyməsi', 1200);
        await p.waitForURL(/\/buyer\/events\/[0-9a-f-]{36}/, { timeout: 15000 });
        await h.need(`h1:has-text("${STORY.title}")`, 'tenderin kartı');
        await h.moveTo('h1'); await h.holdUntil(0.7);
        await h.need('h1 .badge.DRAFT', 'qaralama statusu');
        await h.moveTo('h1 .badge'); await h.holdUntil(0.95);
      } },
    { az: 'Kart tenderin şərtlərini saxlayır: son tarix, kimlərin buraxıldığı və qiymətləndirmə valyutası. Mövqelər sorğudan olduğu kimi köçüb — mən onları yenidən yazmıram.',
      do: async (p, l, h) => {
        const facts = p.locator('.fact');
        await h.moveTo(facts.nth(0)); await h.holdUntil(0.25);
        await h.hover(facts.nth(1), 1100); await h.holdUntil(0.5);
        await h.scrollTo('table'); await h.moveTo('tbody tr'); await h.holdUntil(0.95);
      } },
    { az: 'Dəvət siyahısı şəbəkənin təchizatçılarından yığılır. İki nəfəri dəvət edirəm: rəqabət olmasa, tender tender deyil — müqayisə ediləsi bir şey qalmır.',
      must: true,
      do: async (p, l, h) => {
        await h.scrollTo('[data-testid=ev-invite-select]');
        if (!await selectByPrefix(p, '[data-testid=ev-invite-select]', STORY.supplier)) {
          throw new Error(`в списке приглашения нет «${STORY.supplier}»`);
        }
        await h.needClick('[data-testid=ev-invite]', '«Dəvət et» düyməsi', 1100);
        await h.holdUntil(0.55);
        if (!await selectByPrefix(p, '[data-testid=ev-invite-select]', STORY.supplier2)) {
          throw new Error(`в списке приглашения нет «${STORY.supplier2}»`);
        }
        await h.needClick('[data-testid=ev-invite]', '«Dəvət et» düyməsi', 1100);
        await h.holdUntil(0.95);
      } },
    { az: 'Elan et — tender açılır, saat işləməyə başlayır. Aşağıda dəvət olunanların siyahısı göründü: hər ikisi tenderi öz vitrinində görür və xatırlatmaların zənciri də onlara bağlanıb.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick('[data-testid=ev-publish]', '«Elan et» düyməsi', 1800);
        await h.need('h1 .badge.OPEN', 'açıq statusu');
        await h.moveTo('h1 .badge'); await h.holdUntil(0.35);
        // Доказательство приглашения: карточка напоминаний перечисляет приглашённых по
        // имени. До публикации приглашение на экране не видно вообще — приглашать можно и
        // в черновике, а показать его тут нечем.
        const fu = await h.need(`.card:has(h3) tbody tr:has-text("${STORY.supplier}")`, `dəvət olunan ${STORY.supplier}`);
        await h.need(`tbody tr:has-text("${STORY.supplier2}")`, `dəvət olunan ${STORY.supplier2}`);
        await h.scrollTo(fu); await h.holdUntil(0.7);
        await h.moveTo(fu); await h.holdUntil(0.95);
      } },
    { az: 'Tenderlər siyahısında sətir göründü: metod, status, son tarix və gələn təkliflərin sayı. Məbləğ sütunu yoxdur — möhür açılana qədər rəqəm sadəcə mövcud deyil.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick('a[href="/buyer/events"]', 'yan paneldə «Tenderlər»', 1500);
        await h.need(ROW, 'tenderin sətri');
        await h.moveTo(`${ROW} td:nth-child(2)`); await h.holdUntil(0.4);
        await h.moveTo('thead th:nth-child(5)'); await h.holdUntil(0.7);
        await h.moveTo(`${ROW} .badge`); await h.holdUntil(0.95);
      } },
  ]},
  // ГЛАВА 5 истории: срок истёк — вскрытие, оценка, присуждение.
  //
  // `before` двигает срок в прошлое и закрывает тендер ТОЙ ЖЕ функцией, что и расписание:
  // сутки в записи не ждут, но и статус руками не ставят.
  'buyer-opening': { role: 'buyer', path: '/buyer/events',
    before: async () => {
      standSql(`UPDATE sourcing_events SET close_at = now() - interval '2 minutes'
                 WHERE title = '${STORY.title}' AND status = 'OPEN';`);
      const closed = standSql('SELECT count(*) FROM close_due_events();');
      if (closed === '0') throw new Error('тендер не закрылся: close_due_events() не вернула ни одной строки');
    },
    scenes: [
    { az: 'Son tarix keçdi, və tenderi vaxt bağladı, adam yox: siyahıda status artıq «Bağlanıb»dır. Sondan sonra gələn təklif gec sayılır və qiymətləndirməyə düşmür.',
      must: true,
      do: async (p, l, h) => { await h.need(`${ROW} .badge.CLOSED`, 'bağlanmış status'); await h.moveTo(`${ROW} td:nth-child(2)`); await h.holdUntil(0.5); await h.moveTo(`${ROW} .badge`); await h.holdUntil(0.95); } },
    { az: 'Kartı açıram. Bağlanmış tenderdə yeni düymə var: «Zərfləri aç». Bu, geri dönüşü olmayan addımdır və jurnalda iz qoyur.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick(`${ROW} a`, 'tenderin başlığı', 1500);
        await p.waitForURL(/\/buyer\/events\/[0-9a-f-]{36}/, { timeout: 15000 });
        await h.need('[data-testid=ev-open-bids]', '«Zərfləri aç» düyməsi');
        await h.hover('[data-testid=ev-open-bids]', 1300); await h.holdUntil(0.95);
      } },
    { az: 'Açıram. Məbləğlər yalnız indi göründü: əlli səkkiz min və altmış bir min manat. Smeta altmış dörd min idi — hər iki təklif ondan aşağıdır.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick('[data-testid=ev-open-bids]', '«Zərfləri aç» düyməsi', 2200);
        await h.need('h1 .badge.EVALUATION', 'qiymətləndirmə statusu');
        const bids = await h.need(`tbody tr:has-text("${STORY.supplier}")`, 'açılmış təkliflər');
        await h.scrollTo(bids); await h.holdUntil(0.55);
        await h.moveTo(bids.locator('td.num').first()); await h.holdUntil(0.95);
      } },
    { az: 'Meyarlar tenderin yaradılması anında kilidlənib: qiymət yetmiş faiz, çatdırılma otuz. Qiymətləri görəndən sonra çəkiləri dəyişmək oyunun qaydasını oyunun ortasında dəyişmək olardı — ona görə sistem buna icazə vermir.',
      do: async (p, l, h) => { await h.moveTo(`tbody tr:has-text("${STORY.supplier}") label`); await h.holdUntil(0.5); await h.moveTo(`tbody tr:has-text("${STORY.supplier2}") label`); await h.holdUntil(0.95); } },
    { az: 'Hər təklifə hər meyar üzrə bal verirəm. Supply One qiymətdə də, müddətdə də qabaqdadır.',
      must: true,
      do: async (p, l, h) => {
        const score = async (sup, crit, val) =>
          h.needFill(`tbody tr:has-text("${sup}") label:has-text("${crit}") input`, val, `${sup} · ${crit}`);
        await score(STORY.supplier, 'price', '95');
        await score(STORY.supplier, 'delivery', '85');
        await h.holdUntil(0.55);
        await score(STORY.supplier2, 'price', '85');
        await score(STORY.supplier2, 'delivery', '70');
        await h.holdUntil(0.95);
      } },
    { az: 'Qiymətləndir — sistem çəkili balı özü hesablayır və sütunda göstərir: doxsan iki və səksən yarım.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick('[data-testid=ev-score]', '«Qiymətləndir» düyməsi', 2000);
        await h.need(`tbody tr:has-text("${STORY.supplier}") td.num:has-text("92")`, 'çəkili bal');
        await h.moveTo(`tbody tr:has-text("${STORY.supplier}") td.num:has-text("92")`); await h.holdUntil(0.6);
        await h.moveTo(`tbody tr:has-text("${STORY.supplier2}") td.num:has-text("80")`); await h.holdUntil(0.95);
      } },
    { az: 'Tövsiyə sıralamanı izah edir: qiymət, çatdırılma və keçmiş icra üzrə ballar, və niyə məhz bu təklif. Bu, məsləhətdir — qərar mənimdir.',
      must: true,
      do: async (p, l, h) => {
        await h.scrollTo('[data-testid=ev-ai-run]');
        await h.needClick('[data-testid=ev-ai-run]', '«Tövsiyə» düyməsi', 2500);
        const reco = await h.need(`tbody tr:has-text("${STORY.supplier}") [data-testid=ev-award]`, 'tövsiyə cədvəli');
        await h.scrollTo(reco); await h.holdUntil(0.7);
        await h.moveTo(reco); await h.holdUntil(0.95);
      } },
    { az: 'Qalibi seçirəm və qərarı sözlə yazıram: əsaslandırma jurnalda qalır. Ən yaxşı təklifə verəndə izah məcburi deyil; başqasına versəydim, sistem onu tələb edərdi.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick(`tbody tr:has-text("${STORY.supplier}") [data-testid=ev-award]`, '«Ver» düyməsi', 1200);
        await h.needFill('[data-testid=dialog-input]', 'Ən aşağı qiymət və ən yüksək çəkili bal', 'əsaslandırma');
        await h.needClick('[data-testid=dialog-confirm]', 'təsdiq düyməsi', 2200);
        await h.need('h1 .badge.AWARDED', 'qalib seçilmiş status');
        await h.moveTo('h1 .badge'); await h.holdUntil(0.95);
      } },
    { az: 'Tender bitdi: qalib, məbləğ və lot göründü. İndi kartda «Müqavilə yarat» düyməsi var — növbəti addım onun arxasındadır.',
      must: true,
      do: async (p, l, h) => {
        const win = await h.need(`tbody tr:has-text("${STORY.supplier}") .badge.AWARDED`, 'qalib nişanı');
        await h.scrollTo(win); await h.moveTo(win); await h.holdUntil(0.5);
        const mk = await h.need('[data-testid=ev-make-contract]', '«Müqavilə yarat» düyməsi');
        await h.scrollTo(mk); await h.hover(mk, 1300); await h.holdUntil(0.95);
      } },
  ]},
  'buyer-contracts': { role: 'buyer', path: '/buyer/contracts', scenes: [
    { az: 'Müqavilələr bölməsi. Müqavilə tenderin nəticəsindən doğulur: qalib seçiləndən sonra sistem qalib təklifin şərtlərini müqaviləyə köçürür. Yəni buradaki rəqəmlər əl ilə yazılmır, təklifdən gəlir.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.45); await h.moveTo(p.locator('.card').nth(0).locator('table')); await h.holdUntil(0.9); } },
    { az: 'Sütunlar: nömrə, başlıq, təchizatçı, qüvvədə olma müddəti, ümumi məbləğ, istifadə olunmuş hissə, status və bu müqavilə üzrə verilmiş sifarişlərin sayı. Ümumi məbləğ müqavilənin tavanıdır.',
      do: async (p, l, h) => { const th = p.locator('.card').nth(0).locator('thead th'); await h.moveTo(th.nth(0)); await h.holdUntil(0.3); await h.moveTo(th.nth(3)); await h.holdUntil(0.6); await h.moveTo(th.nth(4)); await h.holdUntil(0.95); } },
    { az: 'İstifadə olunub sütunu tavana nə qədər yaxınlaşdığınızı göstərir. Çərçivə müqaviləsi bir neçə sifarişə bölünə bilər, ona görə sistem cəmi izləyir. Tavanı keçəndə rəqəm qırmızı olur və yanında xəbərdarlıq nişanı çıxır — amma sifariş bloklanmır, çünki bu, qanuni haldır.',
      do: async (p, l, h) => { const th = p.locator('.card').nth(0).locator('thead th'); await h.hover(th.nth(5), 1500); await h.holdUntil(0.6); await h.moveTo(p.locator('.card').nth(0).locator('tbody tr').first().locator('td').nth(5)); await h.holdUntil(0.95); } },
    { az: 'Status vacibdir. Yalnız aktiv müqavilə sifariş və kataloq buraxa bilir. Qaralama müqavilə hələ heç nəyə icazə vermir — əvvəlcə «Aktivləşdir» düyməsini basmaq lazımdır.',
      do: async (p, l, h) => { await h.hover(p.locator('.card').nth(0).locator('.badge').first(), 1300); await h.holdUntil(0.55); const a = p.locator('button:text-is("Aktivləşdir")').first(); if (await a.count()) await h.hover(a, 1200); await h.holdUntil(0.95); } },
    { az: 'Aktiv müqavilədə iki düymə görünür. «Sifariş yarat» müqavilədən konkret sifariş çıxarır: mövqelər və qiymətlər müqavilədən götürülür. «Kataloqlar» düyməsi isə həmin razılaşdırılmış qiymətlərdən kataloq yaradır — təkrarlanan xırda alışlar üçün.',
      do: async (p, l, h) => { const po = p.locator('button:text-is("Sifariş yarat")').first(); if (await po.count()) { await h.hover(po, 1400); await h.holdUntil(0.6); await h.hover(p.locator('button:has-text("Kataloqlar")').first(), 1200); } else { await h.moveTo(p.locator('.card').nth(0).locator('tbody tr').first()); } await h.holdUntil(0.95); } },
    { az: 'Aşağıda satınalma sifarişləri. Əvvəl bu cədvəlin öz başlığı səhifənin başlığı qədər böyük idi — bir ekranda iki baş başlıq. İndi o, öz kartının içindədir.',
      do: async (p, l, h) => { await h.scrollTo('h3:has-text("Satınalma sifarişləri")'); await h.holdUntil(0.45); await h.moveTo('.card:has(h3:has-text("Satınalma sifarişləri")) table'); await h.holdUntil(0.9); } },
    { az: 'Hər sifarişin öz həyat dövrü var: verilib, təchizatçı təsdiqləyib, qablaşdırılıb, göndərilib, çatdırılıb və nəhayət qəbul edilib. Statusun üzərinə gətirsəniz, hər birinin nə demək olduğu yazılır.',
      do: async (p, l, h) => { const rows = p.locator('.card:has(h3:has-text("Satınalma sifarişləri")) tbody tr'); await h.hover(rows.nth(0).locator('.badge'), 1300); await h.holdUntil(0.5); await h.hover(rows.nth(1).locator('.badge'), 1100); await h.holdUntil(0.92); } },
    { az: 'Əməliyyatlar sütunu bu məhsulda ən genişidir: bir sifariş iki irəli addım, qəbul, dəyişiklik və iki dayandırma təklif edə bilir. Hamısı sətirdə dursaydı, düymələr sütuna yığılıb sətri üç qat hündür edərdi. Ona görə sətirdə sifarişi irəli aparan addım qalır — oxucunun gəldiyi şey elə odur — qalanı isə «Daha çox» menyusunda, dayandırmalar orada da ən sonda, ayırıcıdan sonra.',
      do: async (p, l, h) => { const poDraft = '.card:has(h3:has-text("Satınalma sifarişləri")) tbody tr:has(.badge.DRAFT)'; if (await p.locator(poDraft).count()) { await h.moveTo(p.locator(poDraft).first().locator('button').first()); await h.holdUntil(0.45); const stop = await openRowMenu(p, poDraft, 'Ləğv et', h); if (stop) { await h.holdUntil(0.75); await h.moveTo(stop); } await closeRowMenu(p); } else { await h.moveTo('table'); } await h.holdUntil(0.92); } },
    { az: 'Ən vacib addım qəbuldur, və indi onun öz adı var: «Mal qəbulu» düyməsi gələn malı rəsmiləşdirir. Yanındakı «Qəbul et» isə sifarişin statusunu dəyişir — əvvəl hər ikisi eyni sözlə yazılırdı və sətirdə yan-yana dururdu. Məhz qəbul edilmiş sifariş analitikada və büdcədə xərc kimi sayılır — göndərilmiş deyil, qəbul edilmiş.',
      do: async (p, l, h) => { // Two buttons, and until #99 they were both «Qəbul et» — so `has-text` (a substring
      // match) took whichever came first. «Mal qəbulu» is the goods receipt; the status step
      // is matched by `text-is`, which «Mal qəbulu» cannot satisfy.
      const r = p.locator('button:has-text("Mal qəbulu")').first(); if (await r.count()) { await h.hover(r, 1500); await h.holdUntil(0.6); const st = p.locator('button:text-is("Qəbul et")').first(); if (await st.count()) await h.moveTo(st); } else { await h.moveTo(p.locator('.card:has(h3:has-text("Satınalma sifarişləri")) tbody tr').last()); } await h.holdUntil(0.92); } },
    { az: 'Sifarişin şərtləri dəyişməlidirsə, «Dəyişdir» düyməsi dəyişiklik təklifi açır: say və ya qiymət, üstəgəl səbəb. Bu, birtərəfli düzəliş deyil — təchizatçı razılıq verməlidir, yalnız ondan sonra sifarişin məbləği yenidən hesablanır.',
      do: async (p, l, h) => { const am = await openRowMenu(p, '.card:has(h3:has-text("Satınalma sifarişləri")) tbody tr:has(.badge.ISSUED)', 'Dəyişdir', h); if (am) { await h.holdUntil(0.38); await h.click(am, 1600); await h.holdUntil(0.7); await h.moveTo(p.locator('.card:has(h3:has-text("Dəyişikliklər")) table').first()); } else { await h.wheel(200); } await h.holdUntil(0.92); } },
    { az: 'Köhnə və yeni dəyər tarixçədə saxlanılır, ona görə sifariş dəyişsə də, nəyin nəyə çevrildiyi həmişə görünür. Beləliklə zəncir tamamlanır: sorğu, tender, müqavilə, sifariş, qəbul və qaimə — istənilən xərci geriyə, konkret sorğuya qədər izləmək olar.',
      do: async (p, l, h) => { await h.wheel(-400); await h.holdUntil(0.45); await h.moveTo(p.locator('.card').nth(0).locator('table')); await h.holdUntil(0.92); } },
  ]},
  // Invoices: the last gate before money leaves. The stand carries all four outcomes at
  // once. The payment-due column was REMOVED in the pass (it stood empty on every row
  // in every org), so the status column is now the sixth cell, not the seventh.
  'buyer-invoices': { role: 'buyer', path: '/buyer/invoices', scenes: [
    { az: 'Qaimələr bölməsi. Bu, pul şirkətdən çıxmazdan əvvəlki son yoxlama nöqtəsidir. Təchizatçı sifariş üzrə qaimə verir, sistem isə onu dərhal üç mənbə ilə tutuşdurur: nə sifariş olunub, faktiki nə qəbul edilib və qaimədə nə yazılıb.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.4); await h.moveTo('table'); await h.holdUntil(0.95); } },
    { az: 'Sütunlar: qaimənin nömrəsi, hansı sifariş üzrə verildiyi, təchizatçı, qaimənin tarixi, ödəniş müddəti, məbləğ və status. Ödəniş müddəti bir müddət boş dayandığı üçün ümumiyyətlə götürülmüşdü — boş sütun söz vermiş olur. İndi o qaytarıldı, çünki tarixi təchizatçı özü göstərir.',
      do: async (p, l, h) => { const th = p.locator('thead th'); await h.moveTo(th.nth(1)); await h.holdUntil(0.3); await h.moveTo(th.nth(3)); await h.holdUntil(0.55); await h.moveTo(th.nth(4)); await h.holdUntil(0.78); await h.moveTo(th.nth(6)); await h.holdUntil(0.95); } },
    { az: 'Ödəniş müddəti hesablanmır, razılaşmadan gəlir: təchizatçı qaiməni göndərəndə həmin tarixi özü yazır, və sistem keçmiş tarixi qəbul etmir. Uydurulmuş rəqəm — məsələn «qaimə tarixi üstəgəl otuz gün» — həqiqi kimi görünərdi, halbuki belə razılaşma olmaya da bilər.',
      do: async (p, l, h) => { const rows = p.locator('tbody tr'); await h.moveTo(rows.nth(0).locator('td').nth(4)); await h.holdUntil(0.5); const n = await rows.count(); await h.moveTo(rows.nth(Math.min(1, n - 1)).locator('td').nth(4)); await h.holdUntil(0.95); } },
    { az: 'Statuslarda dörd hal var. «Uyğundur» — yoxlamadan keçib, qərar gözləyir. «Mübahisəli» — keçməyib. «Təsdiqlənib» — ödəniş gözləyir. «Ödənilib» — artıq bağlanmış xərc. Hər nişanın izahı özündədir.',
      do: async (p, l, h) => { const r = p.locator('tbody tr'); await h.hover(r.nth(0).locator('.badge').last(), 1200); await h.holdUntil(0.35); await h.hover(r.nth(1).locator('.badge').last(), 1100); await h.holdUntil(0.65); await h.hover(r.nth(2).locator('.badge').last(), 1100); await h.holdUntil(0.95); } },
    { az: 'Uyğun gələn qaimədən başlayaq. Nömrəyə klikləyirik və aşağıda təfərrüat açılır: məbləğ ƏDV-siz və ƏDV ayrıca. ƏDV dərəcəsi sifarişin hər sətrindən götürülür — düz on səkkiz faiz kimi yox, çünki sıfır dərəcəli mövqelər də olur.',
      do: async (p, l, h) => { await h.click('tbody tr:has-text("INV-2026-0002") a', 1500); await h.holdUntil(0.55); await h.scrollTo('.card:has(h3:has-text("INV-2026-0002"))'); await h.moveTo('.card:has(h3:has-text("INV-2026-0002")) .hint'); await h.holdUntil(0.95); } },
    { az: 'Aşağıdaki cədvəl yoxlamanın özüdür və dörd rəqəm üz-üzə durur: qaimədəki qiymət və sifarişdəki qiymət, qaimədəki miqdar və faktiki qəbul edilən miqdar. Sağdaki işarə sətrin keçib-keçmədiyini göstərir.',
      do: async (p, l, h) => { const t = p.locator('.card:has(h3:has-text("INV-2026-0002")) table'); await h.moveTo(t.locator('th').nth(0)); await h.holdUntil(0.28); await h.moveTo(t.locator('th').nth(1)); await h.holdUntil(0.5); await h.moveTo(t.locator('th').nth(3)); await h.holdUntil(0.72); await h.moveTo(t.locator('tbody tr').first()); await h.holdUntil(0.95); } },
    { az: 'İndi mübahisəli qaiməyə baxaq. Bunu bağlayıb növbətisini açırıq — başlıqdaki işarə dərhal xəbərdarlığa dəyişir.',
      do: async (p, l, h) => { await h.click('tbody tr:has-text("INV-2026-0002") a', 700); await h.holdUntil(0.3); await h.click('tbody tr:has-text("INV-2026-0003") a', 1500); await h.holdUntil(0.6); await h.scrollTo('.card:has(h3:has-text("INV-2026-0003"))'); await h.moveTo('.card:has(h3:has-text("INV-2026-0003")) h3'); await h.holdUntil(0.95); } },
    { az: 'Səbəb bir sətirdə görünür. Təchizatçı qaimədə qəbul ediləndən çox miqdar yazıb, üstəlik qiymət də sifarişdəkindən yüksəkdir. İki müstəqil yoxlama, ikisi də keçməyib — və bir sətir kifayətdir ki, bütün qaimə mübahisəli olsun.',
      do: async (p, l, h) => { const t = p.locator('.card:has(h3:has-text("INV-2026-0003")) table tbody tr').first(); await h.moveTo(t.locator('td').nth(2)); await h.holdUntil(0.3); await h.moveTo(t.locator('td').nth(3)); await h.holdUntil(0.55); await h.moveTo(t.locator('td').nth(0)); await h.holdUntil(0.75); await h.moveTo(t.locator('td').nth(1)); await h.holdUntil(0.95); } },
    { az: 'Vacib olan budur: mübahisəli qaimə əbədi bloklanmır. Onu təsdiqləmək olar, amma yalnız yazılı əsaslandırma ilə — düymənin izahı da elə bunu deyir. Sistem səbəbi soruşur və onu dəyişilməz jurnala yazır. Yəni istisna qadağan deyil, sadəcə anonim ola bilmir.',
      do: async (p, l, h) => { await h.scrollTo('tbody tr:has-text("INV-2026-0003")'); await h.holdUntil(0.3); const b = p.locator('tbody tr:has-text("INV-2026-0003") button.btn').first(); if (await b.count()) { await h.hover(b, 1800); } await h.holdUntil(0.95); } },
    { az: 'Çox vaxt isə heç nə etmək lazım deyil. Yoxlama canlıdır: təchizatçı malı çatmamış qaimə veribsə, qəbulu rəsmiləşdirən kimi sistem yoxlamanı özü yenidən aparır və qaimə bir klik olmadan uyğun statusuna keçir.',
      do: async (p, l, h) => { await h.moveTo(p.locator('tbody tr:has-text("INV-2026-0003") td').nth(6)); await h.holdUntil(0.5); await h.moveTo(p.locator('tbody tr:has-text("INV-2026-0002") td').nth(6)); await h.holdUntil(0.95); } },
    { az: 'Təsdiq və ödəniş ayrı addımlardır. Təsdiqlənmiş qaimədə «Ödə» düyməsi görünür — yəni «sənəd düzgündür» qərarı ilə «pulu köçürdük» qeydi bir-birinə qarışmır.',
      do: async (p, l, h) => { const pay = p.locator('button:has-text("Ödə")').first(); if (await pay.count()) { await h.hover(pay, 1600); } else { await h.moveTo(p.locator('tbody tr').nth(3).locator('td').nth(6)); } await h.holdUntil(0.95); } },
    { az: 'Ödənilmiş qaimə büdcə hesabatında ayrı sütunda görünir və faktiki xərcə toplanmır: qaimə artıq sayılmış sifarişi bağlayır, ona görə onu toplamaq eyni pulu iki dəfə saymaq olardı. Bütün qaimələri mühasibat üçün bir fayla çıxarmaq olar — bu, parametrlərdəki inteqrasiyalar kartındadır.',
      do: async (p, l, h) => { await h.scrollTo('h1'); await h.holdUntil(0.4); await h.moveTo('table'); await h.holdUntil(0.95); } },
  ]},
  'buyer-catalogs': { role: 'buyer', path: '/buyer/catalogs', scenes: [
    { az: 'Kataloqlar bölməsi. Kataloq — təchizatçı ilə razılaşdırılmış qiymət cədvəlidir. Təkrarlanan xırda alışlar üçün hər dəfə tender keçirmək mənasızdır, ona görə qiymətlər bir dəfə razılaşdırılır və sonra sadəcə sifariş verilir.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.45); await h.moveTo('table'); await h.holdUntil(0.9); } },
    { az: 'Cədvəldə kataloqun adı, təchizatçı, status və mövqelərin sayı var. Say sütununun öz izahı var, çünki rəqəm tək başına nəyin sayı olduğunu demir. Kataloq müqavilədən yaradılanda qiymətlər qalib təklifdən avtomatik köçürülür.',
      do: async (p, l, h) => { const th = p.locator('thead th'); await h.moveTo(th.nth(0)); await h.holdUntil(0.35); await h.moveTo(th.nth(1)); await h.holdUntil(0.62); await h.hover(th.nth(3), 1300); await h.holdUntil(0.93); } },
    { az: 'Status yalnız aktiv olanda sifariş vermək mümkündür. Qaralama kataloq hazırlıq mərhələsidir: mövqeləri yoxlayırsınız, sonra «Aktivləşdir» düyməsi ilə işə salırsınız. Təchizatçı eyni cədvəli görür, amma onda bu düymələr yoxdur.',
      do: async (p, l, h) => { await h.hover(p.locator('.badge').first(), 1300); await h.holdUntil(0.55); const a = p.locator('button:text-is("Aktivləşdir")').first(); if (await a.count()) await h.hover(a, 1200); await h.holdUntil(0.92); } },
    { az: 'Adına klikləyəndə kataloqun içi açılır. Gəlin baxaq.',
      do: async (p, l, h) => { await h.click(p.locator('tbody tr a').first(), 1500); await h.holdUntil(0.9); } },
    { az: 'Burada mövqelər var: ad, minimum sifariş həcmi və razılaşdırılmış vahid qiymət. Minimum həcm təchizatçının şərtidir — ondan az sifariş sistem qəbul etmir, və sütunun izahı da bunu deyir.',
      do: async (p, l, h) => { await h.scrollTo(p.locator('table').last()); await h.holdUntil(0.3); await h.hover(p.locator('th:has-text("Minimum sifariş")').first(), 1400); await h.holdUntil(0.65); await h.moveTo(p.locator('table').last().locator('tbody tr').first()); await h.holdUntil(0.93); } },
    { az: 'Sağda say sahəsi var. Lazım olan miqdarı yazırsınız — qiyməti sistem özü vurur. Qiyməti dəyişmək olmur, çünki o, razılaşdırılıb. Elə buna görə kataloq sifarişi danışıq tələb etmir.',
      do: async (p, l, h) => { const inp = p.locator('table').last().locator('input[type=number]').first(); if (await inp.count()) { await h.fill(inp, '5'); } else { await h.moveTo(p.locator('table').last()); } await h.holdUntil(0.93); } },
    { az: 'Sifariş verməzdən əvvəl şöbəni seçirsiniz. Bu vacibdir: kataloq sifarişinin arxasında sorğu yoxdur, ona görə şöbəni yalnız burada göstərmək olar. Boş buraxsanız, sistem sizin öz şöbənizi qoyur.',
      // The department select is the LAST one on the page (the open catalogue's card).
      // selectByPrefix takes a CSS string and would need a selector that resolves to one
      // element; a locator is cheaper and cannot pick the wrong card.
      do: async (p, l, h) => { const sel = p.locator('.card select').last(); if (await sel.count()) { await h.moveTo(sel); await h.holdUntil(0.5); const opt = sel.locator('option').filter({ hasText: 'OPS' }).first(); if (await opt.count()) await sel.selectOption(await opt.getAttribute('value')).catch(() => {}); } await h.holdUntil(0.92); } },
    { az: 'Sonra «Sifariş» düyməsi kataloqdan birbaşa sifariş yaradır — tendersiz, müqavilə danışıqlarısız. Bu, kataloqun bütün mənasıdır: iki klik və sifariş hazırdır. Biz onu indi basmırıq.',
      do: async (p, l, h) => { const b = p.locator('button:has-text("Sifariş")').last(); if (await b.count()) { await h.hover(b, 1600); } else { await h.moveTo(p.locator('.badge').first()); } await h.holdUntil(0.92); } },
    { az: 'Belə sifariş də büdcədən keçir, amma onun kateqoriyası yoxdur. Ona görə onu yalnız kateqoriyasız büdcə tuta bilər — şöbə səviyyəsində və ya bütün təşkilat üzrə. «IT» büdcəsi kataloq sifarişini səssizcə udmur, çünki o xərci heç kim təsnifləməyib.',
      do: async (p, l, h) => { await h.scrollTo('h1'); await h.holdUntil(0.4); await h.moveTo('table'); await h.holdUntil(0.92); } },
    { az: 'Şöbə də göstərilməyibsə, xərc «büdcədən kənar» hesabatına düşür və orada görünür. Yekunda: kataloq təkrarlanan alışları prosedurdan azad edir, amma nəzarəti saxlayır — qiymət razılaşdırılıb, minimum həcm qorunur, xərc isə düzgün büdcəyə yazılır.',
      do: async (p, l, h) => { await h.moveTo(p.locator('.badge').first()); await h.holdUntil(0.4); await h.moveTo('h1'); await h.holdUntil(0.7); await h.moveTo('table'); await h.holdUntil(0.92); } },
  ]},
  // Budgets: the section finance runs the company from. Both tables carry a data-testid
  // (budget-rollup, budget-list) — preferred here over a heading's text, because the
  // browser specs hold those ids and will move them together with the markup.
  'buyer-budgets': { role: 'buyer', path: '/buyer/budgets', scenes: [
    { az: 'Büdcələr bölməsi. Burada şirkətin xərc planı yaşayır: hansı şöbənin nə qədər pulu var, nə qədəri öhdəliyə gedib, nə qədəri real xərclənib və dövrün sonunda nə gözlənilir. Şöbələr üzrə yekun cədvəlindən başlayaq.',
      do: async (p, l, h) => { await h.scrollTo('[data-testid=budget-rollup]'); await h.holdUntil(0.4); await h.moveTo('[data-testid=budget-rollup] table'); await h.holdUntil(0.75); await h.moveTo(p.locator('[data-testid=budget-rollup] tbody tr').first()); await h.holdUntil(0.95); } },
    { az: 'Öhdəlik — təsdiqlənmiş, amma hələ sifariş verilməmiş sorğulardır: pul ayrılıb, hələ xərclənməyib. Faktiki isə artıq verilmiş sifarişlərdir. Sistem eyni xərci iki dəfə saymır: sifariş veriləndə məbləğ öhdəlikdən faktikiyə keçir.',
      do: async (p, l, h) => { const r = p.locator('[data-testid=budget-rollup] tbody tr').nth(1); await h.moveTo(r.locator('td').nth(2)); await h.holdUntil(0.45); await h.moveTo(r.locator('td').nth(3)); await h.holdUntil(0.8); await h.moveTo(r.locator('td').nth(4)); await h.holdUntil(0.95); } },
    { az: 'Ödəniş sütunu yanında durur, amma faktiki məbləğə toplanmır — və bu, qəsdəndir. Qaimə artıq sayılmış sifarişi bağlayır, ona görə onu toplamaq eyni pulu iki dəfə saymaq olardı. Sütunun izahı bunu açıq yazır, çünki sual hər dəfə verilir.',
      // The paid column's own bubble is GONE (#102) — it held 561 characters and opened as
      // a slab over three rows of figures. The same text is under the table behind
      // «Bu nə deməkdir?», so the scene opens it rather than hovering a cell that no
      // longer has a tip; the narration says this is written openly, and now it is. Closed
      // again at the end: an expanded panel pushes the budget list down for every scene
      // after this one.
      do: async (p, l, h) => { const r = p.locator('[data-testid=budget-rollup] tbody tr').first(); await h.moveTo(r.locator('td').nth(4)); await h.holdUntil(0.3); const ex = p.locator('[data-testid=budget-rollup] button.explain').first(); if (await ex.count()) { await h.click(ex, 1300); await h.holdUntil(0.88); await h.click(ex, 400); } else { await h.moveTo(r.locator('td').nth(5)); } await h.holdUntil(0.95); } },
    { az: 'Proqnoz sütunu ən çox soruşulan suala cavab verir: bu templə dövrün sonunda nə olacaq. Rəqəm qırmızıdırsa, plan aşılacaq. Yanında isə mənimsənilmə faizi və onun altında «planla indiyə qədər nə qədər olmalı idi» yazılır. Səksən faiz mayda və səksən faiz noyabrda tamam fərqli şeylərdir.',
      do: async (p, l, h) => { const rows = p.locator('[data-testid=budget-rollup] tbody tr'); await h.hover(rows.nth(0).locator('td').nth(6), 1500); await h.holdUntil(0.55); await h.moveTo(rows.nth(0).locator('td').nth(7)); await h.holdUntil(0.95); } },
    { az: 'Təqvim payının bir şərti var: o, xərcin il boyu bərabər getdiyini güman edir. Həqiqətdə isə belə olmur — istilik qışa düşür, texnika alışı ilin sonuna. Ona görə planı aylara bölmək olar. Sətirdə yalnız bir əməliyyat açıq durur — büdcənin öz vəziyyətinin gözlədiyi addım; qalanları «Daha çox» düyməsinin altındadır. Açırıq və «Aylar üzrə bölgü»nü seçirik.',
      do: async (p, l, h) => { await h.scrollTo('[data-testid=budget-list]'); await h.holdUntil(0.3); const ph = await openRowMenu(p, '[data-testid=budget-list] tbody tr:has(.badge.APPROVED)', 'Aylar üzrə bölgü', h); if (ph) { await h.holdUntil(0.6); await h.click(ph, 1600); } else { await h.moveTo('[data-testid=budget-list]'); } await h.holdUntil(0.95); } },
    { az: 'Hər ay üçün payı faizlə yazırsınız, altında dərhal məbləğ görünür. Cəmi mütləq yüz faiz olmalıdır — sistem yarımçıq bölgünü yadda saxlamır, çünki cəmi yüz olmayan plan plan deyil. Bölgünü silmək isə bərabər bölgüyə qaytarır.',
      // `tr:has-text(...)` matched the budget's OWN row first — the button is labelled
      // «📅 Aylar üzrə bölgü», so the text is on both rows and .first() took the wrong one,
      // whose inputs do not exist: boundingBox then waited out its full 20s and the scene
      // ran 25s past its narration. The opened panel is the row whose <b> IS that heading.
      // Guard on the input, not on the row, so a miss costs nothing instead of 20 seconds.
      do: async (p, l, h) => { const c = p.locator('tr:has(b:text-is("Aylar üzrə bölgü"))').first(); const inp = c.locator('input'); const months = await inp.count(); if (months) { await h.moveTo(inp.nth(0)); await h.holdUntil(0.35); await h.moveTo(inp.nth(Math.min(6, months - 1))); await h.holdUntil(0.65); await h.moveTo(c.locator('.hint').last()); } else { await h.moveTo('[data-testid=budget-list]'); } await h.holdUntil(0.95); } },
    { az: 'Bölgü veriləndən sonra tempin mənası dəyişir. İndi «planla nə qədər olmalı idi» sualına təqvim yox, sizin öz mövsümiliyiniz cavab verir — və payıza yığılmış büdcə yazda daha artıq xərclənmiş kimi görünmür. Yekun cədvəlində hansı sətrin bölgü ilə oxunduğu da bilinir.',
      do: async (p, l, h) => { await h.scrollTo('[data-testid=budget-rollup]'); await h.holdUntil(0.45); await h.hover(p.locator('[data-testid=budget-rollup] tbody tr').first().locator('td').nth(7), 1600); await h.holdUntil(0.95); } },
    { az: 'İndi ən vacib imkan: hər rəqəmin arxasına baxmaq olar. Öhdəlik və faktiki məbləğlər klikləniləndir — sistem göstərir, məhz hansı sənədlərdən ibarətdir. Maliyyəçinin istənilən cəm haqqında ilk sualı budur: nədən yığılıb.',
      do: async (p, l, h) => { await h.scrollTo('[data-testid=budget-list]'); await h.holdUntil(0.25); const cell = await firstNonZero(p, '[data-testid=budget-list] .linklike'); await h.click(cell, 1400); await h.holdUntil(0.75); await h.wheel(140); await h.holdUntil(0.95); } },
    { az: 'Siyahıda sənədin nömrəsi, adı, kateqoriyası, şöbəsi, tarixi və məbləği var. Bu siyahı həmişə yuxarıdaki rəqəmlə üst-üstə düşür, çünki eyni qayda ilə hesablanır — cədvəl ayrıca, rəqəm ayrıca yaşamır.',
      do: async (p, l, h) => { const inner = p.locator('[data-testid=budget-list] table table tbody tr'); if (await inner.count()) { await h.moveTo(inner.first()); await h.holdUntil(0.45); await h.moveTo(inner.last()); } else { await h.wheel(120); } await h.holdUntil(0.95); } },
    { az: 'Hər büdcənin öz statusu var və bu, adi cədvəl sətri deyil — büdcə sənəddir. Qaralama hazırlanır və hələ pul saxlamır. Təsdiq gözləyən redaktə üçün bağlıdır. Qüvvədə olandan xərc silinir. Bağlanmış dövr isə artıq dəyişmir.',
      do: async (p, l, h) => { await h.scrollTo('[data-testid=budget-list]'); await h.holdUntil(0.3); const b = p.locator('[data-testid=budget-list] tbody .badge'); await h.hover(b.first(), 1400); await h.holdUntil(0.65); await h.hover(b.nth(1), 1200); await h.holdUntil(0.95); } },
    { az: 'Qaralamanı «Göndər» düyməsi təsdiqə yollayır — o, sətirdə açıq durur, çünki qaralamanın gözlədiyi addım elə budur. Qalanları menyudadır: qaralamaya düzəliş, silmək, göndərilmişi geri almaq, təsdiqə gələni rədd etmək. Rədd səbəbi, geri açma səbəbi — hamısı yazılır.',
      do: async (p, l, h) => { const draft = '[data-testid=budget-list] tbody tr:has(.badge.DRAFT)'; await h.scrollTo('[data-testid=budget-list]'); await h.holdUntil(0.15); const sub = p.locator(draft).first().locator('button:text-is("Göndər")').first(); if (await sub.count()) { await h.hover(sub, 1300); } await h.holdUntil(0.5); const ed = await openRowMenu(p, draft, 'Düzəliş', h); if (ed) { await h.moveTo(ed); await h.holdUntil(0.72); const del = p.locator(draft).first().locator('.menu-pop button.danger').first(); if (await del.count()) await h.moveTo(del); await closeRowMenu(p); } await h.holdUntil(0.95); } },
    { az: 'Qüvvədə olan büdcənin adı, şöbəsi və dövrü artıq dəyişmir — bunlar təsdiqlənmiş şərtlərdir. Yalnız məbləğ düzəlir, özü də səbəb yazmadan yox. Saat düyməsi bütün düzəlişlərin tarixçəsini açır: tarix, məbləğ, fərq, səbəb və kimin etdiyi.',
      do: async (p, l, h) => { const hb = await openRowMenu(p, '[data-testid=budget-list] tbody tr:has(.badge.APPROVED)', 'Tarixçə', h); if (hb) { await h.holdUntil(0.45); await h.click(hb, 1500); await h.holdUntil(0.78); await h.wheel(130); } else { await h.moveTo('[data-testid=budget-list]'); } await h.holdUntil(0.95); } },
    { az: 'Xərclənməmiş qalığı başqa büdcəyə köçürmək olar — «Köçür» düyməsi ilə. Köçürmə hədəf büdcənin tarixçəsində mənbəyə istinad edən dəyişiklik kimi yazılır, yəni pulun haradan gəldiyi sonradan da görünür.',
      do: async (p, l, h) => { const ro = await openRowMenu(p, '[data-testid=budget-list] tbody tr:has(.badge.APPROVED)', 'Köçür', h); if (ro) { await h.holdUntil(0.5); await h.hover(ro, 1600); await closeRowMenu(p); } else { await h.moveTo('[data-testid=budget-list] tbody tr'); } await h.holdUntil(0.95); } },
    { az: 'Yeni büdcə «Yeni büdcə» düyməsi ilə yaradılır — forma həmişə açıq dayanmır, açaq. Ad, kateqoriya, şöbə və dövr. Şöbə boş qalsa, büdcə bütün təşkilata aid olur; konkret şöbə seçiləndə onun xərcləri məhz ora yazılır və şöbə büdcəsi ümumidən üstün olur.',
      do: async (p, l, h) => { await h.scrollTo('h1'); await h.holdUntil(0.18); await h.click('[data-testid=bud-new]', 900); await h.holdUntil(0.45); await h.fill(budField(p, 'Ad'), 'Marketinq 2026'); await h.holdUntil(0.75); await h.moveTo(budField(p, 'Şöbə', 'select')); await h.holdUntil(0.95); } },
    { az: 'Dövr illik, rüblük və ya aylıq ola bilər. Rüblük seçəndə sistem rüb nömrəsini soruşur və tarix aralığını özü hesablayır. Sonra məbləğ və səbəb: səbəb tarixçəyə düşür, ona görə «plan niyə belədir» sualı həmişə cavablı qalır.',
      do: async (p, l, h) => { await budField(p, 'Dövr', 'select').selectOption('QUARTER').catch(() => {}); await h.holdUntil(0.4); await h.fill(budField(p, 'Məbləğ'), '12000'); await h.holdUntil(0.72); await h.moveTo(p.locator('form button.btn').first()); await h.holdUntil(0.95); } },
    { az: 'Eyni şöbə, kateqoriya və dövrü əhatə edən iki büdcə yaratmaq mümkün deyil: baza özü imtina edir və ekran bunu insan dili ilə deyir. Səbəb sadədir — onda hər xərci hansı planın tutduğu bilinməz olardı.',
      do: async (p, l, h) => { await h.moveTo(budField(p, 'Ad')); await h.holdUntil(0.45); await h.moveTo(p.locator('form button.btn').first()); await h.holdUntil(0.95); } },
    { az: 'Büdcə hədləri parametrlərdə qurulur: xəbərdarlıq faizi və blok faizi. Xəbərdarlıq şöbənin sahibinə bildiriş göndərir. Blok həddi aşılanda sorğunun təsdiqi dayandırılır — amma blok həddi standart olaraq boşdur, yəni heç nə dayandırılmır, yalnız xəbərdarlıq gedir.',
      do: async (p, l, h) => { const link = p.locator('.main a[href="/buyer/settings"]').first(); if (await link.count()) { await h.hover(link, 1500); } else { await h.moveTo('h1'); } await h.holdUntil(0.95); } },
    { az: 'İki ixrac var və onlar fərqli işlər üçündür. CSV — insan üçün tam mənzərə: plan, öhdəlik, faktiki və qalıq. «1C üçün» isə mühasibat sistemi üçün: hər aya bir sətir, yalnız planlaşdırılan məbləğ, çünki faktlar mühasibatda onsuz da var. Yanında isə CSV-dən toplu idxal.',
      do: async (p, l, h) => { await h.scrollTo('button:has-text("CSV")'); await h.holdUntil(0.35); await h.moveTo(p.locator('button:has-text("CSV")').first()); await h.holdUntil(0.6); await h.hover(p.locator('button:has-text("1C")').first(), 1500); await h.holdUntil(0.95); } },
    { az: 'Ən aşağıda «büdcədən kənar xərc» kartı var: uyğun plan tapılmayan sorğular, kataloq sifarişləri və manatdan fərqli valyutadaki sifarişlər. Bu xərc yoxa çıxmır və uydurulmuş kursla çevrilmir — sadəcə ayrıca göstərilir, ona görə plan boşluğu gizli qalmır.',
      do: async (p, l, h) => { const un = p.locator('.card:has(h3:has-text("Büdcədən kənar"))'); if (await un.count()) { await h.scrollTo(un); await h.holdUntil(0.45); await h.moveTo(un.locator('table')); await h.holdUntil(0.75); await h.moveTo(un.locator('.hint').first()); } else { await h.wheel(300); } await h.holdUntil(0.95); } },
  ]},
  'buyer-analytics': { role: 'buyer', path: '/buyer/analytics', scenes: [
    { az: 'Analitika bölməsi. Burada pulun hara getdiyi görünür: aylar üzrə xərc, plan ilə müqayisə, büdcənin mənimsənilmə tempi, şöbələr, kateqoriyalar və təchizatçılar. Yuxarıdaki dörd yekundan başlayaq.',
      do: async (p, l, h) => { await p.waitForSelector('.chart-bar, .chart', { timeout: 15000 }).catch(() => {}); await h.moveTo(p.locator('.card').nth(0)); await h.holdUntil(0.45); await h.moveTo(p.locator('.card').nth(1)); await h.holdUntil(0.75); await h.moveTo(p.locator('.card').nth(2)); await h.holdUntil(0.95); } },
    { az: 'Hər yekunun altında bazası yazılıb: xərc və qənaət — ƏDV-siz, qaimələr isə ƏDV daxil. Ona görə ödənilmiş məbləğ bəzən xərcdən böyük görünə bilər. Bu, səhv deyil, sadəcə fərqli baza — və elə buna görə baza rəqəmin altında yazılır, izahda gizlənmir.',
      // The four figures' hints run to 229 characters and the bubble now keeps only the
      // first sentence (#102); the whole text — all four bases at once — sits under the
      // row behind «Bu nə deməkdir?». This scene is ABOUT the bases, so it opens that
      // instead of holding a mouse still over a bubble, and closes it again so the scenes
      // below stay framed as they were composed.
      do: async (p, l, h) => { await h.hover(p.locator('.card').nth(0), 1400); await h.holdUntil(0.38); await h.hover(p.locator('.card').nth(2), 1400); await h.holdUntil(0.62); const ex = p.locator('button.explain').first(); if (await ex.count()) { await h.click(ex, 1200); await h.holdUntil(0.9); await h.click(ex, 400); } await h.holdUntil(0.95); } },
    { az: 'Dövr seçimi yuxarıdadır. Hazır düymələr ən çox soruşulan üç sualı örtür: son on iki ay, cari rüb və ilin əvvəlindən. Başqa aralıq lazımdırsa, iki ay sahəsini əl ilə doldurmaq olar — onların da öz adı var, yalnız yer tutan mətn deyil.',
      do: async (p, l, h) => { await h.moveTo(p.locator('button:has-text("12 ay")').first()); await h.holdUntil(0.4); await h.click(p.locator('button:has-text("12 ay")').first(), 900); await h.holdUntil(0.7); await h.moveTo('#an-from'); await h.holdUntil(0.95); } },
    { az: 'Seçilmiş dövr bütün panellərə tətbiq olunur — təkcə qrafikə yox, həm də kateqoriyalara, şöbələrə və təchizatçılara. Valyuta da seçilir, çünki müxtəlif valyutadaki məbləğləri toplamaq olmaz.',
      do: async (p, l, h) => { await h.moveTo(p.locator('button:has-text("Rüb")').first()); await h.holdUntil(0.35); await h.click(p.locator('button:has-text("Rüb")').first(), 900); await h.holdUntil(0.65); await h.moveTo('[data-testid=analytics-currency]'); await h.holdUntil(0.95); } },
    { az: 'Qrafikdə üç şey var. Sütun — faktiki xərc, yəni yalnız qəbul edilmiş sifarişlər. Punktir xətt — həmin ayın planı: aylar üzrə bölgü verilibsə, ondan götürülür, yoxdursa büdcə dövrünə bərabər bölünür. Boz xətt isə keçən ilin həmin ayıdır.',
      do: async (p, l, h) => { await h.click(p.locator('button:has-text("12 ay")').first(), 900); await h.holdUntil(0.3); await h.scrollTo('.chart'); await h.moveTo('.chart'); await h.holdUntil(0.6); await h.moveTo('.chart-key'); await h.holdUntil(0.95); } },
    { az: 'Hər sütunun üzərinə gətirsəniz, həmin ayın üç rəqəmi birlikdə görünür: faktiki, plan və keçən il. Bu dövrdə heç bir sifariş qəbul edilməyibsə, qrafik boş qalmır — bunu sözlə deyir, çünki boş sahə həm «sıfır», həm «sınıb» kimi oxunur.',
      do: async (p, l, h) => { const bars = p.locator('.chart-bar'); const n = await bars.count(); if (n) { await h.hover(bars.nth(Math.max(0, n - 4)), 1500); await h.holdUntil(0.6); await h.hover(bars.nth(n - 1), 1300); } else { await h.moveTo('.chart'); } await h.holdUntil(0.95); } },
    { az: 'Manatdan fərqli valyuta seçilsə, plan xətti itmir, əksinə — səbəbi yazılır: büdcələr yalnız manatla aparılır, ona görə o valyutada plan yoxdur. Ekranda gördüyünüz dövrü isə CSV faylına çıxarmaq olar: ay, plan, faktiki və keçən il sütunları ilə.',
      do: async (p, l, h) => { await h.moveTo('[data-testid=analytics-currency]'); await h.holdUntil(0.4); await h.moveTo(p.locator('button:has-text("CSV")').first()); await h.holdUntil(0.7); await h.hover(p.locator('button:has-text("CSV")').first(), 1100); await h.holdUntil(0.95); } },
    { az: 'Aşağıda büdcənin mənimsənilmə tempi, və bu kart yalnız cari dövrün planlarını götürür — temp ancaq davam edən dövrdə məna verir. Solda şöbə və plan, sonra mənimsənilən faiz.',
      do: async (p, l, h) => { await h.scrollTo('h3:has-text("mənimsənilmə tempi")'); await h.holdUntil(0.4); await h.moveTo('.card:has(h3:has-text("mənimsənilmə tempi")) .hint'); await h.holdUntil(0.7); const t = p.locator('.card:has(h3:has-text("mənimsənilmə tempi")) tbody tr').first(); await h.moveTo(t.locator('td').nth(2)); await h.holdUntil(0.95); } },
    { az: 'Yanındaki sütun deyir ki, planla indiyə qədər nə qədər xərclənməli idi. Sonuncu sütun isə ikisinin fərqidir — temp. Müsbət rəqəm o deməkdir ki, şöbə plandan qabaqda xərcləyir, və onda yanında bunu sözlə də yazır.',
      do: async (p, l, h) => { const rows = p.locator('.card:has(h3:has-text("mənimsənilmə tempi")) tbody tr'); await h.hover(rows.first().locator('td').nth(3), 1600); await h.holdUntil(0.5); await h.hover(rows.first().locator('td').last(), 1500); await h.holdUntil(0.95); } },
    { az: 'Bu kart büdcələr bölməsinin öz hesabatından gəlir, ona görə rəqəmlər iki yerdə ayrılmır. Büdcələr lisenziya ilə açılan funksiyadır — lisenziya yoxdursa, kart sadəcə görünmür, uydurma rəqəm göstərmir.',
      do: async (p, l, h) => { await h.moveTo('.card:has(h3:has-text("mənimsənilmə tempi")) table'); await h.holdUntil(0.5); await h.moveTo(p.locator('.card:has(h3:has-text("mənimsənilmə tempi")) tbody tr').last()); await h.holdUntil(0.95); } },
    { az: 'Aşağıdaki bölgülərdə hər sətrin yanında ötən illə müqayisə var: aşağı ox — az xərcləmisiniz, yuxarı ox — çox. «Qırx min manat yanacaq» özlüyündə heç nə demir; «qırx min, ötən il iyirmi beş min idi» isə artıq sualdır.',
      do: async (p, l, h) => { await h.scrollTo('h3:has-text("Şöbələr üzrə xərc")'); await h.holdUntil(0.35); const c = p.locator('.card:has(h3:has-text("Şöbələr üzrə xərc"))'); await h.moveTo(c.locator('.budget-bar, table').first()); await h.holdUntil(0.65); await h.hover(c.locator('[data-tip]').first(), 1500); await h.holdUntil(0.95); } },
    { az: 'Keçən il ümumiyyətlə olmayıbsa, faiz göstərilmir — sıfırdan artım faizlə ölçülmür, və uydurulmuş rəqəm yazmaqdansa boş qoymaq düzgündür. Yalnız keçən ildə olan sətir isə siyahıdan yox olmur: «bunu almağı dayandırdıq» məhz bu hesabatın göstərməli olduğu şeydir.',
      do: async (p, l, h) => { const c = p.locator('.card:has(h3:has-text("Kateqoriyalar üzrə"))'); await h.scrollTo('h3:has-text("Kateqoriyalar üzrə")'); await h.holdUntil(0.45); await h.moveTo(c.locator('.budget-bar, table').first()); await h.holdUntil(0.95); } },
    { az: 'Şöbələr üzrə xərcdə bir texniki incəlik var: bölgü sifarişin öz şöbə sahəsindən oxunur, sorğu zəncirindən yox. Ona görə birbaşa alışlar və kataloq sifarişləri də düzgün şöbəyə düşür — halbuki onların arxasında heç bir sorğu yoxdur.',
      do: async (p, l, h) => { await h.scrollTo('h3:has-text("Şöbələr üzrə xərc")'); await h.holdUntil(0.4); await h.moveTo('.card:has(h3:has-text("Şöbələr üzrə xərc")) .budget-bar'); await h.holdUntil(0.75); await h.wheel(120); await h.holdUntil(0.95); } },
    { az: 'Kateqoriyalar üzrə bölgü isə «nə alırıq» sualına cavabdır, şöbə — «kim xərcləyir» sualına. İki fərqli ölçü, hər ikisi lazımdır, biri digərini əvəz etmir. Kateqoriyası olmayan birbaşa sifarişlər isə təsnifsiz qalır, və bu da göstərilir.',
      do: async (p, l, h) => { await h.moveTo('.card:has(h3:has-text("Kateqoriyalar üzrə"))'); await h.holdUntil(0.45); await h.moveTo(p.locator('.card:has(h3:has-text("Kateqoriyalar üzrə")) .budget-bar').first()); await h.holdUntil(0.95); } },
    { az: 'Ən aşağıda əsas təchizatçılar: qəbul edilmiş sifarişlərin həcminə görə ilk beşlik və hər biri üzrə sifariş sayı. Bu siyahı danışıqlarda faydalıdır, çünki həcm arqumentdir. Bütün rəqəmlər real vaxtda hesablanır və yalnız sizin təşkilatınızın məlumatlarını əhatə edir — hesabat yığmaq lazım deyil.',
      do: async (p, l, h) => { await h.scrollTo('h3:has-text("Əsas təchizatçılar")'); await h.holdUntil(0.45); await h.moveTo('.card:has(h3:has-text("Əsas təchizatçılar")) tbody tr'); await h.holdUntil(0.75); await h.wheel(-200); await h.holdUntil(0.95); } },
  ]},
  // Logistics: a read-only board, and the ONLY section with no action in its recording —
  // because the page has no control to press. Not an oversight and not something to "fix"
  // by inventing a click: Logistics.tsx renders a heading, a card and a table, zero buttons
  // and zero onClick, by design (the supplier drives the timeline from their own orders
  // screen). The pass inserted the order's OWN status beside the shipment's, which is the
  // one thing worth slowing down for here.
  'buyer-logistics': { role: 'buyer', path: '/buyer/logistics', scenes: [
    { az: 'Logistika bölməsi. Bu, sifarişləriniz üzrə yolda olan bütün göndərişlərin lövhəsidir. Burada siz izləyirsiniz, hadisələri isə təchizatçı qeyd edir — çünki mal onun əlindədir. Bu bölmə qəsdən yalnız oxunur.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.4); await h.moveTo('table'); await h.holdUntil(0.95); } },
    { az: 'Sütunlar: sifarişin nömrəsi, təchizatçı, daşıyıcı, izləmə nömrəsi, göndərişin statusu, sifarişin statusu və çatma tarixi.',
      do: async (p, l, h) => { const th = p.locator('thead th'); await h.moveTo(th.nth(0)); await h.holdUntil(0.3); await h.moveTo(th.nth(2)); await h.holdUntil(0.55); await h.moveTo(th.nth(3)); await h.holdUntil(0.78); await h.moveTo(th.nth(6)); await h.holdUntil(0.95); } },
    { az: 'İki status sütunu yan-yana durur, və bu təsadüf deyil. Göndərişin statusu təchizatçının dediyidir: yola düşdü, gömrükdədir, çatdı. Sifarişin statusu isə sizin işlədiyinizdir: qəbul etmisiniz ya yox.',
      do: async (p, l, h) => { const r = p.locator('tbody tr').first(); await h.hover(r.locator('td').nth(4).locator('.badge'), 1400); await h.holdUntil(0.55); await h.hover(r.locator('td').nth(5).locator('.badge'), 1400); await h.holdUntil(0.95); } },
    { az: 'Sistem göndəriş hadisəsindən sonra sifarişi özü irəli aparmağa çalışır, amma bu, zəmanətli addım deyil — buna görə iki sütun fərqli ola bilər. Əvvəl burada yalnız biri vardı, və fərq ümumiyyətlə görünmürdü.',
      do: async (p, l, h) => { const rows = p.locator('tbody tr'); await h.moveTo(rows.nth(1).locator('td').nth(4)); await h.holdUntil(0.45); await h.moveTo(rows.nth(1).locator('td').nth(5)); await h.holdUntil(0.95); } },
    { az: 'Daşıyıcı və izləmə nömrəsi təchizatçı göndərişi yaradanda yazılır. Nömrə varsa, onu daşıyıcının saytında yoxlamaq olar — sistem onu saxlayır, amma özü izləmir.',
      do: async (p, l, h) => { const r = p.locator('tbody tr').first(); await h.moveTo(r.locator('td').nth(2)); await h.holdUntil(0.5); await h.moveTo(r.locator('td').nth(3)); await h.holdUntil(0.95); } },
    { az: 'Çatdırılmada problem olanda status bunu ayrıca göstərir: zədə, gecikmə, gömrükdə dayanma. Bu, çatdırılmanın dayandığı demək deyil — bu, sizin müdaxilə etməli olduğunuz deməkdir.',
      do: async (p, l, h) => { const ex = p.locator('tbody .badge.EXCEPTION, tbody .badge.CUSTOMS').first(); if (await ex.count()) { await h.hover(ex, 1600); } else { await h.moveTo(p.locator('tbody tr').last()); } await h.holdUntil(0.95); } },
    { az: 'Çatma tarixi gözləntidir, öhdəlik deyil: onu da təchizatçı göstərir. Lövhə boş olanda bunu da sözlə deyir — yolda göndəriş yoxdur, yaxud sorğu alınmadı. Bu ikisi fərqli şeydir və eyni kimi göstərilmir.',
      do: async (p, l, h) => { await h.moveTo(p.locator('thead th').nth(6)); await h.holdUntil(0.5); await h.moveTo('table'); await h.holdUntil(0.95); } },
    { az: 'Göndərişin özünü isə təchizatçı öz bölməsindən idarə edir: daşıyıcını yazır, izləmə nömrəsini verir, yol hadisələrini əlavə edir. Siz isə burada eyni anda görürsünüz — ayrıca xəbər vermək lazım gəlmir.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.4); await h.moveTo('table'); await h.holdUntil(0.95); } },
  ]},
  // Suppliers: two tables of the same companies, which the pass finally explained — the
  // registry is who you work with, the directory is everyone in the system. Each card
  // now carries that sentence under its heading, so the scenes read it out.
  'buyer-suppliers': { role: 'buyer', path: '/buyer/suppliers', scenes: [
    { az: 'Təchizatçılar bölməsi. Burada iki cədvəl var və onlar bir-birinə oxşayır, ona görə hər birinin altında nə olduğu bir sətirlə yazılıb. Yuxarıdakı — reyestr: sizin işlədiyiniz təchizatçılar.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.35); await h.moveTo('h3:text-is("Reyestr")'); await h.holdUntil(0.65); await h.moveTo('.card:has(h3:text-is("Reyestr")) .hint'); await h.holdUntil(0.95); } },
    { az: 'Sütunlar: şirkət, VÖEN və status. VÖEN on rəqəmdən ibarət olmalıdır — sistem bunu yoxlayır, çünki səhv vergi nömrəsi müqaviləni və qaiməni etibarsız edir.',
      do: async (p, l, h) => { const th = p.locator('.card:has(h3:text-is("Reyestr")) thead th'); await h.moveTo(th.nth(0)); await h.holdUntil(0.35); await h.moveTo(th.nth(1)); await h.holdUntil(0.68); await h.moveTo(p.locator('.card:has(h3:text-is("Reyestr")) tbody tr').first().locator('td').nth(1)); await h.holdUntil(0.95); } },
    { az: 'Status təchizatçının sizdəki vəziyyətidir: dəvət olunub, təsdiqlənib, yaxud bloklanıb. Təsdiqlənmiş təchizatçıya tendersiz birbaşa sifariş vermək və onun kataloqundan almaq olar — ona görə bu, sadəcə nişan deyil, icazədir.',
      do: async (p, l, h) => { const rows = p.locator('.card:has(h3:text-is("Reyestr")) tbody tr'); await h.hover(rows.nth(0).locator('.badge'), 1400); await h.holdUntil(0.55); const ap = p.locator('button:text-is("Təsdiqlə")').first(); if (await ap.count()) { await h.hover(ap, 1300); } else { await h.hover(rows.nth(1).locator('.badge'), 1300); } await h.holdUntil(0.95); } },
    { az: 'Yoxlama düyməsi KYC işi açır: təchizatçı sənədlərini yükləyir, siz baxıb qərar verirsiniz. Əvvəl bu düymədə yalnız qalxan nişanı vardı və nə etdiyini demirdi — indi yanında sözü də var.',
      do: async (p, l, h) => { const v = p.locator('button:has-text("Yoxlama")').first(); if (await v.count()) { await h.hover(v, 1800); } else { await h.moveTo(p.locator('.card:has(h3:text-is("Reyestr")) tbody tr').first()); } await h.holdUntil(0.95); } },
    { az: 'Reytinq düyməsi çatdırılma qiymətləndirməsini açır: sıfırdan yüzə qədər — vaxtında və tam çatdırılan sifarişlərin payı. Satınalmada bu göstərici OTIF adlanır, və izahda da belə yazılıb.',
      // Opened and then CANCELLED on purpose. Scoring a supplier would change a figure the
      // AI-recommendation card reads, on the same stand every other recording uses — and
      // the dialog is the result worth showing anyway.
      do: async (p, l, h) => { const r = p.locator('button:has-text("Reytinq")').first(); if (!(await r.count())) { await h.moveTo('table'); await h.holdUntil(0.95); return; } await h.moveTo(r); await h.holdUntil(0.3); await h.click(r, 1200); await h.holdUntil(0.55); const dlg = p.locator('[role=dialog]'); if (await dlg.count()) { await h.moveTo('[data-testid=dialog-input]'); await h.holdUntil(0.75); await h.moveTo(dlg.locator('.hint').first()); await h.holdUntil(0.9); await h.click('[data-testid=dialog-cancel]', 700); } await h.holdUntil(0.95); } },
    { az: 'Rəqəm təkcə bəzək deyil: süni intellekt tövsiyəsi təchizatçının etibarlılığını məhz bu qiymətləndirmələrdən götürür. Yəni bir dəfə qoyulmuş qiymət növbəti tenderin müqayisəsində işləyir.',
      do: async (p, l, h) => { await h.moveTo(p.locator('.card:has(h3:text-is("Reyestr")) tbody tr').first()); await h.holdUntil(0.5); await h.moveTo(p.locator('.card:has(h3:text-is("Reyestr")) tbody tr').last()); await h.holdUntil(0.95); } },
    { az: 'Bloklama isə dağıdıcı əməliyyatdır: bloklanmış təchizatçı bundan sonra heç bir tenderə və sifarişə düşmür. Ona görə o, sətrin sonunda, ayırıcıdan sonra durur — əvvəl «Təsdiqlə» düyməsinin yanında idi, yan-yana.',
      do: async (p, l, h) => { const b = p.locator('button:has-text("Blokla")').first(); if (await b.count()) { await h.hover(b, 1800); } else { await h.moveTo(p.locator('.actions').first()); } await h.holdUntil(0.95); } },
    { az: 'Aşağıdakı cədvəl isə soraq kitabıdır: sistemdəki bütün təchizatçılar. Bu, sizin siyahınız deyil — buradan reyestrə dəvət edirsiniz. Əvvəl bu cədvəl də «Kataloq» adlanırdı — kataloqlar bölməsi ilə eyni sözlə, ona görə adı dəyişdirildi. Sütunlar da fərqlidir: statusun yerinə kateqoriyalar durur.',
      do: async (p, l, h) => { await h.scrollTo('h3:text-is("Soraq kitabı")'); await h.holdUntil(0.4); await h.moveTo('.card:has(h3:text-is("Soraq kitabı")) .hint'); await h.holdUntil(0.7); await h.moveTo(p.locator('.card:has(h3:text-is("Soraq kitabı")) thead th').nth(2)); await h.holdUntil(0.95); } },
    { az: 'Kateqoriyalar təchizatçının öz profilindən gəlir — nə satdığını özü göstərir. Reyestrdə artıq olan şirkətin yanında dəvət düyməsi görünmür, çünki onu ikinci dəfə dəvət etmək mənasızdır.',
      do: async (p, l, h) => { const inv = p.locator('.card:has(h3:text-is("Soraq kitabı")) button:text-is("Dəvət et")').first(); if (await inv.count()) { await h.hover(inv, 1600); } else { await h.moveTo('.card:has(h3:text-is("Soraq kitabı")) table'); } await h.holdUntil(0.95); } },
    { az: 'Yekunda: kataloqda təchizatçını tapırsınız, reyestrə dəvət edirsiniz, sənədlərini yoxlayırsınız, təsdiqləyirsiniz — və ondan sonra o, tenderlərə dəvət oluna və birbaşa sifariş ala bilər.',
      do: async (p, l, h) => { await h.scrollTo('h1'); await h.holdUntil(0.4); await h.moveTo('.card:has(h3:text-is("Reyestr")) table'); await h.holdUntil(0.95); } },
  ]},
  'buyer-verification': { role: 'buyer', path: '/buyer/verification', scenes: [
    { az: 'Yoxlama bölməsi. Burada təchizatçıların sənəd işləri var. Məqsəd sadədir: sənədləri yoxlanmış təchizatçıya tender gözləmədən birbaşa sifariş vermək olur, ona görə bu, formal prosedur deyil, icazə mexanizmidir.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.4); await h.moveTo('table'); await h.holdUntil(0.95); } },
    { az: 'Cədvəldə təchizatçı, işin statusu və əlavələrin sayı var. Sayın öz izahı var — bu işə nə qədər fayl yüklənib. Altdaki sətir isə necə davam edəcəyinizi deyir: sənədləri görmək üçün şirkətin adına klikləmək lazımdır.',
      do: async (p, l, h) => { const th = p.locator('thead th'); await h.moveTo(th.nth(1)); await h.holdUntil(0.35); await h.hover(th.nth(2), 1400); await h.holdUntil(0.68); await h.moveTo(p.locator('.hint').first()); await h.holdUntil(0.95); } },
    { az: 'Status zənciri qısadır: yeni iş — sənəd gözlənilir, yoxlanılır — sənədlər gəlib, qərar sizdədir, sonra təsdiq və ya rədd. Qərar verilməyibsə, top təchizatçıdadır ya sizdə — bunu məhz status deyir.',
      do: async (p, l, h) => { const rows = p.locator('tbody tr'); await h.hover(rows.nth(0).locator('.badge'), 1500); await h.holdUntil(0.6); const n = await rows.count(); if (n > 1) await h.hover(rows.nth(1).locator('.badge'), 1300); await h.holdUntil(0.95); } },
    { az: 'İşi açırıq — şirkətin adına klikləyirik.',
      do: async (p, l, h) => { await h.click(p.locator('tbody tr a').first(), 1500); await h.holdUntil(0.95); } },
    { az: 'Aşağıda yüklənmiş sənədlər sıralanır: hər birinin növü, faylın adı və qısa kod. Növ vacibdir — VÖEN şəhadətnaməsi, lisenziya, bank arayışı, sığorta — çünki sənədləri məhz növünə görə axtarırsınız.',
      do: async (p, l, h) => { await h.scrollTo(p.locator('.card').last()); await h.holdUntil(0.4); await h.moveTo(p.locator('.card').last().locator('.badge').first()); await h.holdUntil(0.95); } },
    { az: 'Yanındaki qısa kod faylın məzmununun barmaq izidir. İzahı da bunu deyir: sənəd sonradan dəyişdirilibsə, iz uyğun gəlməyəcək. Bu, həm sizin, həm təchizatçının xeyrinədir — heç kim «mən başqa sənəd göndərmişdim» deyə bilməz.',
      do: async (p, l, h) => { const mono = p.locator('.card').last().locator('.hint[data-tip]').first(); if (await mono.count()) { await h.hover(mono, 1800); } else { await h.moveTo(p.locator('.card').last()); } await h.holdUntil(0.95); } },
    { az: 'Hər fayl yüklənəndə antivirusdan keçir. Yoluxmuş fayl bloklanır və bu barədə bildiriş gedir — fayl isə sistemə düşmür. Yükləmə özü təchizatçının işidir, siz isə burada nəticəsini görürsünüz.',
      do: async (p, l, h) => { await h.moveTo(p.locator('.card').last()); await h.holdUntil(0.5); await h.moveTo(p.locator('.card').last().locator('.hint').first()); await h.holdUntil(0.95); } },
    { az: 'Qərar iki düymədədir: təsdiq və ya rədd. Hər birinin izahı nəticəni deyir — təsdiq birbaşa sifarişləri açır. Təchizatçı qərarı öz panelində dərhal görür, və təsdiq alan kimi onun yoxlama sətri yaşıla dönür.',
      do: async (p, l, h) => { const a = p.locator('button:text-is("Təsdiqlə")').first(); if (await a.count()) { await h.hover(a, 1700); await h.holdUntil(0.6); await h.hover(p.locator('button:text-is("Rədd et")').first(), 1300); } else { await h.moveTo('table'); } await h.holdUntil(0.95); } },
  ]},
  // Settings: eight sections one under another. The pass put an anchor list at the top,
  // because the only way to the last one used to be the scrollbar.
  'buyer-settings': { role: 'buyer', path: '/buyer/settings', scenes: [
    { az: 'Parametrlər bölməsi. Burada səkkiz ayrı hissə var, ona görə ən yuxarıda keçid sətri durur: istifadəçilər, kateqoriyalar, şöbələr, büdcə hədləri, metod siyasəti, kanallar, inteqrasiyalar və təsdiq zənciri. Əvvəl sonuncuya yalnız sürüşdürmə ilə çatmaq olurdu.',
      // The jump IS the result: the row exists because the last section used to be
      // reachable only by the scrollbar, and a hover cannot show that.
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.3); await h.moveTo(p.locator('.hint a').first()); await h.holdUntil(0.5); const last = p.locator('.hint a').last(); await h.moveTo(last); await h.holdUntil(0.68); await h.click(last, 1200); await h.holdUntil(0.88); await h.moveTo('h3#set-approval'); await h.holdUntil(0.95); } },
    { az: 'İstifadəçilər. Cədvəldə e-poçt, ad, rol və şöbə var. Şöbə sütunu sadəcə məlumat deyil: o, həmin adamın yeni sorğularında standart şöbə olur və onun büdcələrə girişini müəyyən edir.',
      do: async (p, l, h) => { await h.moveTo('h3#set-users'); await h.holdUntil(0.4); await h.moveTo(p.locator('.card:has(h3#set-users) thead th').nth(2)); await h.holdUntil(0.7); await h.moveTo(p.locator('.card:has(h3#set-users) thead th').nth(3)); await h.holdUntil(0.95); } },
    { az: 'Rollar beşdir: administrator, təsdiqləyən, istifadəçi, maliyyəçi və təchizatçı. Öz rolunuzu dəyişmək mümkün deyil — sistem bunu açıq imtina ilə deyir. Rol dəyişəndə həmin adamın bütün sessiyaları bağlanır, yəni yeni hüquq dərhal işə düşür.',
      do: async (p, l, h) => { const sel = p.locator('.card:has(h3#set-users) tbody select').first(); if (await sel.count()) { await h.moveTo(sel); } await h.holdUntil(0.55); await h.moveTo(p.locator('.card:has(h3#set-users) form').first()); await h.holdUntil(0.95); } },
    { az: 'Kateqoriya kataloqu. Bu, vahid siyahıdır, və məqsədi birdir: «IT», «it» və «AyTi» üç ayrı kateqoriyaya çevrilməsin. Çünki kateqoriya həm metod siyasətini, həm büdcəni, həm analitikanı idarə edir — üç yerdə birdən dağılır.',
      do: async (p, l, h) => { await h.scrollTo('h3#set-categories'); await h.holdUntil(0.35); await h.moveTo('.card:has(h3#set-categories) .hint'); await h.holdUntil(0.6); const chips = p.locator('.card:has(h3#set-categories) .badge'); if (await chips.count()) { await h.moveTo(chips.first()); await h.holdUntil(0.8); await h.moveTo(chips.last()); } await h.holdUntil(0.95); } },
    { az: 'Şöbələr — məsrəf mərkəzləri. Sütunlar: kod, ad, yuxarı şöbə, sorğuların sayı və status. Yuxarı şöbə ağac qurur, ona görə büdcə hesabatında ana şöbənin rəqəmlərinə tabe bölmələr də daxil olur.',
      do: async (p, l, h) => { await h.scrollTo('h3#set-departments'); await h.holdUntil(0.4); const th = p.locator('.card:has(h3#set-departments) thead th'); await h.moveTo(th.nth(2)); await h.holdUntil(0.7); await h.moveTo(th.nth(3)); await h.holdUntil(0.95); } },
    { az: 'Sorğuları olan şöbə silinmir — silmə düyməsi işləmir və bunun səbəbi yazılır. Əvəzinə onu arxivə göndərirsiniz: tarixi sorğular öz şöbəsində qalır, yeni sorğuda isə həmin şöbə artıq seçilmir. Bu, məlumatı itirmədən bağlamağın yoludur.',
      do: async (p, l, h) => { const c = p.locator('.card:has(h3#set-departments)'); const del = c.locator('button.danger').first(); if (await del.count()) { await h.hover(del, 1600); await h.holdUntil(0.6); } const arc = c.locator('button:has-text("Arxiv")').first(); if (await arc.count()) await h.hover(arc, 1400); await h.holdUntil(0.95); } },
    { az: 'Büdcə hədləri. Xəbərdarlıq faizi — mənimsənilmə bu paya çatanda bildiriş gedir, özü də şöbənin sahibinə, bütün təşkilata deyil. Qırx nəfərə göndərilən büdcə xəbərdarlığı heç kimin əməl etmədiyi xəbərdarlıqdır.',
      do: async (p, l, h) => { const th = p.locator('h3#set-thresholds'); if (await th.count()) { await h.scrollTo(th); await h.holdUntil(0.4); await h.moveTo('#bud-warn'); await h.holdUntil(0.7); await h.moveTo('.card:has(h3#set-thresholds) .hint'); } else { await h.scrollTo('h3#set-method'); } await h.holdUntil(0.95); } },
    { az: 'Blok faizi isə təsdiqi dayandırır — amma standart olaraq boşdur, yəni heç nə bloklanmır. Altdaki qeyd administratorun yazılı əsaslandırma ilə keçməsinə icazə verir. Bu, açıq seçimdir: ya qayda sərtdir, ya istisna var, və istisna həmişə imzalı olur.',
      do: async (p, l, h) => { const b = p.locator('#bud-block'); if (await b.count()) { await h.moveTo(b); await h.holdUntil(0.5); await h.moveTo('#bud-override'); } else { await h.moveTo('h1'); } await h.holdUntil(0.95); } },
    { az: 'Metod siyasəti — ekranın ən vacib hissəsi. Burada yazılır, hansı məbləğə qədər birbaşa sifariş, hansından tender. Sorğunu yaradan adam metodu seçmir: sorğu təsdiqlənən kimi metod bu cədvəldən avtomatik təyin olunur.',
      do: async (p, l, h) => { await h.scrollTo('h3#set-method'); await h.holdUntil(0.4); await h.moveTo('.card:has(h3#set-method) .hint'); await h.holdUntil(0.75); await h.moveTo('.mp-scale'); await h.holdUntil(0.95); } },
    { az: 'Siyasət rəngli şkala kimi göstərilir, hər kateqoriya üçün ayrıca: bir baxışda görünür, hansı aralıq hansı metoda gedir. Aralıqları «Dəyiş» düyməsi ilə qurursunuz — məbləğ sərhədi və metod.',
      // Opened and closed: saving would rewrite the org's own bands, and the policy decides
      // which procedure every approved request gets — on the stand every other recording
      // reads. The editor itself is the result worth seeing.
      do: async (p, l, h) => { const card = p.locator('.card:has(h3#set-method)'); const bands = p.locator('.mp-band'); await h.moveTo(bands.first()); await h.holdUntil(0.3); const n = await bands.count(); await h.moveTo(bands.nth(Math.min(1, n - 1))); await h.holdUntil(0.5); const e = card.locator('button:has-text("Dəyiş")').first(); if (await e.count()) { await h.click(e, 1300); await h.holdUntil(0.75); await h.moveTo(card.locator('table').first()); await h.holdUntil(0.9); const cancel = card.locator('button:has-text("Ləğv et")').first(); if (await cancel.count()) await h.click(cancel, 600); } await h.holdUntil(0.95); } },
    { az: 'Göndərmə kanalları: öz e-poçtunuz və WhatsApp. Bunlar avtomatik xatırlatmalar üçündür. Qoşulmayıbsa, sistemin ümumi konfiqi işlədilir, ona görə kanal qoşmaq məcburi deyil — sadəcə məktublar sizin adınızdan getsin deyə.',
      do: async (p, l, h) => { await h.scrollTo('#set-channels'); await h.holdUntil(0.4); await h.moveTo(p.locator('#set-channels .hint').first()); await h.holdUntil(0.7); await h.moveTo(p.locator('#set-channels .badge, #set-channels button').first()); await h.holdUntil(0.95); } },
    { az: 'İnteqrasiyalar. Burada bir düymə var: qaimələri mühasibat üçün fayla çıxarmaq. Yanında isə standart ixracların siyahısı — OCDS tenderin kartında, elektron qaimə üçün UBL isə qaimənin özündə. Yəni məlumat sistemdə qapanıb qalmır.',
      do: async (p, l, h) => { await h.scrollTo('h3#set-integrations'); await h.holdUntil(0.4); await h.moveTo('.card:has(h3#set-integrations) .hint'); await h.holdUntil(0.7); await h.hover(p.locator('.card:has(h3#set-integrations) button').first(), 1300); await h.holdUntil(0.95); } },
    { az: 'Təsdiq zənciri — kim hansı məbləği təsdiqləyir. Aralıq, sonra addımlar: hər addımda bir rol. Altda ayrıca yazılıb ki, bir nəfər eyni sorğunun iki addımını bağlaya bilməz, müəllif isə öz sorğusunu heç vaxt təsdiqləyə bilməz.',
      do: async (p, l, h) => { await h.scrollTo('h3#set-approval'); await h.holdUntil(0.4); await h.moveTo('.card:has(h3#set-approval) .hint'); await h.holdUntil(0.65); await h.moveTo(p.locator('.card:has(h3#set-approval) .badge').first()); await h.holdUntil(0.95); } },
    { az: 'Zənciri sıfırdan qurmaq lazım deyil: aşağıda hazır sxemlər var və işləyən sxem ayrıca işarələnib. Birini seçmək kifayətdir. Kiçik komanda üçün zəncirsiz variant da var — istənilən təsdiqləyən bir kliklə təsdiqləyir.',
      do: async (p, l, h) => { const pr = p.locator('.card:has(h3#set-approval) [role=button]'); if (await pr.count()) { await h.moveTo(pr.first()); await h.holdUntil(0.5); await h.moveTo(pr.last()); } else { await h.moveTo('.card:has(h3#set-approval)'); } await h.holdUntil(0.95); } },
  ]},
  // Supplier panel. The pass moved verification OUT of the figure grid: it answers a
  // question that comes before any count — can I be invited at all — and every tile now
  // carries its own explanation, which the supplier's side used to lack entirely.
  'sup-dashboard': { role: 'sup', path: '/supplier/dashboard', scenes: [
    { az: 'Təchizatçının idarə paneli. Ən yuxarıda yoxlama sətri durur, və bu, təsadüf deyil: o, saylardan əvvəl gələn suala cavab verir — sizi ümumiyyətlə tenderə dəvət edə bilərlərmi.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.35); await h.moveTo('[data-testid=sup-verification]'); await h.holdUntil(0.95); } },
    { az: 'Sətir statusu və onun sizin üçün nə demək olduğunu yazır. Sənədlər sifarişçidədirsə, cavabı gözləməlisiniz — təkrar göndərmək lazım deyil. Heç nə göndərilməyibsə, bu da ayrıca yazılır, çünki «başlanmayıb» ilə «yoxlanılır» iki fərqli vəziyyətdir. Sağdaki düymə yoxlama bölməsini açır.',
      do: async (p, l, h) => { const v = p.locator('[data-testid=sup-verification]'); await h.moveTo(v.locator('.badge').first()); await h.holdUntil(0.4); await h.moveTo(v.locator('.hint')); await h.holdUntil(0.72); await h.hover(v.locator('a.btn'), 1200); await h.holdUntil(0.95); } },
    { az: 'Altda beş göstərici var: açıq tenderlər, mənim təkliflərim, müqavilələr, işdə olan sifarişlər və qaimələr. Hər birinin üzərinə gətirin — nəyin sayıldığı yazılır. «Müqavilələr: üç» qaralamaları və bitmişləri də sayır, və bunu bilmədən rəqəm yanıldır.',
      do: async (p, l, h) => { await h.scrollTo('[data-testid=sup-kpi]'); await h.holdUntil(0.3); const c = p.locator('[data-testid=sup-kpi] .card'); await h.hover(c.nth(0), 1400); await h.holdUntil(0.62); await h.hover(c.nth(2), 1400); await h.holdUntil(0.95); } },
    { az: 'Açıq tenderlər yalnız hələ təklif qəbul edənləri sayır — bağlananlar və hələ elan olunmayanlar yox. Mənim təkliflərim isə həm möhürlü, həm açılmış təkliflərdir; gecikənlər və kənarlaşdırılanlar sayılmır.',
      do: async (p, l, h) => { const c = p.locator('[data-testid=sup-kpi] .card'); await h.hover(c.nth(0), 1300); await h.holdUntil(0.5); await h.hover(c.nth(1), 1400); await h.holdUntil(0.95); } },
    { az: 'Sonra tapşırıqlar. Sistem sizin üçün növbəti addımı özü tapır: təklif ver, sifarişi irəli apar, qaimə göndər. Sətrin sonundaki «Aç» düyməsi düz lazım olan ekrana aparır — əvvəl orada yalnız ox vardı.',
      do: async (p, l, h) => { await h.scrollTo('h3:text-is("Tapşırıqlar")'); await h.holdUntil(0.4); const r = p.locator('.card:has(h3:text-is("Tapşırıqlar")) tbody tr').first(); await h.moveTo(r.locator('.badge')); await h.holdUntil(0.7); await h.hover(r.locator('a.btn'), 1200); await h.holdUntil(0.95); } },
    { az: 'Aşağıda bildirişlər, sifariş üzrə qruplaşdırılmış: bir sifarişin bütün hadisələri bir blokda durur. Burada da oxunmuş kimi işarələmək olar — əvvəl bu imkan yalnız sifarişçinin panelində idi, halbuki ehtiyac hər iki tərəfdə eynidir.',
      do: async (p, l, h) => { await h.scrollTo('h3:text-is("Bildirişlər")'); await h.holdUntil(0.4); await h.moveTo('.card:has(h3:text-is("Bildirişlər")) table'); await h.holdUntil(0.72); const b = p.locator('.card:has(h3:text-is("Bildirişlər")) button.btn').first(); if (await b.count()) await h.hover(b, 1200); await h.holdUntil(0.95); } },
    // Also ends on a real press, and for the same reason as the buyer's panel: a
    // navigation changes nothing on the stand, while clearing notifications would empty
    // this panel for every other recording.
    { az: 'Beləliklə iş qaydası sadədir: panelə baxırsınız, tapşırıqları bağlayırsınız. Göstərək: yoxlama sətrindəki «Aç» düyməsini basırıq — və sistem bizi öz sənədlərimizə aparır. Yoxlama bitəndən sonra isə sizə tender gözləmədən sifariş verə bilərlər.',
      do: async (p, l, h) => { await h.scrollTo('h1'); await h.holdUntil(0.25); const v = p.locator('[data-testid=sup-verification] a.btn').first(); if (await v.count()) { await h.moveTo(v); await h.holdUntil(0.45); await h.click(v, 2000); await p.waitForSelector('h1', { timeout: 15000 }); await h.holdUntil(0.8); await h.moveTo('h1'); } else { await h.moveTo('[data-testid=sup-kpi]'); } await h.holdUntil(0.95); } },
  ]},
  // Supplier market → a real sealed bid on a live tender. The market list gained the
  // procedure column in PR #79: before it, a closed tender, a live auction and a request
  // for information looked identical until the row was opened.
  // Third section holding the same auction's state, and the most deliberate of the
  // three: scene 5 parks the cursor ON its status badge for 1.3s while the narration
  // explains that the deadline is absolute. The row survives closing — GET /events
  // does not filter by status — so nothing misses and nothing is empty; what breaks is
  // the set, which would show one auction open in one guide and closed in another.
  // ГЛАВА 3 истории: поставщик видит приглашение и смотрит, что именно закупают.
  'sup-market': { role: 'sup', path: '/supplier/market', scenes: [
    { az: 'Mən Supply One-da satış meneceriyəm. Vitrin mənə açıq olan bütün tenderləri göstərir. Qapalı tenderə yalnız dəvət olunanlar düşür — bu sətir burada ona görədir ki, alıcı məni dəvət edib.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.35); await h.need(ROW, 'dəvət olunduğum tender'); await h.moveTo(`${ROW} td:nth-child(1)`); await h.holdUntil(0.95); } },
    { az: 'Sütunlar: prosedur, alıcı, status, son tarix və mənim təklifim. Sonuncu hələ boşdur — bu tenderə heç nə göndərməmişəm.',
      do: async (p, l, h) => { await h.hover(`${ROW} td:nth-child(2) .chip, ${ROW} td:nth-child(2) span`, 1100); await h.holdUntil(0.4); await h.moveTo(`${ROW} td:nth-child(5)`); await h.holdUntil(0.7); await h.moveTo(`${ROW} td:nth-child(6)`); await h.holdUntil(0.95); } },
    { az: 'Başlıq keçiddir. Tenderin kartında alıcı, son tarix və alınacaq mövqelər var: iyirmi iş masası və iyirmi oturacaq.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick(`${ROW} a`, 'tenderin başlığı', 1500);
        await p.waitForURL(/\/supplier\/events\/[0-9a-f-]{36}/, { timeout: 15000 });
        await h.need(`h1:has-text("${STORY.title}")`, 'tenderin kartı');
        await h.moveTo('h1'); await h.holdUntil(0.5);
        await h.scrollTo('tbody tr'); await h.moveTo('tbody tr'); await h.holdUntil(0.95);
      } },
    { az: 'Mövqelər göstərilir, amma alıcının smetası yoxdur və olmayacaq: onu bilsəm, qiymətim onun rəqəminə bağlanardı. Qiymət mənim öz hesabımdır.',
      do: async (p, l, h) => { await h.moveTo('thead th:nth-child(3)'); await h.holdUntil(0.45); await h.moveTo('tbody tr:nth-child(2)'); await h.holdUntil(0.95); } },
    { az: 'Sual yaranarsa — aşağıda suallar bölməsi var. Cavab bütün iştirakçılara eyni anda açılır, ona görə sual vermək kiminsə üstünlüyünə çevrilmir.',
      do: async (p, l, h) => { await h.scrollTo('[data-testid=qna-card]'); await h.holdUntil(0.5); await h.moveTo('[data-testid=qna-card] h3'); await h.holdUntil(0.95); } },
  ]},
  // ГЛАВА 4 истории: обе ставки. Два актёра, потому что тендер с одной ставкой не
  // показывает ни сравнения, ни экономии — а присуждение единственной ставке продукт
  // требует обосновывать письменно, то есть это была бы другая сцена.
  //
  // Это НОВЫЙ раздел: прежде ставка поставщика нигде не снималась отдельно — `sup-market`
  // рассказывал про витрину, а `sup-auction` про живые торги. Запечатанная ставка, то есть
  // главное действие поставщика в закупке, была пропущена.
  'sup-bid': { role: 'sup', path: '/supplier/market', scenes: [
    { az: 'Təklif verirəm. Hər mövqe üçün öz qiymətim: masa min altı yüz əlli, oturacaq min iki yüz əlli manat.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick(`${ROW} a`, 'tenderin başlığı', 1200);
        await p.waitForURL(/\/supplier\/events\/[0-9a-f-]{36}/, { timeout: 15000 });
        await h.scrollTo('[data-testid=bid-price-0]');
        await h.needFill('[data-testid=bid-price-0]', STORY.bid[0], 'birinci mövqenin qiyməti');
        await h.holdUntil(0.6);
        await h.needFill('[data-testid=bid-price-1]', STORY.bid[1], 'ikinci mövqenin qiyməti');
        await h.holdUntil(0.95);
      } },
    { az: 'Çatdırılma müddəti — on dörd gün. Cəmi sistem özü yığır: əlli səkkiz min manat. Göndər — təklif möhürlənir və şifrələnmiş halda saxlanılır.',
      must: true,
      do: async (p, l, h) => {
        await h.needFill('[data-testid=bid-days]', STORY.deliveryDays, 'çatdırılma müddəti');
        await h.moveTo('[data-testid=bid-total]'); await h.holdUntil(0.5);
        await h.needClick('[data-testid=bid-submit]', 'təklifi göndərmə düyməsi', 1800);
        await h.need('.badge.SUBMITTED', 'göndərilmiş təklifin statusu');
        await h.holdUntil(0.95);
      } },
    { az: 'Təklifim göndərilib. Son tarixə qədər onu geri götürüb yenidən verə bilərəm. Rəqiblərin qiymətini görmürəm, onlar da mənimkini — alıcı da görmür.',
      do: async (p, l, h) => { await h.scrollTo('.badge.SUBMITTED'); await h.moveTo('.badge.SUBMITTED'); await h.holdUntil(0.55); await h.moveTo('.card .hint'); await h.holdUntil(0.95); } },
    { as: 'sup2',
      az: 'Eyni tender, ikinci təchizatçının gözü ilə. Bakı Metal da dəvət olunub və öz qiymətini verir: min yeddi yüz və min üç yüz əlli.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick(`${ROW} a`, 'tenderin başlığı', 1200);
        await p.waitForURL(/\/supplier\/events\/[0-9a-f-]{36}/, { timeout: 15000 });
        await h.scrollTo('[data-testid=bid-price-0]');
        await h.needFill('[data-testid=bid-price-0]', STORY.bid2[0], 'birinci mövqenin qiyməti');
        await h.needFill('[data-testid=bid-price-1]', STORY.bid2[1], 'ikinci mövqenin qiyməti');
        await h.needFill('[data-testid=bid-days]', '21', 'çatdırılma müddəti');
        await h.moveTo('[data-testid=bid-total]'); await h.holdUntil(0.95);
      } },
    { as: 'sup2',
      az: 'Göndərdim. İndi iki möhürlənmiş zərf var. Alıcı yalnız sayını görür — iki təklif. Məbləğlər son tarix keçənə qədər heç kimə açılmır.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick('[data-testid=bid-submit]', 'təklifi göndərmə düyməsi', 1800);
        await h.need('.badge.SUBMITTED', 'göndərilmiş təklifin statusu');
        await h.scrollTo('.badge.SUBMITTED'); await h.moveTo('.badge.SUBMITTED'); await h.holdUntil(0.96);
      } },
  ]},
  'sup-orders': { role: 'sup', path: '/supplier/orders', scenes: [
    { az: 'İşdə olan sifarişlər. Bu, sizin çatdırılma konveyerinizdir: udulmuş hər sifariş buraya düşür və bağlanana qədər burada qalır.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.4); await h.moveTo('table'); await h.holdUntil(0.95); } },
    { az: 'Sütunlar: sifarişin nömrəsi, sifarişçi, məbləğ, cari status, əməliyyatlar və logistika. Yəni bir sətirdə həm vəziyyət, həm də növbəti addım görünür.',
      do: async (p, l, h) => { const th = p.locator('thead th'); await h.moveTo(th.nth(0)); await h.holdUntil(0.3); await h.moveTo(th.nth(3)); await h.holdUntil(0.55); await h.moveTo(th.nth(4)); await h.holdUntil(0.78); await h.moveTo(th.nth(5)); await h.holdUntil(0.95); } },
    { az: 'Status zənciri sabitdir: təsdiq, qablaşdırma, göndərmə, çatdırılma. Hər addım bir düymə ilə atılır və düymə növbəti addımın adını daşıyır. Addımları atlamaq olmur — ardıcıllığı sistem özü yoxlayır.',
      do: async (p, l, h) => { const r = p.locator('tbody tr'); await h.hover(r.nth(0).locator('.badge'), 1300); await h.holdUntil(0.4); await h.moveTo(p.locator('tbody button.btn').first()); await h.holdUntil(0.95); } },
    { az: 'Sifarişçi sifarişi dəyişmək istəyirsə, bu, sizin arxanızca edilmir. «Dəyişikliklər» düyməsini açırıq.',
      do: async (p, l, h) => { const a = p.locator('button:has-text("Dəyişikliklər")').first(); if (await a.count()) { await h.click(a, 1800); } else { await h.moveTo('table'); } await h.holdUntil(0.95); } },
    { az: 'Kartda dəqiq hesablama var: köhnə miqdar və yeni miqdar, köhnə qiymət və yeni qiymət, sonra isə yekun məbləğin necə dəyişəcəyi. Yanında səbəb yazılır. Yəni qərar verməzdən əvvəl nəyə razılıq verdiyinizi görürsünüz.',
      do: async (p, l, h) => { const c = p.locator('tbody .card').first(); if (await c.count()) { await h.moveTo(c.locator('.hint').first()); await h.holdUntil(0.45); await h.moveTo(c.locator('div').nth(1)); await h.holdUntil(0.75); await h.moveTo(c.locator('div').nth(2)); } await h.holdUntil(0.95); } },
    { az: 'Qərar sizindir: qəbul edirsinizsə, məbləğlər bir əməliyyatda yenilənir; rədd edirsinizsə, sifariş köhnə şərtlərlə qalır. Sifarişçi birtərəfli qaydada dəyişiklik edə bilmir, və qərarınız barədə ona dərhal bildiriş gedir.',
      do: async (p, l, h) => { const c = p.locator('tbody .card').first(); if (await c.count()) { await h.hover(c.locator('button.btn').first(), 1500); await h.holdUntil(0.6); await h.moveTo(c.locator('button.btn').nth(1)); } await h.holdUntil(0.95); } },
    { az: 'İndi logistikaya baxaq. Sağdaki «Logistika» düyməsi bu sifariş üzrə göndəriş məlumatını açır. Əvvəl orada yalnız yük maşını şəkli vardı, və basmağın nə edəcəyi yazılmırdı.',
      do: async (p, l, h) => { const lg = p.locator('button:has-text("Logistika")').first(); if (await lg.count()) { await h.hover(lg, 1300); await h.holdUntil(0.6); await h.click(lg, 1600); } else { await h.moveTo(p.locator('thead th').nth(5)); } await h.holdUntil(0.95); } },
    { az: 'Göndəriş yoxdursa, onu yaradırsınız: daşıyıcı və izləmə nömrəsi. Sonra yol hadisələrini siyahıdan əlavə edirsiniz — yola düşdü, gömrükdə, çatdı. Hadisələr sözlə yazılır, kod kimi yox: əvvəl burada status kodu ilə məkan bir xətlə yapışdırılırdı.',
      do: async (p, l, h) => { const cs = p.locator('button:has-text("Göndəriş yarat")').first(); if (await cs.count()) { await h.hover(cs, 1500); } else { const sel = p.locator('tbody select').first(); if (await sel.count()) { await h.moveTo(sel); await h.holdUntil(0.6); await h.moveTo(p.locator('tbody .hint').first()); } } await h.holdUntil(0.95); } },
    { az: 'Hadisə əlavə edən kimi sifarişçinin logistika lövhəsində status dəyişir — ayrıca xəbər vermək lazım gəlmir. Çatdırılmış göndərişi geri qaytarmaq isə mümkün deyil: siyahı özü belə variant təklif etmir, çünki server onu onsuz da qəbul etməz.',
      do: async (p, l, h) => { const sel = p.locator('tbody select').first(); if (await sel.count()) { await h.moveTo(sel); } else { await h.moveTo('table'); } await h.holdUntil(0.95); } },
    { az: 'Çatdırılmadan sonra «Qaimə» düyməsi işə düşür. Vacib incəlik: qaimə sifarişdən yox, faktiki qəbul edilmiş miqdardan doldurulur. Ona görə də o, sifarişçinin üçtərəfli yoxlamasından adətən ilk dəfədən keçir. Sistem sizdən ödəniş müddətini də soruşur — onu siz göstərirsiniz, çünki tarix razılaşmadan gəlir, hesablamadan yox; keçmiş tarix qəbul edilmir.',
      do: async (p, l, h) => { const inv = p.locator('button:has-text("Qaimə")').first(); if (await inv.count()) { await h.hover(inv, 1800); } else { await h.moveTo(p.locator('tbody tr').first().locator('.badge')); } await h.holdUntil(0.95); } },
    { az: 'Qəbul ediləsi qalıq yoxdursa, sistem bunu açıq deyir və boş qaimə yaratmır. Beləliklə bir ekranda bütün dövr yığılır: təsdiq, yığım, göndəriş, çatdırılma və qaimə. Növbəti bölmə isə həmin qaimələrin taleyini göstərir.',
      do: async (p, l, h) => { await h.scrollTo('h1'); await h.holdUntil(0.35); await h.moveTo('table'); await h.holdUntil(0.95); } },
  ]},
  // Supplier invoices: the same three-way match, read from the side that gets paid. The
  // status column is the SIXTH cell since the payment-due column was removed.
  'sup-invoices': { role: 'sup', path: '/supplier/invoices', scenes: [
    { az: 'Qaimələr bölməsi. Burada verdiyiniz bütün qaimələr və onların taleyi var. Qaimə verildiyi andan sistem onu iki mənbə ilə tutuşdurur: sifarişlə və sifarişçinin qəbul aktı ilə.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.4); await h.moveTo('table'); await h.holdUntil(0.95); } },
    { az: 'Sütunlar: nömrə, hansı sifariş üzrə, sifarişçi, qaimənin tarixi, ödəniş müddəti, məbləğ və status. Ödəniş müddətini siz özünüz göstərirsiniz — qaiməni göndərəndə. Statuslar belə oxunur: «Uyğundur» — hər şey yerindədir, qərar gözləyirsiniz. «Təsdiqlənib» — ödəniş növbəsindədir. «Ödənilib» — pul köçürülüb. «Mübahisəli» isə nəsə uyğun gəlməyib deməkdir.',
      do: async (p, l, h) => { const r = p.locator('tbody tr'); await h.moveTo(r.nth(0).locator('td').nth(4)); await h.holdUntil(0.3); await h.hover(r.nth(0).locator('td').nth(6).locator('.badge'), 1200); await h.holdUntil(0.55); await h.hover(r.nth(1).locator('td').nth(6).locator('.badge'), 1100); await h.holdUntil(0.78); await h.hover(r.nth(2).locator('td').nth(6).locator('.badge'), 1100); await h.holdUntil(0.95); } },
    { az: 'Mübahisəli qaiməni açaq — səbəbi gizlətmirlər, siz də eyni cədvəli görürsünüz.',
      do: async (p, l, h) => { await h.click('tbody tr:has-text("INV-2026-0003") a', 1600); await h.scrollTo('.card:has(h3:has-text("INV-2026-0003"))'); await h.holdUntil(0.95); } },
    { az: 'Cədvəldə dörd rəqəm üz-üzə durur: sizin qiymətiniz və sifarişdəki qiymət, sizin miqdarınız və faktiki qəbul edilən miqdar. Burada həm qiymət yüksəkdir, həm də miqdar qəbul ediləndən çoxdur — ona görə sətir keçmir.',
      do: async (p, l, h) => { const t = p.locator('.card:has(h3:has-text("INV-2026-0003")) table tbody tr').first(); await h.moveTo(t.locator('td').nth(0)); await h.holdUntil(0.3); await h.moveTo(t.locator('td').nth(1)); await h.holdUntil(0.52); await h.moveTo(t.locator('td').nth(2)); await h.holdUntil(0.74); await h.moveTo(t.locator('td').nth(3)); await h.holdUntil(0.95); } },
    { az: 'Bu, mübahisə üçün əsas deyil, aydınlıq üçün alətdir: ya qalan malı çatdırırsınız və qəbul rəsmiləşəndən sonra yoxlama özü yenidən işləyir, ya da qaiməni düzgün miqdarla yenidən verirsiniz. Sifarişçi isə onu yazılı əsaslandırma ilə təsdiqləyə də bilər.',
      do: async (p, l, h) => { await h.moveTo('.card:has(h3:has-text("INV-2026-0003")) h3'); await h.holdUntil(0.5); await h.moveTo(p.locator('tbody tr:has-text("INV-2026-0003") td').nth(6)); await h.holdUntil(0.95); } },
    { az: 'Uyğun gələn qaimədə isə hər sətir yaşıl işarə ilə keçir. Yuxarıda məbləğ ƏDV-siz və ƏDV ayrıca göstərilir — dərəcə sifarişin sətrindən götürülür, ona görə sıfır dərəcəli mövqelər düz hesablanır.',
      do: async (p, l, h) => { await h.click('tbody tr:has-text("INV-2026-0003") a', 700); await h.click('tbody tr:has-text("INV-2026-0002") a', 1600); await h.scrollTo('.card:has(h3:has-text("INV-2026-0002"))'); await h.moveTo('.card:has(h3:has-text("INV-2026-0002")) .hint'); await h.holdUntil(0.95); } },
    { az: 'Qaimə verilməyib siyahı boş qalanda, ekran bunu da izah edir: qaimə qəbul edilmiş sifarişdəki düymə ilə göndərilir. Yəni boş siyahı sualsız qalmır.',
      do: async (p, l, h) => { await h.scrollTo('h1'); await h.holdUntil(0.4); await h.moveTo('table'); await h.holdUntil(0.95); } },
    { az: 'Təsdiq və ödəniş sifarişçinin addımlarıdır, amma ikisi də burada görünür. Yəni ödənişin harada dayandığını soruşmaq üçün zəng etmək lazım deyil — status özü deyir.',
      do: async (p, l, h) => { const r = p.locator('tbody tr'); const n = await r.count(); await h.moveTo(r.nth(Math.min(3, n - 1)).locator('td').nth(6)); await h.holdUntil(0.6); await h.moveTo('table'); await h.holdUntil(0.95); } },
  ]},
  // Reverse auction from the supplier's seat. Not reachable from the help bar: the map in
  // apps/web/src/guides.ts keys on the ROUTE, and an auction lives on the same
  // /supplier/events/:id as a sealed tender, so that route plays sup-market. Kept in sync
  // here so the file exists the day the widget learns to pick a guide by the event's own
  // format; until then nothing in the product loads it.
  // Needs the auction still accepting bids: the «Mövqelər» card with the price field
  // exists only while it is open, and scene 6 narrates filling it in.
  'sup-auction': { role: 'sup', path: '/supplier/market', requires: { eventOpen: 'Auksion: ofis kağızı' }, scenes: [
    { az: 'Ayrıca prosedur növü — revers auksion. Siyahıda onu şimşək nişanı ilə tanıyırsınız. Adi tenderdən fərqi budur: burada qiymətlər gizli deyil və real vaxtda aşağı düşür. Ofis kağızı üzrə auksionu açırıq.',
      do: async (p, l, h) => { await h.moveTo('table'); await h.holdUntil(0.35); const chip = p.locator('tbody tr:has-text("Auksion: ofis kağızı") .chip').first(); if (await chip.count()) await h.hover(chip, 1200); await h.holdUntil(0.6); await h.click('tbody tr:has-text("Auksion: ofis kağızı") a', 1800); await p.waitForSelector('h1', { timeout: 15000 }); await h.holdUntil(0.95); } },
    { az: 'Yuxarıdaki panel auksionun bütün vəziyyətidir. Başlanğıc qiymət — sifarişçinin elan etdiyi tavan. Ondan yuxarı təklif ümumiyyətlə qəbul olunmur.',
      do: async (p, l, h) => { await h.scrollTo('.card:has(h3:has-text("Auksion"))'); await h.holdUntil(0.4); await h.moveTo(p.locator('.card:has(h3:has-text("Auksion")) b').nth(0)); await h.holdUntil(0.95); } },
    { az: 'Yanında cari ən yaxşı qiymət var — kimin verdiyi göstərilmir, yalnız rəqəm. Növbəti sütun isə ən vacibidir: sizdən qəbul olunacaq maksimum. O, həmişə ən yaxşıdan bir addım aşağıdır.',
      do: async (p, l, h) => { const b = p.locator('.card:has(h3:has-text("Auksion")) b'); await h.moveTo(b.nth(1)); await h.holdUntil(0.45); await h.moveTo(b.nth(2)); await h.holdUntil(0.95); } },
    { az: 'Addım təsadüfi deyil, sifarişçi tərəfindən əvvəlcədən təyin olunub. Bu, qiymətin bir qəpiklik fərqlərlə saatlarla döyülməsinin qarşısını alır — hər təklif real endirim olur.',
      do: async (p, l, h) => { const b = p.locator('.card:has(h3:has-text("Auksion")) b'); await h.moveTo(b.nth(2)); await h.holdUntil(0.35); await h.moveTo(b.nth(0)); await h.holdUntil(0.65); await h.moveTo(b.nth(1)); await h.holdUntil(0.95); } },
    { az: 'Panel həm də iştirakçıların sayını və uzadılmaların sayını göstərir. Rəqəmlər köhnəlsə — yəni son yeniləmə alınmasa — panel bunu özü deyir, köhnə rəqəmi təzə kimi göstərmir.',
      do: async (p, l, h) => { const c = p.locator('.card:has(h3:has-text("Auksion"))'); await h.moveTo(c.locator('b').nth(3)); await h.holdUntil(0.35); await h.moveTo(c.locator('b').nth(4)); await h.holdUntil(0.62); await h.moveTo(c.locator('.hint').last()); await h.holdUntil(0.95); } },
    { az: 'Təklifi aşağıdaki formadan veririk: vahid qiyməti göstərib düyməni basırıq. Düymənin özündə şimşək var, qıfıl yox — çünki burada gizlədiləcək heç nə yoxdur. Sistem dərhal yoxlayır ki, rəqəm icazə verilən maksimumdan aşağıdırmı.',
      do: async (p, l, h) => { await h.scrollTo('.card:has(h3:has-text("Mövqelər"))'); await h.holdUntil(0.35); await h.fill(p.locator('.card:has(h3:has-text("Mövqelər")) input[step="0.01"]').first(), '5.75'); await h.holdUntil(0.7); await h.moveTo('.card:has(h3:has-text("Mövqelər")) button.btn'); await h.holdUntil(0.95); } },
    { az: 'Və son qayda: kimsə lap son saniyələrdə qiyməti sındırsa, son tarix avtomatik uzanır və uzadılmaların sayı panelə yazılır. Bu, «son anda vurub qaçmaq» taktikasını mənasız edir — hamının cavab vermək imkanı qalır.',
      do: async (p, l, h) => { await h.scrollTo('.card:has(h3:has-text("Auksion"))'); await h.holdUntil(0.4); await h.moveTo(p.locator('.card:has(h3:has-text("Auksion")) b').nth(4)); await h.holdUntil(0.7); await h.moveTo(p.locator('.card:has(h3:has-text("Auksion")) .hint').last()); await h.holdUntil(0.95); } },
  ]},
  // Supplier verification: the dossier from the side that assembles it.
  'sup-verification': { role: 'sup', path: '/supplier/verification', scenes: [
    { az: 'Yoxlama bölməsi. Burada sifarişçinin sizin haqqınızda açdığı iş var. Məqsəd sadədir: sənədləriniz təsdiqlənəndən sonra sizə tender gözləmədən birbaşa sifariş vermək olur.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.4); await h.moveTo('table'); await h.holdUntil(0.95); } },
    { az: 'Siyahıda sifarişçi şirkət, işin statusu və yüklədiyiniz sənədlərin sayı görünür. Altdaki sətir nə edəcəyinizi deyir: sənədləri görmək və yenisini əlavə etmək üçün şirkətin adına klikləmək lazımdır.',
      do: async (p, l, h) => { const r = p.locator('tbody tr').first(); await h.moveTo(r.locator('td').nth(0)); await h.holdUntil(0.35); await h.hover(r.locator('.badge'), 1300); await h.holdUntil(0.68); await h.moveTo(p.locator('.hint').first()); await h.holdUntil(0.95); } },
    { az: 'İşi açırıq. Aşağıda artıq yüklənmiş sənədlər sıralanır: hər birinin növü, faylın adı və qısa kod.',
      do: async (p, l, h) => { await h.click(p.locator('tbody tr a').first(), 1600); await h.scrollTo(p.locator('.card').last()); await h.holdUntil(0.95); } },
    { az: 'Yeni sənəd əlavə etmək üçün əvvəlcə növü seçirsiniz — VÖEN şəhadətnaməsi, lisenziya, bank arayışı, sığorta — sonra faylı göstərirsiniz. Növ vacibdir: sifarişçi sənədləri məhz növünə görə axtarır.',
      do: async (p, l, h) => { const sel = p.locator('.card').last().locator('select').first(); if (await sel.count()) { await h.moveTo(sel); await h.holdUntil(0.55); await h.moveTo(p.locator('input[type=file]').first()); } await h.holdUntil(0.95); } },
    { az: 'Yüklənən hər fayl üçün sistem məzmunun barmaq izini saxlayır — izahı da bunu deyir. Bu, sizin də xeyrinizədir: sonradan heç kim iddia edə bilməz ki, siz başqa sənəd göndərmisiniz. Fayl həm də antivirusdan keçir, yoluxmuş fayl sistemə düşmür.',
      do: async (p, l, h) => { const mono = p.locator('.card').last().locator('.hint[data-tip]').first(); if (await mono.count()) { await h.hover(mono, 1800); } else { await h.moveTo(p.locator('.card').last()); } await h.holdUntil(0.95); } },
    { az: 'Sonra qərar sifarişçinin tərəfindədir. Təsdiq alan kimi idarə panelinizdəki yoxlama sətri yaşıla dönür və birbaşa sifarişlər açılır — bu, sizin üçün əlavə satış kanalıdır. Nə qədər ki qərar verilməyib, sətir nə gözlənildiyini deyir.',
      do: async (p, l, h) => { await h.scrollTo('h1'); await h.holdUntil(0.3); await h.moveTo(p.locator('tbody tr').first().locator('.badge')); await h.holdUntil(0.7); await h.moveTo('table'); await h.holdUntil(0.95); } },
  ]},
  // Supplier catalogs — the first of the two sections that had no recording at all, and the
  // reason they could not borrow the buyer's: this page renders the SAME component as
  // /buyer/catalogs with `isBuyer` false, so the activate button, the quantity field, the
  // department select and the «Sifariş» button are not merely disabled, they are not drawn.
  // Pointing a supplier at `buyer-catalogs` would have walked him through four controls he
  // does not have. What he DOES do here is read: whose catalogue it is, whether it is live,
  // and at which agreed prices his own goods may now be called off without a tender.
  // Nothing on the page can be pressed, so the scenes read and the one action is an
  // expand — a GET that leaves the stand exactly as the other recordings need it.
  'sup-catalogs': { role: 'sup', path: '/supplier/catalogs', scenes: [
    { az: 'Kataloqlar bölməsi. Burada sifarişçinin sizinlə razılaşdırdığı qiymət cədvəli durur. Kataloq tender deyil: qiymətlər bir dəfə razılaşdırılır, sonra sifarişçi təkrarlanan xırda alışları hər dəfə prosedur keçirmədən verir.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.45); await h.moveTo('table'); await h.holdUntil(0.92); } },
    { az: 'Cədvəldə dörd sütun var: kataloqun adı, sifarişçi, status və mövqelərin sayı. İkinci sütuna diqqət edin — orada sifarişçi yazılıb, çünki bu, sizin ekranınızdır. Eyni cədvəl sifarişçinin özündə təchizatçının adını göstərir.',
      do: async (p, l, h) => { const th = p.locator('thead th'); await h.moveTo(th.nth(0)); await h.holdUntil(0.3); await h.moveTo(th.nth(1)); await h.holdUntil(0.6); await h.moveTo(p.locator('tbody tr').first().locator('td').nth(1)); await h.holdUntil(0.92); } },
    { az: 'Mövqelərin sayının öz izahı var — rəqəm tək başına nəyin sayı olduğunu demir. Kataloqu sifarişçi müqavilədən yaradır, qiymətlər isə sizin udmuş təklifinizdən köçürülür. Yəni buradaki rəqəmləri heç kim əl ilə yazmır.',
      do: async (p, l, h) => { await h.hover(p.locator('thead th').nth(3), 1600); await h.holdUntil(0.6); await h.moveTo(p.locator('tbody tr').first().locator('td').nth(3)); await h.holdUntil(0.92); } },
    { az: 'Status iki şeyi deyir. Aktiv kataloq üzrə sifariş vermək mümkündür; qaralama hələ hazırlıq mərhələsidir. Sifarişçidə burada «Aktivləşdir» düyməsi olur — sizdə o düymə yoxdur, və bu qəsdəndir: kataloqu işə salmaq onun qərarıdır, siz nəticəsini görürsünüz.',
      do: async (p, l, h) => { await h.hover(p.locator('tbody .badge').first(), 1600); await h.holdUntil(0.6); await h.moveTo(p.locator('thead th').nth(2)); await h.holdUntil(0.92); } },
    { az: 'Kataloqun adına klikləyirik — içindəki mövqelər açılır.',
      do: async (p, l, h) => { await h.moveTo(p.locator('tbody tr a').first()); await h.holdUntil(0.45); await h.click(p.locator('tbody tr a').first(), 1600); await h.holdUntil(0.95); } },
    { az: 'Üç sütun: mövqenin adı, minimum sifariş həcmi və razılaşdırılmış vahid qiymət. Minimum həcm sizin şərtinizdir — ondan az sifariş sistem qəbul etmir, və sütunun izahı da bunu deyir. Qiymət isə razılaşdırılmış qiymətdir, siyahı qiyməti deyil.',
      do: async (p, l, h) => { const card = p.locator('.card').last(); await h.scrollTo(card); await h.holdUntil(0.3); await h.hover(card.locator('thead th').nth(1), 1600); await h.holdUntil(0.65); await h.moveTo(card.locator('thead th').nth(2)); await h.holdUntil(0.93); } },
    { az: 'Mövqelər sətir-sətir durur, hər birinin öz minimumu və öz qiyməti var. Bu səhifədə sizin üçün bir düymə də yoxdur, və bu çatışmazlıq deyil: qiymət razılaşdırılıb, ona görə onu buradan dəyişmək mümkün olmamalıdır. Kataloqda qiymətin redaktəsi ümumiyyətlə yoxdur — dəyişiklik lazımdırsa, bu, müqavilə səviyyəsində həll olunur.',
      do: async (p, l, h) => { const card = p.locator('.card').last(); const rows = card.locator('tbody tr'); await h.moveTo(rows.nth(0)); await h.holdUntil(0.35); await h.moveTo(rows.nth(1).locator('td').nth(1)); await h.holdUntil(0.65); await h.moveTo(rows.nth(2).locator('td').nth(2)); await h.holdUntil(0.93); } },
    { az: 'Sifarişçi kataloqdan sifariş verəndə o, tendersiz və danışıqsız dərhal yaranır — əvvəlcə qaralama kimi, sonra sifarişçi onu verir və sifariş sizin «İşdə olan sifarişlər» ekranınızda adi sifariş kimi işə düşür: təsdiq, qablaşdırma, göndərmə, çatdırılma, qaimə. Yəni bu cədvəl sizin daimi təklifinizdir: qiymət bir dəfə razılaşdırılıb durur, sifariş isə özü gəlir.',
      do: async (p, l, h) => { await h.scrollTo('h1'); await h.holdUntil(0.3); await h.moveTo(p.locator('tbody tr').first().locator('.badge')); await h.holdUntil(0.6); await h.moveTo('table'); await h.holdUntil(0.93); } },
  ]},
  // Supplier contracts — the second missing one, and read from the side that has to DELIVER
  // against the ceiling rather than set it. Same component as /buyer/contracts with
  // `isBuyerSide` false: neither table draws an actions column at all (there is a browser
  // spec for exactly that), so the buyer's recording would have spent half its length on
  // «Aktivləşdir», «Sifariş yarat», «Mal qəbulu» and «Dəyişdir» — four controls a supplier
  // never sees. The ONE press here is a navigation into the order's own card, which changes
  // nothing on the stand; the forward steps live in `sup-orders` and stay there.
  'sup-contracts': { role: 'sup', path: '/supplier/contracts', scenes: [
    { az: 'Müqavilələr bölməsi. Müqavilə sizin udmuş təklifinizdən doğulur: tenderdə qalib seçiləndən sonra sistem təklifin şərtlərini müqaviləyə köçürür. Ona görə buradaki rəqəmlər sonrakı danışıqdan yox, sizin öz təklifinizdən gəlir.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.45); await h.moveTo(p.locator('.card').first().locator('table')); await h.holdUntil(0.92); } },
    { az: 'Sütunlar: müqavilənin nömrəsi, başlıq, sifarişçi, qüvvədə olma müddəti, ümumi məbləğ, istifadə olunmuş hissə, status və bu müqavilə üzrə verilmiş sifarişlərin sayı. Ümumi məbləğ müqavilənin tavanıdır — birdəfəlik ödəniş deyil.',
      do: async (p, l, h) => { const th = p.locator('.card').first().locator('thead th'); await h.moveTo(th.nth(0)); await h.holdUntil(0.28); await h.moveTo(th.nth(3)); await h.holdUntil(0.55); await h.moveTo(th.nth(4)); await h.holdUntil(0.8); await h.moveTo(th.nth(7)); await h.holdUntil(0.93); } },
    { az: 'İstifadə olunub sütunu tavandan nə qədərinin sifarişlərə çevrildiyini göstərir, və onun izahı var: ləğv edilmiş və rədd edilmiş sifarişlər bu cəmə düşmür. Bu rəqəm təchizatçıya da lazımdır — çərçivə müqaviləsi bir neçə sifarişə bölünür, və burada hər iki rəqəm bərabərdir, yəni müqavilə tam istifadə olunub.',
      do: async (p, l, h) => { await h.hover(p.locator('thead th:has-text("İstifadə olunub")').first(), 1700); await h.holdUntil(0.6); const row = p.locator('tbody tr:has-text("CTR-2026-0001")').first(); await h.moveTo(row.locator('td').nth(4)); await h.holdUntil(0.78); await h.moveTo(row.locator('td').nth(5)); await h.holdUntil(0.93); } },
    { az: 'Status yalnız aktiv müqavilənin sifariş buraxa bildiyini deyir. Müqaviləni aktivləşdirmək sifarişçinin addımıdır, ona görə bu cədvəldə sizin üçün əməliyyatlar sütunu ümumiyyətlə çəkilmir — boş sütun da yerini tutur və «burada nəsə etmək lazımdır» deyə oxunur.',
      do: async (p, l, h) => { const row = p.locator('tbody tr:has-text("CTR-2026-0001")').first(); await h.hover(row.locator('.badge').first(), 1600); await h.holdUntil(0.6); await h.moveTo(p.locator('.card').first().locator('thead th').last()); await h.holdUntil(0.93); } },
    { az: 'Aşağıda satınalma sifarişləri — bu müqavilə üzrə və ondan kənarda verilmiş bütün sifarişlər bir siyahıda. Burada onlar yalnız oxunur: nömrə, sifarişçi, tarix, məbləğ və status. İşin özü — təsdiq, qablaşdırma, göndəriş, qaimə — «İşdə olan sifarişlər» bölməsindədir. Yəni bu səhifə hesabatdır, o səhifə iş yeridir.',
      do: async (p, l, h) => { await h.scrollTo('h3:text-is("Satınalma sifarişləri")'); await h.holdUntil(0.4); const card = p.locator('.card:has(h3:text-is("Satınalma sifarişləri"))'); await h.moveTo(card.locator('table')); await h.holdUntil(0.72); await h.moveTo(card.locator('thead th').nth(2)); await h.holdUntil(0.93); } },
    { az: 'Status sütunu sifarişin harada olduğunu deyir: verilib, təchizatçı təsdiqləyib, göndərilib, çatdırılıb, qəbul edilib. Qaralama statuslu sətir də görünür — o, hələ verilməmiş, sifarişçinin hazırladığı sifarişdir; nişanın üzərinə gətirsəniz, hər statusun izahı açılır.',
      do: async (p, l, h) => { const card = p.locator('.card:has(h3:text-is("Satınalma sifarişləri"))'); await h.hover(card.locator('tbody tr').first().locator('.badge'), 1500); await h.holdUntil(0.45); await h.hover(card.locator('tbody tr:has-text("PO-2026-0004") .badge').first(), 1400); await h.holdUntil(0.72); await h.hover(card.locator('tbody tr:has-text("PO-2026-0001") .badge').first(), 1400); await h.holdUntil(0.93); } },
    { az: 'Sifarişin nömrəsi onun öz səhifəsinə aparır. Müqavilə üzrə verilmiş sifarişi açırıq.',
      do: async (p, l, h) => { const link = p.locator('tbody tr:has-text("PO-2026-0001") a').first(); await h.moveTo(link); await h.holdUntil(0.4); await h.click(link, 1800); await p.waitForSelector('h1', { timeout: 15000 }); await h.holdUntil(0.95); } },
    { az: 'Başlıqda nömrə və status. Altda sifarişçi, məbləğ və iki tarix: sifariş nə vaxt yaradılıb və nə vaxt sizə verilib. Onlar eyni gün də ola bilər, fərqlənə də — sifariş əvvəlcə qaralama kimi yaranır, verilmə isə onu sizə göndərən andır.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.35); await h.moveTo(p.locator('.fact').nth(0)); await h.holdUntil(0.6); await h.moveTo(p.locator('.fact').nth(2)); await h.holdUntil(0.78); await h.moveTo(p.locator('.fact').nth(3)); await h.holdUntil(0.93); } },
    { az: 'Sonra səhifənin ən faydalı sətri: bu sifariş hansı müqaviləyə əsaslanır və hansı tenderdən gəlir. Tenderin yanında keçid var, yəni öz udduğunuz prosedura geri qayıdıb şərtləri oxuya bilirsiniz. Sifarişçinin daxili sorğusu burada görünmür — o, onun öz sənədidir, və bunu gizlədən əlavə şərt deyil, bazanın öz qaydasıdır.',
      do: async (p, l, h) => { const chain = p.locator('.fact-row').nth(1); await h.moveTo(chain.locator('.fact').nth(0)); await h.holdUntil(0.45); await h.moveTo(chain.locator('.fact').nth(0).locator('.fact-v')); await h.holdUntil(0.7); await h.hover(chain.locator('a').first(), 1500); await h.holdUntil(0.93); } },
    { az: 'Sifarişin sətirləri üç miqdarı üz-üzə qoyur: nə sifariş edilib, faktiki nə qəbul edilib və qaiməyə nə qalıb. Üçüncü rəqəm sizin üçün ən vacibidir — qaimə məhz ondan doldurulur. Burada sıfırdır, çünki qəbul edilmiş miqdarın hamısına qaimə artıq verilib.',
      do: async (p, l, h) => { const card = p.locator('.card:has(h3:text-is("Sifarişin sətirləri"))'); await h.scrollTo(card); await h.holdUntil(0.3); const th = card.locator('thead th'); await h.moveTo(th.nth(2)); await h.holdUntil(0.5); await h.moveTo(th.nth(3)); await h.holdUntil(0.7); await h.moveTo(th.nth(4)); await h.holdUntil(0.85); await h.moveTo(card.locator('tbody tr').first().locator('td').nth(4)); await h.holdUntil(0.95); } },
    { az: 'Aşağıda tarixçə: hər status dəyişikliyi vaxtı və səbəbi ilə. Bu, mübahisədə ən sadə dəlildir — nə vaxt göndərdiyinizi və nə vaxt qəbul edildiyini yadda saxlamaq lazım gəlmir.',
      do: async (p, l, h) => { const card = p.locator('.card:has(h3:text-is("Tarixçə"))'); await h.scrollTo(card); await h.holdUntil(0.4); await h.moveTo(card.locator('tbody tr').first()); await h.holdUntil(0.68); await h.moveTo(card.locator('tbody tr').last()); await h.holdUntil(0.93); } },
    { az: 'Ən sonda logistika: daşıyıcı, izləmə nömrəsi və göndərişin cari vəziyyəti. Hadisələri siz özünüz «İşdə olan sifarişlər» bölməsində əlavə edirsiniz, burada isə onların yekunu görünür. Beləliklə bir səhifədə üç sual bağlanır: nə razılaşdırılıb, nə sifariş edilib və nə baş verib.',
      do: async (p, l, h) => { const card = p.locator('.card:has(h3:has-text("Logistika"))'); await h.scrollTo(card); await h.holdUntil(0.4); await h.moveTo(card.locator('.fact').nth(0)); await h.holdUntil(0.62); await h.moveTo(card.locator('.fact').nth(1)); await h.holdUntil(0.78); await h.moveTo(card.locator('.fact').nth(2)); await h.holdUntil(0.93); } },
  ]},

};

// How far a finished file may stand from the length the course promises, in seconds.
// The declared numbers are the measured ones rounded to a whole second, so anything past a
// couple of seconds is a real divergence and not rounding.
const SEC_TOLERANCE = 2;

// What /learn promises each lesson lasts, read straight out of apps/web/src/guides.ts.
//
// Those numbers are measured BY HAND and then written down, and nothing downstream notices
// when a re-recording changes a length: the poster is still there, the video still answers
// 200, every test stays green — and the course page goes on offering «5:48» for a clip that
// now runs four minutes. The only one who finds out is the viewer. So the file is measured
// HERE, where it is born, and held against what the product says about it.
//
// Parsed rather than imported: this is a .mjs script and guides.ts is TypeScript inside the
// web app's build. The shape it looks for is one lesson object per line, which is how the
// COURSE tracks are written.
//
// A lesson is found by what MAKES it a lesson — its own `key` and its `titleKey` — and only
// then is `sec` read out of that same line. The first version instead matched one pattern
// for the whole object with `sec` as its last field, and that is a different, worse thing:
// swap two fields of one lesson and the line stops matching entirely, so that lesson simply
// disappears from the map. Nineteen of twenty still parse, the floor below is still clear,
// and the comparison then reports the lost key as «not in the course yet» — an informational
// line, on a successful run, from a guard that looks like it is working. Measured on this
// branch before the fix: reordering one lesson's fields dropped `sup-auction` and the run
// stayed green. A guard that greens on its own blindness is the thing this file exists to
// prevent, so a line that IS a lesson and carries no readable `sec` is now a refusal by name.
function courseSeconds() {
  const file = join(ROOT, 'apps/web/src/guides.ts');
  const src = readFileSync(file, 'utf8');
  // How many lessons there HAVE to be, counted from a different angle than the loop below
  // reads them. Everything in the loop hangs on `key` and `titleKey` sharing a line, so it
  // cannot notice a lesson that was split across two — the line carries no pair, nothing
  // matches, and the lesson is skipped without ever reaching `noSec`. Measured: moving
  // `titleKey` to a second line loses `sup-auction` silently, and the informational branch
  // then calls it a recording the course does not list. A quoted `key:` appears in this file
  // ONLY in lessons (the interfaces write `key: string`, the GUIDES rows write `'/route':
  // g('…')`), so counting those is an independent answer to «how many», and the two answers
  // disagreeing is the signal. If some future structure borrows the same spelling this will
  // cry wolf — which is the right way round: a false alarm names the file and gets fixed,
  // a silent miss is what this whole function exists to stop.
  const declaredLessons = (src.match(/\bkey:\s*'/g) ?? []).length;
  const map = new Map();
  const noSec = [];
  for (const line of src.split('\n')) {
    // `\bkey:` cannot match inside `titleKey:` (no word boundary there, and the case
    // differs), and the quote keeps the `key: string` of the interface declaration out.
    const key = line.match(/\bkey:\s*'([a-z0-9-]+)'/);
    if (!key || !/\btitleKey:/.test(line)) continue; // a COURSE lesson, not a GUIDES row
    const sec = line.match(/\bsec:\s*(\d+(?:\.\d+)?)/);
    if (sec) map.set(key[1], Number(sec[1]));
    else noSec.push(key[1]);
  }
  if (noSec.length) {
    throw new Error(`В ${file} у урока нет читаемого sec: ${noSec.join(', ')}. `
      + `Либо поле потеряно, либо разбор устарел — в обоих случаях длительность этой записи `
      + `сверять не с чем, а молча пропустить её значит объявить сторож работающим зря.`);
  }
  if (map.size + noSec.length !== declaredLessons) {
    throw new Error(`В ${file} уроков ${declaredLessons}, а разобрано ${map.size + noSec.length}. `
      + `Скорее всего урок записан не одной строкой — тогда он пропадает из разбора молча, `
      + `и его длительность никто не сверит. Либо верните урок в одну строку, либо научите `
      + `courseSeconds() его форме.`);
  }
  // And a floor under the whole thing: if the COURSE is ever rewritten in a shape where a
  // lesson is not one line, nothing above matches, nothing is reported missing, and every
  // comparison below would pass without comparing anything.
  if (map.size < 10) {
    throw new Error(`Не удалось прочитать длительности уроков из ${file}: найдено ${map.size}. `
      + `Разбор устарел — сверка длительностей превратилась бы в молчаливое «всё хорошо».`);
  }
  return map;
}

// What the stand must actually HOLD for a section to film what it narrates.
//
// The cursor-miss counter only sees scenes that aim at something. A scene that merely
// looks at a panel films an empty page without a single miss, so the counter cannot be
// the only guard. This is not hypothetical: `Auksion: ofis kağızı` closed by itself four
// days after the stand was filled (demo-fill sets close_at relative to fill time, so a
// fresh stand is fine and only a long-lived one rots), the «Mövqelər» card went with it,
// and the bid scene played over a dead screen.
//
// Asked of the database before any browser opens, and asked THROUGH assertDemoTarget so
// this cannot become a second route to a non-disposable stack. A run that cannot ask is
// refused rather than quietly filmed: a check that passes when it fails to run is the
// one thing worse than no check.
// The declarations above are read BY NAME, and a name read by hand is a name that can be
// misspelled. `requires: { eventOpenn: … }` or `require: { eventOpen: … }` both leave the
// guard's list short — and if every declaration is misspelled, empty, so it returns at once
// and the run proceeds as if the stand had been checked. That is the very blindness the
// guard exists to prevent, one level up: it would green on its own failure to read.
//
// So the shape is checked instead of trusted. A section carries exactly these fields and a
// `requires` exactly these predicates; anything else stops the run and is named. Checked for
// EVERY section, not only the ones being filmed: a typo in a section nobody films today is
// still a requirement that will not be enforced tomorrow, and it costs one line to fix now.
const SECTION_FIELDS = new Set(['role', 'path', 'requires', 'before', 'scenes']);
const REQUIRE_PREDICATES = new Set(['eventOpen']);
// A scene is narration per language plus the camera move. `do` is the dangerous name here:
// it is called as `scene.do?.(…)`, so a scene whose `do` is misspelled performs NO action,
// raises nothing, counts no miss — and the run ends by printing «промахов курсора: 0» over a
// motionless picture. Misspelt, it is simply an unknown field, which is why this list is the
// whole fix.
//
// This is the scene AS DECLARED, and that makes assertSectionShape a START-OF-RUN check and
// nothing else: the narration pass writes `audio` and `sec` onto these same objects (see
// SECTIONS[key].scenes[i].audio = … below), so called again after tts() it would refuse every
// scene in the file. Calling it a second time, say right before recording, is the natural
// thing to reach for — hence this note. The service fields are deliberately NOT admitted to
// the list: listing them would licence a typo named `sec`, which is the hole this closes.
const SCENE_FIELDS = new Set(['az', 'ru', 'en', 'do', 'as', 'must']);

function assertSectionShape() {
  const bad = [];
  for (const [key, section] of Object.entries(SECTIONS)) {
    for (const field of Object.keys(section)) {
      if (!SECTION_FIELDS.has(field)) bad.push(`${key}: неизвестное поле «${field}» — опечатка? Допустимы: ${[...SECTION_FIELDS].join(', ')}`);
    }
    for (const predicate of Object.keys(section.requires ?? {})) {
      if (!REQUIRE_PREDICATES.has(predicate)) bad.push(`${key}.requires: неизвестное требование «${predicate}» — опечатка? Допустимы: ${[...REQUIRE_PREDICATES].join(', ')}`);
    }
    (section.scenes ?? []).forEach((scene, i) => {
      for (const field of Object.keys(scene)) {
        if (!SCENE_FIELDS.has(field)) bad.push(`${key}, сцена ${i + 1}: неизвестное поле «${field}» — опечатка? Допустимы: ${[...SCENE_FIELDS].join(', ')}`);
      }
    });
  }
  if (bad.length) {
    throw new Error(`Объявления разделов прочитаны не полностью — такое объявление молча не работало бы:\n  `
      + `${bad.join('\n  ')}`);
  }
}

// The key an operator typed. `sup-catalogz` passes every check above — it is not a section at
// all — so the stand guard requires nothing for it and the run dies much later on a bare
// «Cannot read properties of undefined», naming neither the key nor the typo.
function assertKeysExist(keys) {
  const unknown = keys.filter((k) => !SECTIONS[k]);
  if (unknown.length) {
    throw new Error(`Таких разделов нет: ${unknown.map((k) => `«${k}»`).join(', ')}.\n`
      + `  Есть: ${Object.keys(SECTIONS).join(', ')}`);
  }
}

async function assertStandHolds(keys) {
  const wanted = [...new Set(keys.flatMap((k) => SECTIONS[k]?.requires?.eventOpen ?? []))];
  if (!wanted.length) return;
  let pg, dbName;
  try {
    ({ pg, dbName } = assertDemoTarget(process.env, API_URL));
  } catch (e) {
    throw new Error(`Нечем проверить состояние стенда (${e.message}). Эти разделы требуют живого события, `
      + `поэтому прогон остановлен: передайте DEMO_ISOLATED=1, DEMO_PG_CONTAINER, DEMO_API_CONTAINER и DEMO_API.`);
  }
  const problems = [];
  for (const title of wanted) {
    // -U matches POSTGRES_USER in infra/docker-compose.demo.yml. The query goes in over
    // STDIN, not -c: psql interpolates :'title' only in a script it lexes itself, and with
    // -c the string is handed to the server verbatim — which fails on the colon. Feeding it
    // in keeps the title quoted by psql instead of by us.
    const found = execFileSync('docker', ['exec', '-i', pg, 'psql', '-U', 'leadprocure_owner', '-d', dbName, '-At',
      '-v', `title=${title}`, '-f', '-'],
      { encoding: 'utf8', input: "SELECT status, close_at > now(), to_char(close_at,'YYYY-MM-DD HH24:MI')"
        + " FROM sourcing_events WHERE title = :'title';" }).trim();
    // EVERY row, not the first one: the query cannot promise a single match and `-At`
    // separates rows by a newline, so reading the output as one record made
    // «OPEN|t|…\nCLOSED|f|…» pass as open — the guard waving through the very state it
    // exists to catch. A stand filled twice really does hold two events of one name:
    // demo-fill clears the old story only under DEMO_RESET.
    //
    // ANY duplicate is refused, including two open ones. The scenes reach their event by
    // title and click `.first()`, so with two matches the recording films whichever row
    // Postgres happened to return — a different event between one run and the next, with
    // its own lots, bids and best price, while the narration describes figures as if there
    // were one. Both being open only hides that: the scene plays, and the footage is still
    // not the event anybody chose. A stand holding two events of one name is broken, and
    // this says so instead of filming it.
    const rows = found.split('\n').filter(Boolean).map((r) => r.split('|'));
    if (!rows.length) { problems.push(`«${title}»: события нет на стенде`); continue; }
    if (rows.length > 1) {
      problems.push(`«${title}»: событий с этим названием ${rows.length} (${rows.map(([st]) => st).join(', ')}) — `
        + `стенд залит дважды без DEMO_RESET; какое из них попадёт в кадр, решает Postgres, а не сценарий`);
      continue;
    }
    const [status, live, closes] = rows[0];
    if (status !== 'OPEN' || live !== 't') problems.push(`«${title}»: статус ${status}, срок ${closes} — приём закрыт`);
    else console.log(`  стенд: «${title}» принимает ставки до ${closes}`);
  }
  if (problems.length) {
    throw new Error(`Стенд не в том состоянии, которое снимают эти разделы:\n  ${problems.join('\n  ')}\n`
      + `Пересейте стенд (RESEED=1) или продлите срок события — снимать закрытое событие нельзя, `
      + `сцена отыграет по пустому экрану и промаха не будет.`);
  }
}

// Кто играет роль. До этого актёров было два — администратор и поставщик, — и история
// «как новый сотрудник начинает работать» снять ими было нельзя: заявку в продукте заводит
// BUYER_USER, утверждает BUYER_APPROVER, а бюджеты и сверку счетов видит BUYER_FINANCE, и у
// каждого свой набор ручек и своё меню. Снимать их админом значило бы показывать не то, что
// увидит зритель на своём месте.
//
// Учётки берутся из демо-наполнения (`apps/api/src/seed.ts`), пароль у всех один и тот же.
// `finance@acme.test` там появился вместе с этой работой: роль в продукте была, а записи под
// неё не существовало.
const ROLE_EMAIL = {
  buyer: 'admin@acme.test',         // закупщик: публикует тендер, вскрывает, присуждает
  requester: 'user@acme.test',      // новый сотрудник: заводит заявку (сидит в отделе OPS)
  approver: 'approver@acme.test',   // согласующий: утверждает заявку, владеет бюджетом IT
  finance: 'finance@acme.test',     // финансист: бюджеты, сверка и оплата счетов
  sup: 'seller@supply-one.test',    // поставщик: ставка, подтверждение заказа, счёт
  sup2: 'seller@baku-metal.test',   // второй поставщик: без второй ставки тендеру не с чем сравнивать
};

async function login(ctx, email) {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', 'Passw0rd!');
  await page.click('form button.btn:not(.ghost):not([type=button])');
  await page.waitForURL(/\/(buyer|supplier)\//, { timeout: 20000 });
  await page.close();
}

(async () => {
  const keys = ONLY.length ? ONLY : Object.keys(SECTIONS);
  // Before the stand is asked anything: these judge the source and the arguments, not the
  // data, and an early `return` added to assertStandHolds some day must not carry them off.
  assertSectionShape();
  assertKeysExist(keys);
  await assertStandHolds(keys);
  // Read before anything is recorded: a stale parse should stop the run at the start, not
  // after the footage and the narration have been paid for.
  const declaredSec = courseSeconds();
  const durationProblems = [];
  const tmp = mkdtempSync(join(tmpdir(), 'guides-'));
  console.log(`langs ${LANGS.join(',')} · stand ${BASE} · ${keys.length} sections`);

  for (const lang of LANGS) {
    // resume: skip sections whose file already exists (so a re-run continues)
    const todo = keys.filter((k) => process.env.FORCE || !existsSync(join(OUT, `${k}.${lang}.webm`)));
    if (!todo.length) { console.log(`\n=== ${lang}: all present, skip ===`); continue; }
    const engV = ENGINE[lang] === 'azure' ? `Azure ${AZURE_VOICE[lang]}` : `Gemini ${GEMINI_VOICE[lang]}`;
    console.log(`\n=== ${lang} (${engV}) · ${todo.length}/${keys.length} to do ===`);
    // Re-seed the stand with THIS language's demo story so lists match the narration.
    if (process.env.RESEED) {
      console.log(`  reseeding demo data (${lang})…`);
      try {
        execFileSync(process.execPath,[join(ROOT,'scripts/demo-fill.mjs'),API_URL], {
          env: { ...process.env, DEMO_RESET: '1', DEMO_LANG: lang }, stdio: 'pipe',
        });
      } catch { throw new Error('Disposable demo reseed failed; recording stopped'); }
    }
    // 1) narrate every scene in this language, measure durations
    for (const key of todo) {
      for (let i = 0; i < SECTIONS[key].scenes.length; i++) {
        const f = join(tmp, `${key}-${lang}-${i}.mp3`);
        // Scenarios are written in Azerbaijani (the only language the app ships). Falling
        // back keeps `LANGS=ru` runs from dying on an undefined narration instead of
        // silently producing a video with a missing scene.
        const narration = SECTIONS[key].scenes[i][lang] ?? SECTIONS[key].scenes[i].az;
        await tts(narration, lang, f);
        SECTIONS[key].scenes[i].audio = f;
        SECTIONS[key].scenes[i].sec = dur(f);
      }
    }

    // 2) record with the UI in THIS language, holding each scene for its narration
    const browser = await chromium.launch();
    const contexts = {};
    // Кому входить. Исполнитель объявляется не только разделом: сцена переключает актёра
    // полем `as`, и ровно на этом построена сквозная история (заявку заводит сотрудник,
    // утверждает согласующий — один экран, два человека). Пока здесь спрашивали только
    // `SECTIONS[k].role`, вход для `as`-актёра не создавался, и глава отказывалась сниматься
    // целиком со словами «нет роли: approver» — при верном объявлении.
    const actorsNeeded = new Set(todo.flatMap((k) => [
      SECTIONS[k].role, ...SECTIONS[k].scenes.map((sc) => sc.as).filter(Boolean),
    ]));
    for (const role of Object.keys(ROLE_EMAIL)) {
      if (!actorsNeeded.has(role)) continue;
      const ctx = await browser.newContext({
        // 1280 is above the narrow-layout breakpoint (NARROW = max-width 1100px, see
        // apps/web/src/components/narrow.ts), and that is load-bearing, not a taste: below
        // it the stylesheet stops laying tables out as tables and `thead` goes away
        // entirely. Every scene that points at a column heading — and there are many —
        // would then miss silently and play its narration over a motionless screen.
        // Do not lower this without re-checking every `thead th` selector below.
        viewport: { width: 1280, height: 720 },
        recordVideo: { dir: tmp, size: { width: 1280, height: 720 } },
      });
      ctx.setDefaultTimeout(20000);
      await ctx.addInitScript((l) => localStorage.setItem('lp_lang', l), lang);
      // Hide the section help card so a guide never films itself. Keyed off the card's own
      // marker attribute rather than a storage flag: CSS can't be defeated by a change in
      // how the app remembers dismissals (it moved from sessionStorage to a localStorage
      // per-section list once, and the recorder silently started filming the card).
      await ctx.addInitScript(() => {
        const css = '[data-help-video-widget]{display:none !important}';
        const apply = () => { const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s); };
        if (document.head) apply();
        else document.addEventListener('DOMContentLoaded', apply);
      });
      await login(ctx, ROLE_EMAIL[role]);
      contexts[role] = ctx;
    }

    const produced = [];
    // Чем оборвалась сквозная история, если оборвалась. Главы идут по одним данным, поэтому
    // после обрыва следующие снимать нельзя — но уже снятые сводятся и остаются на диске,
    // а отказ выносится в конец, после сведения.
    let broke = null;
    for (const key of todo) {
      const sec = SECTIONS[key];
      // Сцены раздела идут ПОДРЯД по актёрам: `as` у сцены переключает исполнителя, иначе
      // играет `role` раздела. Это нужно для сквозной истории — заявку заводит сотрудник, а
      // утверждает её согласующий, и это один и тот же экран. Одним контекстом так нельзя:
      // у Playwright видео пишется НА КОНТЕКСТ, а контекст на роль один (переиспользовать
      // storageState между контекстами нельзя — это воспроизводит оборот refresh-токена и
      // срабатывает защита от повторного использования, так и задумано). Поэтому каждый
      // прогон актёра пишется отдельной подзаписью, а потом они склеиваются.
      const runs = [];
      for (const scene of sec.scenes) {
        const actor = scene.as ?? sec.role;
        if (!runs.length || runs[runs.length - 1].actor !== actor) runs.push({ actor, scenes: [] });
        runs[runs.length - 1].scenes.push(scene);
      }
      const unknown = runs.map((r) => r.actor).filter((a) => !contexts[a]);
      if (unknown.length) {
        console.log(`✗ ${key}.${lang} SKIPPED — нет роли: ${[...new Set(unknown)].join(', ')}`);
        continue;
      }
      // Подготовка стенда к главе, если она объявлена. Падение здесь — обрыв истории, а
      // не пропуск главы: следующая глава снимала бы не то состояние.
      if (sec.before) {
        try { await sec.before(); }
        catch (e) {
          broke = `${key}: подготовка стенда не удалась — ${e.message.split('\n')[0]}`;
          console.log(`✗ ${key}.${lang} ОБОРВАНА — ${broke}`);
          break;
        }
      }
      const parts = [];
      let ok = true;
      for (const [runIdx, run] of runs.entries()) {
        const page = await contexts[run.actor].newPage();
        const t0 = Date.now();
        try {
          await page.goto(`${BASE}${sec.path}`);
          await page.waitForSelector('h1', { timeout: 20000 });
          await P(1000);
          // Постер снимается с ПЕРВОГО прогона: он показывает экран тем, кто начинает главу.
          if (runIdx === 0) await page.screenshot({ path: join(OUT, `${key}.${lang}.png`) }); // clean poster (no cursor)
          await injectCursor(page);
          const offsets = [];
          const LEAD = 650; // narration starts first; the cursor follows so voice never lags behind
          const h = makeHelpers(page);
          for (const scene of run.scenes) {
            const startMs = Date.now() - t0;      // смещение ВНУТРИ своей подзаписи
            offsets.push(startMs);
            SCENE = `${key}/${lang} сцена ${parts.reduce((n, x) => n + x.offsets.length, 0) + offsets.length}`;
            await P(LEAD);                        // let the voice begin before the cursor moves
            h.setSceneBudget(scene.sec * 1000);   // anchor holdUntil() to THIS narration
            try { await scene.do?.(page, lang, h); }
            catch (e) {
              // `must` — это сцена, которая что-то СОЗДАЁТ. Её промах нельзя записать в
              // журнал и поехать дальше: дальше снимать нечего.
              if (scene.must) throw Object.assign(new Error(`${SCENE}: ${e.message.split('\n')[0]}`), { fatal: true });
              console.log(`  (${key}/${lang}: ${e.message.split('\n')[0]})`);
            }
            // hold the scene until its narration (plus a small tail) has fully played out
            const remain = startMs + scene.sec * 1000 + 700 - (Date.now() - t0);
            // A scene whose actions outlast their narration leaves dead air. Say so here,
            // by scene number — otherwise it is only found afterwards, as silence in ffmpeg.
            if (remain < -1500) {
              console.log(`  ⏱ ${SCENE}: действия дольше озвучки на ${Math.round(-remain / 1000)}с`);
            }
            if (remain > 0) await P(remain);
          }
          await P(1200);
          parts.push({ actor: run.actor, video: page.video(), offsets, scenes: run.scenes.map((s) => ({ audio: s.audio })) });
          console.log(`  ✓ ${key}.${lang} · ${run.actor} (${Math.round((Date.now() - t0) / 1000)}s)`);
        } catch (e) {
          if (e.fatal) { broke = e.message; console.log(`✗ ${key}.${lang} ОБОРВАНА — ${e.message}`); }
          else console.log(`✗ ${key}.${lang} SKIPPED — ${e.message.split('\n')[0]}`);
          ok = false;
        } finally {
          await page.close().catch(() => {});
        }
        if (!ok) break;
      }
      if (ok && parts.length) {
        produced.push({ key, parts, actors: runs.map((r) => r.actor) });
        console.log(`✓ ${key}.${lang} — ${runs.length === 1 ? 'один актёр' : `актёры: ${runs.map((r) => r.actor).join(' → ')}`}`);
      }
      if (broke) break;
    }
    for (const c of Object.values(contexts)) await c.close();
    await browser.close();

    // 3) mux voice onto footage at recorded offsets
    for (const { key, parts } of produced) {
      // Склейка подзаписей и сдвиг смещений. Смещения внутри подзаписи считались от её
      // собственного начала, поэтому к каждому прибавляется длительность всех предыдущих
      // подзаписей — иначе голос второго актёра лёг бы на картинку первого. Длительность
      // берётся у самого файла (`dur`), а не из суммы сцен: у записи есть и хвост после
      // последней сцены, и он тоже кадры.
      const paths = [];
      for (const part of parts) paths.push(await part.video.path());
      let src = paths[0];
      if (paths.length > 1) {
        const list = join(tmp, `${key}.${lang}.concat.txt`);
        writeFileSync(list, paths.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
        src = join(tmp, `${key}.${lang}.joined.webm`);
        // `-c copy`: подзаписи пишет один и тот же движок Playwright с одинаковыми
        // настройками, перекодировать их незачем — и это сохраняет исходное качество.
        execSync(`ffmpeg -y -loglevel error -f concat -safe 0 -i "${list}" -c copy "${src}"`);
      }
      const scenes = [];
      const offsets = [];
      let shift = 0;
      for (const [i, part] of parts.entries()) {
        for (const [j, sc] of part.scenes.entries()) { scenes.push(sc); offsets.push(Math.round(shift + part.offsets[j])); }
        shift += dur(paths[i]) * 1000;
      }
      const inputs = scenes.map((s) => `-i "${s.audio}"`).join(' ');
      const delays = scenes.map((_, i) => `[${i + 1}:a]adelay=${offsets[i]}:all=1[a${i}]`).join(';');
      const mix = scenes.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${scenes.length}:normalize=0[a]`;
      const out = join(tmp, `${key}.${lang}.final.webm`);
      execSync(`ffmpeg -y -loglevel error -i "${src}" ${inputs} -filter_complex "${delays};${mix}" -map 0:v -map "[a]" -c:v copy -c:a libopus -b:a 64k "${out}"`);
      // copy+unlink, not rename: the scratch dir comes from os.tmpdir(), which on a box
      // with TMPDIR on a mounted volume is a DIFFERENT filesystem from the checkout, and
      // rename(2) across devices fails with EXDEV — after the recording and the mux have
      // already been paid for. Same filesystem or not, this costs one copy of a file we
      // are about to stop using.
      copyFileSync(out, join(OUT, `${key}.${lang}.webm`));
      rmSync(out, { force: true });
      const seconds = dur(join(OUT, `${key}.${lang}.webm`));
      console.log(`🎬 ${key}.${lang}.webm (${seconds.toFixed(1)}s)`);
      // Only az: the course ships the az recordings and its `sec` was measured on them, so
      // holding a ru or en file against that number would fail for being a different
      // language rather than a different cut.
      if (lang === 'az') {
        const declared = declaredSec.get(key);
        if (declared === undefined) {
          console.log(`  ↳ в курсе (apps/web/src/guides.ts) этого урока ещё нет — `
            + `объявить sec: ${Math.round(seconds)}`);
        } else if (Math.abs(seconds - declared) > SEC_TOLERANCE) {
          durationProblems.push(`${key}: файл ${seconds.toFixed(1)}с, в курсе объявлено ${declared}с`);
        }
      }
    }
    if (broke) {
      throw new Error(`Сквозная история оборвалась: ${broke}\n`
        + `  Следующие главы снимают то, что создаётся в предыдущих, поэтому прогон остановлен здесь.\n`
        + `  Уже снятые главы сведены и лежат в apps/web/public/guides — пересъёмка начинается с оборванной.`);
    }
  }
  if (MISSES) {
    console.log(`\n⚠ промахов курсора: ${MISSES} — эти сцены играли по неподвижному экрану, смотрите ✗ выше`);
  } else {
    console.log('\nпромахов курсора: 0');
  }
  // Loud, and last: every other line of the log is already printed, so the refusal is read
  // together with the run that produced it. The files are on disk — what is wrong is that
  // the course promises a different length, and only a person can say which of the two is
  // the mistake: a truncated recording, or a number nobody updated after re-recording.
  if (durationProblems.length) {
    throw new Error(`Длительность снятого файла расходится с тем, что обещает раздел «Обучение»:\n  `
      + `${durationProblems.join('\n  ')}\n`
      + `Либо запись обрезана — тогда переснимать, либо sec в COURSE (apps/web/src/guides.ts) `
      + `устарел — тогда поправить число. Допуск ${SEC_TOLERANCE}с.`);
  }
  console.log('Done. Rebuild the web container to ship.');
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
