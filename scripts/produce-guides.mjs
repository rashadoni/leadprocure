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
    // Дата. `<input type=date>` набирается посегментно и в порядке локали, поэтому
    // посимвольный набор туда кладёт мусор; `fill` принимает ISO-день как есть.
    async setDate(sel, iso, what) {
      const loc = L1(page, sel);
      try { await loc.waitFor({ state: 'visible', timeout: 8000 }); }
      catch { throw new Error(`нет поля даты «${what}»`); }
      await moveToLoc(page, loc);
      await loc.fill(iso);
      const got = await loc.inputValue().catch(() => null);
      if (got !== iso) throw new Error(`поле даты «${what}» получило «${got}», а не «${iso}»`);
      await P(300);
      return loc;
    },
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
  // Вторая покупка: нужна главе про живые торги. Товар нарочно простой и биржевой —
  // именно на таком аукцион уместен, а на мебели с требованиями к качеству нет.
  // 500 × 120 ₼ = 60 000 ₼, снова выше порога прямого заказа; шаг торга 1% = 600 ₼.
  title2: 'Ofis kağızı A4',
  item2: { name: 'A4 kağız, 500 vərəq', qty: '500', price: '120' },
  auction: ['115', '112', '109'],                            // 57 500 → 56 000 → 54 500 ₼
  deliveryDays: '14',
  buyer: 'Acme',
  supplier: 'Supply One',
  supplier2: 'Baku Metal',
};
// Своя строка истории в любой таблице заявок. По названию, а не по номеру: номер выдаёт
// база при создании, и сцена его знать не может.
const ROW = `tbody tr:has-text("${STORY.title}")`;
// Строка СВОЕГО заказа. У заказа нет названия закупки — только номер, который выдаёт
// база, поэтому у покупателя он ищется по поставщику, у поставщика по покупателю.
const PO_ROW_BUYER = `tbody tr:has-text("${STORY.supplier}")`;
const PO_ROW_SUP = `tbody tr:has-text("${STORY.buyer}")`;
const ROW2 = `tbody tr:has-text("${STORY.title2}")`;

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
  // ГЛАВА 13 истории, последняя: панель как итог недели. Снимает ТОТ ЖЕ новый сотрудник,
  // который в первой главе заводил заявку — он видит, чем кончилось его дело.
  'buyer-dashboard': { role: 'requester', path: '/buyer/dashboard', scenes: [
    { az: 'Bir həftə əvvəl mən burada ilk sorğumu yazırdım. İndi həmin satınalma başa çatıb: mebel gəlib, hesab ödənilib. İdarə paneli bunun nəticəsini bir ekranda göstərir.',
      must: true,
      do: async (p, l, h) => {
        await h.need('.card', 'göstəricilər');
        await h.moveTo('h1'); await h.holdUntil(0.45);
        await h.moveTo(p.locator('.card').nth(0)); await h.holdUntil(0.95);
      } },
    { az: 'Ümumi xərc: əlli səkkiz min manat. Bura yalnız qalib seçilmiş təkliflərin məbləği düşür, ƏDV-siz və yalnız manatla.',
      do: async (p, l, h) => { await h.hover(p.locator('.card').nth(0), 1400); await h.holdUntil(0.95); } },
    { az: 'Qənaət: altı min manat. Mənim smetam altmış dörd min idi, tender əlli səkkizə bağlandı. Fərqi rəqabət yaratdı, sənəd deyil.',
      do: async (p, l, h) => { await h.moveTo(p.locator('.card').nth(1)); await h.holdUntil(0.4); await h.hover(p.locator('.card').nth(1), 1400); await h.holdUntil(0.95); } },
    { az: 'Üç yük göstəricisi: işdə olan tenderlər, təsdiq gözləyən sorğular və bağlanmamış sifarişlər. Hamısı sıfırdır, çünki bu işin hər addımı tamamlanıb.',
      do: async (p, l, h) => { const c = p.locator('.card'); await h.moveTo(c.nth(2)); await h.holdUntil(0.35); await h.hover(c.nth(3), 1100); await h.holdUntil(0.65); await h.hover(c.nth(4), 1100); await h.holdUntil(0.95); } },
    { az: 'Aşağıda tapşırıqlar. Sistem bütün bölmələri özü gəzir və məndən qərar gözləyən işləri bir siyahıya yığır: zərfləri aç, sifarişi təsdiqlə, malı qəbul et. Siyahı boşdursa, heç nə gözləmir — və bu, ekranın ən faydalı halıdır.',
      do: async (p, l, h) => { await h.scrollTo('h3'); await h.holdUntil(0.5); await h.moveTo('h3'); await h.holdUntil(0.95); } },
    { az: 'Növbəti satınalma yenə sorğudan başlayacaq. Dairə belə bağlanır: ehtiyac, təsdiq, tender, müqavilə, çatdırılma, hesab və ödəniş — hamısı bir sistemdə və hamısı jurnalda.',
      do: async (p, l, h) => { await h.moveTo('a[href="/buyer/requests"]'); await h.holdUntil(0.6); await h.moveTo('h1'); await h.holdUntil(0.95); } },
  ]},
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
  'buyer-events': { role: 'buyer', path: '/buyer/requests', poster: '/buyer/events', scenes: [
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
      // Сначала читаем состояние и говорим о НЁМ. Первая редакция сразу пыталась закрыть
      // «OPEN» и при повторной съёмке падала с «close_due_events() не вернула ни одной
      // строки» — обвиняя функцию расписания там, где тендер уже был закрыт.
      const status = standSql(`SELECT status FROM sourcing_events WHERE title = '${STORY.title}';`);
      if (!status) throw new Error(`тендера «${STORY.title}» на стенде нет, а глава снимает его вскрытие`);
      if (status.includes('\n')) throw new Error(`тендеров «${STORY.title}» на стенде несколько (${status.split('\n').join(', ')})`);
      if (['CLOSED', 'OPENING', 'EVALUATION', 'AWARDED'].includes(status)) {
        throw new Error(`тендер уже в состоянии ${status}: глава начинается с ОТКРЫТОГО тендера, `
          + 'и переснимать её можно только на пересеянном стенде');
      }
      if (status !== 'OPEN') throw new Error(`тендер в состоянии ${status}, а должен быть OPEN`);
      standSql(`UPDATE sourcing_events SET close_at = now() - interval '2 minutes'
                 WHERE title = '${STORY.title}' AND status = 'OPEN';`);
      const closed = standSql('SELECT count(*) FROM close_due_events();');
      if (closed === '0') throw new Error('срок переведён в прошлое, но close_due_events() не закрыла ни одного события');
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
  // ГЛАВА 6 истории: договор из присуждения и заказ по договору.
  // Начинается на карточке тендера: договор рождается там, кнопкой «Müqavilə yarat».
  'buyer-contracts': { role: 'buyer', path: '/buyer/events', poster: '/buyer/contracts', scenes: [
    { az: 'Qalib seçilib, indi müqavilə. Onu tenderin kartındakı düymə yaradır: şərtlər, məbləğ və tərəflər oradan özü köçür — heç nə yenidən yazılmır.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick(`${ROW} a`, 'tenderin başlığı', 1500);
        await p.waitForURL(/\/buyer\/events\/[0-9a-f-]{36}/, { timeout: 15000 });
        const mk = await h.need('[data-testid=ev-make-contract]', '«Müqavilə yarat» düyməsi');
        await h.scrollTo(mk); await h.hover(mk, 1200); await h.holdUntil(0.95);
      } },
    { az: 'Basıram: müqavilə yaranır, dərhal qüvvəyə minir və məni müqavilələr bölməsinə aparır.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick('[data-testid=ev-make-contract]', '«Müqavilə yarat» düyməsi', 2500);
        await p.waitForURL(/\/buyer\/contracts/, { timeout: 15000 });
        await h.need(`${PO_ROW_BUYER} .badge.ACTIVE`, 'qüvvədə olan müqavilə');
        await h.moveTo(PO_ROW_BUYER); await h.holdUntil(0.95);
      } },
    { az: 'Müqavilənin sətri: nömrə, təchizatçı, müddət, tavan məbləğ və ondan nə qədərinin artıq götürüldüyü. Altında qalıq yazılır — sifariş məhz ona qarşı verilir.',
      do: async (p, l, h) => {
        await h.moveTo(`${PO_ROW_BUYER} td:nth-child(4)`); await h.holdUntil(0.35);
        await h.moveTo(`${PO_ROW_BUYER} td:nth-child(5)`); await h.holdUntil(0.6);
        await h.moveTo(`${PO_ROW_BUYER} td:nth-child(6)`); await h.holdUntil(0.95);
      } },
    { az: 'Sifariş yarat — müqavilədən sifariş çıxır. Sətirləri və məbləği müqavilə verir, ona görə sifarişdə səhv qiymət yaranmır.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick(`${PO_ROW_BUYER} [data-testid=contract-create-po]`, '«Sifariş yarat» düyməsi', 2200);
        await h.need(`${PO_ROW_BUYER} .badge.DRAFT`, 'yeni sifarişin sətri');
        await h.scrollTo(`${PO_ROW_BUYER} .badge.DRAFT`); await h.holdUntil(0.95);
      } },
    { az: 'Sifariş qaralamadır, və bu o deməkdir ki, təchizatçı onu hələ görmür — nə özünü, nə sətirlərini. «Göndər» görünməni dəyişən yeganə addımdır.',
      must: true,
      do: async (p, l, h) => {
        await h.hover(`${PO_ROW_BUYER} [data-testid=po-next-ISSUED]`, 1300); await h.holdUntil(0.55);
        await h.needClick(`${PO_ROW_BUYER} [data-testid=po-next-ISSUED]`, '«Göndər» düyməsi', 2000);
        await h.need(`${PO_ROW_BUYER} .badge.ISSUED`, 'göndərilmiş sifariş');
        await h.moveTo(`${PO_ROW_BUYER} .badge.ISSUED`); await h.holdUntil(0.95);
      } },
    { az: 'Sifariş nömrə aldı və təchizatçıya açıldı. Növbə onda: təsdiqləməli və göndərməlidir.',
      do: async (p, l, h) => { await h.moveTo(`${PO_ROW_BUYER} td:nth-child(1)`); await h.holdUntil(0.5); await h.moveTo(`${PO_ROW_BUYER} td.num`); await h.holdUntil(0.95); } },
  ]},
  // ГЛАВА 10 истории: трёхсторонняя сверка и оплата.
  //
  // Снимается ЗАКУПЩИКОМ, а не финансистом, и это не выбор рассказчика: маршрут
  // `/buyer/invoices` закрыт для BUYER_FINANCE (apps/web/src/main.tsx — роли BUYER), то есть
  // человек, которому по замыслу принадлежит сверка счетов, страницу вообще не открывает.
  // Снимаем то, что есть; разрыв роли — отдельная задача, а не правка по дороге.
  'buyer-invoices': { role: 'buyer', path: '/buyer/invoices', scenes: [
    { az: 'Hesab-faktura gəldi. Təsdiqdən əvvəl üç sənəd tutuşdurulur: sifariş, qəbul aktı və hesabın özü. Nömrəyə basıram — tutuşdurma açılır.',
      must: true,
      do: async (p, l, h) => {
        await h.need(`${PO_ROW_BUYER}`, 'gələn hesab');
        await h.moveTo('h1'); await h.holdUntil(0.3);
        await h.needClick(`${PO_ROW_BUYER} [data-testid=inv-no]`, 'hesabın nömrəsi', 1500);
        await h.holdUntil(0.95);
      } },
    { az: 'Hər sətir üçün dörd rəqəm: hesabdakı qiymət və sifarişdəki qiymət, hesabdakı say və faktiki qəbul olunan say. Hamısı uyğundursa, sətir yaşıldır.',
      must: true,
      do: async (p, l, h) => {
        const match = await h.need('.card:has([data-testid=match-why]), .card table:nth-of-type(1)', 'tutuşdurma cədvəli');
        await h.scrollTo(match); await h.holdUntil(0.4);
        await h.moveTo('tbody tr td.num'); await h.holdUntil(0.7);
        await h.moveTo('thead th:nth-child(5)'); await h.holdUntil(0.95);
      } },
    { az: 'Fərq olsaydı, sistem səbəbini sözlə yazardı: qiymət sifarişlə uyğun gəlmir və ya say qəbuldan çoxdur. Belə hesab «Mübahisəli» olur, və onu təsdiqləmək üçün yazılı izah tələb olunur.',
      do: async (p, l, h) => { await h.moveTo('thead th:last-child'); await h.holdUntil(0.5); await h.moveTo('tbody tr:last-child'); await h.holdUntil(0.95); } },
    { az: 'Tutuşdurma təmizdir — təsdiq edirəm.',
      must: true,
      do: async (p, l, h) => {
        await h.scrollTo(`${PO_ROW_BUYER} [data-testid=inv-approve]`);
        await h.needClick(`${PO_ROW_BUYER} [data-testid=inv-approve]`, '«Təsdiqlə» düyməsi', 2200);
        await h.need(`${PO_ROW_BUYER} .badge.APPROVED`, 'təsdiqlənmiş hesab');
        await h.moveTo(`${PO_ROW_BUYER} .badge`); await h.holdUntil(0.95);
      } },
    { az: 'Ödə — hesab ödənilmiş kimi yazılır. Bu, pulun hərəkəti deyil, onun qeydidir: köçürmə bankda qalır, sistem isə kimin, nəyə görə və nə vaxt ödədiyini saxlayır.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick(`${PO_ROW_BUYER} [data-testid=inv-pay]`, '«Ödə» düyməsi', 2200);
        await h.need(`${PO_ROW_BUYER} .badge.PAID`, 'ödənilmiş hesab');
        await h.moveTo(`${PO_ROW_BUYER} .badge`); await h.holdUntil(0.95);
      } },
  ]},
  // ГЛАВА «устройство»: каталог из договора и заказ по согласованной цене.
  // Начинается на договорах: каталог рождается из договора, кнопкой в его строке.
  'buyer-catalogs': { role: 'buyer', path: '/buyer/contracts', poster: '/buyer/catalogs', scenes: [
    { az: 'Tender qiyməti razılaşdırdı. Eyni mal növbəti dəfə lazım olanda yenidən tender keçirmək lazım deyil: müqavilədən kataloq düzəlir, və sonrakı sifarişlər oradan gedir.',
      must: true,
      do: async (p, l, h) => {
        await h.need(PO_ROW_BUYER, 'müqavilənin sətri');
        await h.moveTo('h1'); await h.holdUntil(0.35);
        await h.hover(`${PO_ROW_BUYER} button:has-text("📖")`, 1300); await h.holdUntil(0.95);
      } },
    { az: 'Basıram — kataloq yaranır. Adı, təchizatçısı və mövqeləri müqavilədən gəlir.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick(`${PO_ROW_BUYER} button:has-text("📖")`, '«Kataloq» düyməsi', 2500);
        await h.needClick('a[href="/buyer/catalogs"]', 'yan paneldə «Kataloqlar»', 2000);
        await h.need(`tbody tr:has-text("${STORY.supplier}")`, 'kataloqun sətri');
        await h.moveTo(`tbody tr:has-text("${STORY.supplier}")`); await h.holdUntil(0.95);
      } },
    { az: 'Kataloq qaralamadır: qiymətlər yerindədir, amma sifariş vermək hələ olmur. Aktivləşdirirəm — bu, «bu qiymətlərlə işləyirik» deməkdir.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick(`tbody tr:has-text("${STORY.supplier}") [data-testid=catalog-activate]`, '«Aktivləşdir» düyməsi', 2200);
        await h.need(`tbody tr:has-text("${STORY.supplier}") .badge.ACTIVE`, 'aktiv kataloq');
        await h.moveTo(`tbody tr:has-text("${STORY.supplier}") .badge`); await h.holdUntil(0.95);
      } },
    { az: 'İçində razılaşdırılmış qiymət və minimal sifariş həcmi var. Qiyməti burada dəyişmək mümkün deyil: o müqavilədən gəlir, və kataloq onu təkrar danışıqlara açmır.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick(`tbody tr:has-text("${STORY.supplier}") a, tbody tr:has-text("${STORY.supplier}") td:first-child`, 'kataloqun adı', 1500);
        const items = await h.need('.card:has(h3) tbody tr', 'kataloqun mövqeləri');
        await h.scrollTo(items); await h.holdUntil(0.6);
        await h.moveTo('thead th:nth-child(2)'); await h.holdUntil(0.95);
      } },
    { az: 'Say yazıram və sifariş verirəm. Bu, tendersiz sifarişdir — qiymət artıq razılaşdırılıb, ona görə yenidən rəqabət aparmağa səbəb yoxdur.',
      must: true,
      do: async (p, l, h) => {
        const q = p.locator('[data-testid^="catalog-qty-"]').first();
        await h.needFill(q, '4', 'say');
        await h.holdUntil(0.6);
        await h.needClick('[data-testid=catalog-order]', '«Sifariş ver» düyməsi', 2500);
        await p.waitForURL(/\/buyer\/contracts/, { timeout: 15000 });
        await h.holdUntil(0.95);
      } },
    { az: 'Sifariş müqavilələr bölməsində göründü. Diqqət edin: o, müqavilənin tavanından yeyir, və tavan artıq tam götürüldüyü üçün sistem qırmızı ilə xəbərdarlıq edir — sifariş keçir, amma izsiz keçmir.',
      must: true,
      do: async (p, l, h) => {
        await h.need(`${PO_ROW_BUYER} .badge.DRAFT`, 'yeni sifariş');
        await h.moveTo(`${PO_ROW_BUYER} td:nth-child(6)`); await h.holdUntil(0.6);
        await h.scrollTo(`${PO_ROW_BUYER} .badge.DRAFT`); await h.moveTo(`${PO_ROW_BUYER} .badge.DRAFT`); await h.holdUntil(0.95);
      } },
  ]},
  'buyer-budgets': { role: 'finance', path: '/buyer/budgets', scenes: [
    { az: 'Mən maliyyəçiyəm. Büdcələr bölməsi bir sualla açılır: plan harada dayanıb. Yuxarıdakı cədvəl şöbələr üzrədir — plan, öhdəlik, faktiki xərc və qalıq.',
      must: true,
      do: async (p, l, h) => {
        const roll = await h.need('[data-testid=budget-rollup]', 'şöbələr üzrə cədvəl');
        await h.moveTo('h1'); await h.holdUntil(0.3);
        await h.moveTo(roll.locator('h3')); await h.holdUntil(0.6);
        await h.moveTo(roll.locator('tbody tr').first()); await h.holdUntil(0.95);
      } },
    { az: 'Əməliyyat şöbəsi: rüblük planı yüz əlli min manat, xərclənib əlli səkkiz min — otuz səkkiz faiz. Bu, bizim mebelimizdir: sifariş qəbul olunan kimi plana düşdü.',
      must: true,
      do: async (p, l, h) => {
        const ops = await h.need('[data-testid=budget-rollup] tbody tr:has-text("OPS")', 'OPS şöbəsinin sətri');
        await h.scrollTo(ops); await h.holdUntil(0.4);
        await h.moveTo(ops.locator('td').nth(1)); await h.holdUntil(0.7);
        await h.moveTo(ops.locator('td.num').first()); await h.holdUntil(0.95);
      } },
    { az: 'Yanında templə müqayisə var: dövrün qırx üç faizi keçib, xərc isə otuz səkkiz. Yəni plandan geri deyil, qabağa da keçməyib. Təkcə faiz bunu demir — noyabrda səksən faiz adi haldır, mayda isə həyəcan siqnalıdır.',
      do: async (p, l, h) => { const ops = p.locator('[data-testid=budget-rollup] tbody tr:has-text("OPS")'); await h.hover(ops.locator('[data-tip]').last(), 1400); await h.holdUntil(0.95); } },
    { az: 'Ödənilmiş məbləğ ayrıca durur və cəmə qatılmır: hesab artıq xərc kimi sayılmış sifarişi bağlayır, onu ikinci dəfə saymaq xərci iki dəfə göstərmək olardı.',
      do: async (p, l, h) => { await h.moveTo('[data-testid=rollup-total]'); await h.holdUntil(0.55); await h.moveTo('[data-testid=budget-rollup] thead th:last-child'); await h.holdUntil(0.95); } },
    { az: 'Aşağıda planların özləri: ad, kateqoriya, şöbə, dövr və məbləğ. Plan dörd haldan birindədir, və pulu yalnız qüvvədə olan plan tutur — qaralama heç nə tutmur.',
      must: true,
      do: async (p, l, h) => {
        const list = await h.need('[data-testid=budget-list]', 'planların siyahısı');
        await h.scrollTo(list); await h.holdUntil(0.45);
        await h.moveTo(list.locator('tbody tr:has-text("OPS")').first()); await h.holdUntil(0.95);
      } },
    { az: 'Həddlər: səksən faizdə xəbərdarlıq şöbənin sahibinə gedir, bağlama isə sönülüdür. Qoşulsa, həddi aşan təsdiq dayanır və yalnız administrator yazılı əsaslandırma ilə keçə bilər.',
      do: async (p, l, h) => { await h.scrollTo('h1'); await h.moveTo(p.locator('.hint').filter({ hasText: '%' }).first()); await h.holdUntil(0.95); } },
    { az: 'İki ixrac var və onlar qəsdən ayrıdır: insan üçün bütöv mənzərə, mühasibat üçün isə aylara bölünmüş plan. Mühasibat sistemi planı dövr və ölçü üzrə yükləyir, faktları isə onsuz da özü saxlayır.',
      do: async (p, l, h) => { await h.scrollTo('[data-testid=budget-list]'); await h.hover(p.locator('button:has-text("CSV")').first(), 1200); await h.holdUntil(0.6); await h.hover(p.locator('button:has-text("1C"), button:has-text("1С")').first(), 1200); await h.holdUntil(0.95); } },
  ]},
  // ГЛАВА 12 истории: что от этой покупки видно в аналитике.
  'buyer-analytics': { role: 'finance', path: '/buyer/analytics', scenes: [
    { az: 'Analitika dörd rəqəmlə başlayır: xərc, qənaət, ödənilmiş və ödənilməmiş. Xərcə yalnız qəbul edilmiş sifarişlər düşür — yəni real alınmış mal, sifariş vədi yox.',
      must: true,
      do: async (p, l, h) => {
        await h.need('h1', 'analitika başlığı');
        const cards = p.locator('.card');
        await h.moveTo(cards.nth(0)); await h.holdUntil(0.5);
        await h.hover(cards.nth(0), 1300); await h.holdUntil(0.95);
      } },
    { az: 'Qənaət: altı min manat. Sistem sorğunun smetasını qalib təklifin məbləği ilə tutuşdurur. Təkliflər smetadan baha gəlsəydi, qənaət mənfi görünərdi — rəqəm bəzədilmir.',
      do: async (p, l, h) => { const cards = p.locator('.card'); await h.moveTo(cards.nth(1)); await h.holdUntil(0.4); await h.hover(cards.nth(1), 1400); await h.holdUntil(0.95); } },
    { az: 'Ödənilmiş və ödənilməmiş hesablar ƏDV ilə göstərilir, xərc isə ƏDV-siz: ona görə rəqəmlər üst-üstə düşmür, və hər kartın altında nəyin nəyə görə sayıldığı yazılır.',
      do: async (p, l, h) => { const cards = p.locator('.card'); await h.moveTo(cards.nth(2)); await h.holdUntil(0.45); await h.moveTo(cards.nth(3)); await h.holdUntil(0.95); } },
    { az: 'Aşağıda aylar üzrə xərc. Boş aylar da göstərilir — sıfır ay sıçrayışı gizlədən boşluqdan yaxşıdır.',
      do: async (p, l, h) => { await h.scrollTo('h3'); await h.holdUntil(0.5); await h.moveTo(p.locator('h3').first()); await h.holdUntil(0.95); } },
    { az: 'Şöbələr üzrə bölgü sifarişin öz şöbəsindən yığılır, kateqoriya isə sorğudan gəlir. Ona görə kataloqdan verilmiş sifariş şöbəyə düşür, amma kateqoriyasız qalır: onu heç kim təsnifləməyib.',
      must: true,
      do: async (p, l, h) => {
        const dep = await h.need('h3:has-text("OPS"), .card:has(h3) table tbody tr:has-text("OPS")', 'şöbələr üzrə bölgü');
        await h.scrollTo(dep); await h.holdUntil(0.5);
        await h.moveTo(dep); await h.holdUntil(0.95);
      } },
    { az: 'Hər bölgü keçən ilin eyni dövrü ilə yanaşı durur. Bu il görünən, keçən il olmayan kateqoriya da sətir alır: «biz bunu almağı dayandırdıq» — bu ekranın əsas sualıdır.',
      do: async (p, l, h) => { await h.scrollTo('table'); await h.moveTo(p.locator('table thead th').last()); await h.holdUntil(0.95); } },
    { az: 'Və təchizatçılar: kimdən nə qədər alınıb. Bu siyahı qiymətləndirmədəki etibarlılıq göstəricisinə də gedir — keçmiş icra növbəti tenderdə nəzərə alınır.',
      do: async (p, l, h) => { await h.scrollTo(p.locator('h3').last()); await h.holdUntil(0.4); await h.moveTo(p.locator('h3').last()); await h.holdUntil(0.95); } },
  ]},
  'buyer-logistics': { role: 'buyer', path: '/buyer/logistics', scenes: [
    { az: 'Logistika bir lövhədir: bütün yüklər bir ekranda. Sifariş nömrəsi, təchizatçı, daşıyıcı, izləmə nömrəsi və iki status.',
      must: true,
      do: async (p, l, h) => {
        await h.need(PO_ROW_BUYER, 'yükün sətri');
        await h.moveTo('h1'); await h.holdUntil(0.3);
        await h.moveTo(`${PO_ROW_BUYER} td:nth-child(3)`); await h.holdUntil(0.6);
        await h.moveTo(`${PO_ROW_BUYER} td:nth-child(4)`); await h.holdUntil(0.95);
      } },
    { az: 'İki status yan-yana qəsdən durur: yükünkünü təchizatçı yazır, sifarişinkini alıcı. Onlar ayrılanda — məsələn, yük çatıb, sifariş isə hələ qəbul olunmayıb — bunu görmək lazımdır.',
      do: async (p, l, h) => { await h.moveTo(`${PO_ROW_BUYER} td:nth-child(5)`); await h.holdUntil(0.5); await h.moveTo(`${PO_ROW_BUYER} td:nth-child(6)`); await h.holdUntil(0.95); } },
    { az: 'Mal gəldi, indi qəbul. O, müqavilələr bölməsində, sifarişin öz sətrindədir — çünki qəbul edilən yük yox, sifarişin mövqeləridir.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick('a[href="/buyer/contracts"]', 'yan paneldə «Müqavilələr»', 1800);
        await h.need(`${PO_ROW_BUYER} .badge.DELIVERED`, 'çatdırılmış sifariş');
        await h.scrollTo(`${PO_ROW_BUYER} .badge.DELIVERED`); await h.holdUntil(0.6);
        await h.hover(`${PO_ROW_BUYER} [data-testid=po-receive]`, 1300); await h.holdUntil(0.95);
      } },
    { az: 'Basıram — sistem sifarişin bütün mövqelərini qəbul edir və qəbul aktını yazır. Qismən gələndə say əl ilə göstərilir, və sifariş hamısı gələnə qədər bağlanmır.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick(`${PO_ROW_BUYER} [data-testid=po-receive]`, '«Qəbul» düyməsi', 2500);
        await h.need(`${PO_ROW_BUYER} .badge.ACCEPTED`, 'qəbul edilmiş sifariş');
        await h.moveTo(`${PO_ROW_BUYER} .badge.ACCEPTED`); await h.holdUntil(0.95);
      } },
  ]},
  // ГЛАВА «устройство»: реестр поставщиков. Снимается ПОСЛЕ сквозной части и работает с её
  // данными: Supply One выиграл тендер, Baku Metal в нём участвовал, но в реестре его нет.
  'buyer-suppliers': { role: 'buyer', path: '/buyer/suppliers', scenes: [
    { az: 'Təchizatçılar ekranı iki siyahıdan ibarətdir. Birincisi reyestrdir: kiminlə artıq işləyirik və hansı halda.',
      must: true,
      do: async (p, l, h) => {
        const reg = await h.need('[data-testid=registry-card]', 'reyestr');
        await h.moveTo('h1'); await h.holdUntil(0.35);
        await h.moveTo(reg.locator('h3')); await h.holdUntil(0.65);
        await h.moveTo(`[data-testid=registry-card] tbody tr:has-text("${STORY.supplier}")`); await h.holdUntil(0.95);
      } },
    { az: 'Supply One təsdiqlənmişdir — mebel tenderini məhz o uddu. Reyestrdə olmaq hüquq deyil, haldır: təsdiqlənmiş, gözləyən və ya bloklanmış.',
      do: async (p, l, h) => { await h.moveTo(`[data-testid=registry-card] tbody tr:has-text("${STORY.supplier}") .badge`); await h.holdUntil(0.55); await h.moveTo('[data-testid=registry-card] thead th:nth-child(2)'); await h.holdUntil(0.95); } },
    { az: 'İkinci siyahı şəbəkənin kataloqudur: sistemdə qeydiyyatdan keçmiş bütün təchizatçılar. Bakı Metal tenderimizdə iştirak etdi, amma reyestrimizdə yoxdur — dəvət reyestr tələb etmir, iş isə tələb edir.',
      must: true,
      do: async (p, l, h) => {
        const dir = await h.need('[data-testid=directory-card]', 'şəbəkə kataloqu');
        await h.scrollTo(dir); await h.holdUntil(0.45);
        await h.need(`[data-testid=directory-card] tbody tr:has-text("${STORY.supplier2}") [data-testid=dir-invite]`, `${STORY.supplier2} sətri`);
        await h.moveTo(`[data-testid=directory-card] tbody tr:has-text("${STORY.supplier2}")`); await h.holdUntil(0.95);
      } },
    { az: 'Reyestrə əlavə edirəm. İndi o da bizim siyahımızdadır və onun haqqında qiymətləndirmə, yoxlama və tarixçə saxlanılır.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick(`[data-testid=directory-card] tbody tr:has-text("${STORY.supplier2}") [data-testid=dir-invite]`, '«Dəvət et» düyməsi', 2000);
        await h.need(`[data-testid=registry-card] tbody tr:has-text("${STORY.supplier2}")`, 'reyestrdə yeni sətir');
        await h.scrollTo('[data-testid=registry-card]'); await h.holdUntil(0.6);
        await h.moveTo(`[data-testid=registry-card] tbody tr:has-text("${STORY.supplier2}") .badge`); await h.holdUntil(0.95);
      } },
    { az: 'Qiymətləndirmə: ulduza basıb təchizatçıya vaxtında və tam çatdırılma üzrə bal yazıram. Doxsan.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick(`[data-testid=registry-card] tbody tr:has-text("${STORY.supplier}") [data-testid=sup-score]`, '«Qiymətləndirmə» düyməsi', 1200);
        await h.need('[data-testid=dialog-input]', 'bal sahəsi');
        await h.holdUntil(0.55);
        await h.needClick('[data-testid=dialog-confirm]', 'təsdiq düyməsi', 1800);
        await h.holdUntil(0.95);
      } },
    { az: 'Bal sətirdə görünür və orada qalmır: süni zəka tövsiyəsində o, etibarlılıq göstəricisinə çevrilir. Yəni bu günkü icra növbəti tenderin sıralamasına təsir edir.',
      do: async (p, l, h) => { await h.moveTo(`[data-testid=registry-card] tbody tr:has-text("${STORY.supplier}") .hint`); await h.holdUntil(0.95); } },
    { az: 'Bloklama təchizatçını gələcək bütün prosedurlardan kəsir, ona görə o, «Daha çox» menyusunun içindədir — təsdiqin yanında yox. Bu, bu ekranda yeganə dağıdıcı əməliyyatdır.',
      do: async (p, l, h) => {
        const more = await openRowMenu(p, `[data-testid=registry-card] tbody tr:has-text("${STORY.supplier2}")`, '', h);
        if (more) { await h.holdUntil(0.6); await h.moveTo(more); }
        await closeRowMenu(p); await h.holdUntil(0.95);
      } },
    { az: 'Qalxan düyməsi yoxlama işi açır: təchizatçıdan sənəd istənilir. Supply One üçün onu indi açıram — növbəti bölmə məhz bu işin davamıdır.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick(`[data-testid=registry-card] tbody tr:has-text("${STORY.supplier}") [data-testid=sup-verify]`, '«Yoxlama» düyməsi', 1800);
        await h.need('[data-testid=toast]', 'yoxlama işinin açıldığı barədə bildiriş');
        await h.moveTo('[data-testid=toast]'); await h.holdUntil(0.95);
      } },
  ]},
  // ГЛАВА «устройство»: проверка поставщика глазами покупателя. Идёт ПОСЛЕ `sup-verification`:
  // дело открыто в главе про реестр, документы в него кладёт поставщик.
  'buyer-verification': { role: 'buyer', path: '/buyer/verification', scenes: [
    { az: 'Yoxlama işləri: təchizatçı, işin statusu və əlavə olunmuş sənədlərin sayı. İş reyestrdəki qalxan düyməsi ilə açılır, sənədləri isə təchizatçının özü qoyur.',
      must: true,
      do: async (p, l, h) => {
        const row = await h.need(`tbody tr:has-text("${STORY.supplier}")`, 'yoxlama işi');
        await h.moveTo('h1'); await h.holdUntil(0.35);
        await h.moveTo(row); await h.holdUntil(0.7);
        await h.moveTo('thead th:nth-child(3)'); await h.holdUntil(0.95);
      } },
    { az: 'Açıram. Hər sənədin növü, adı və barmaq izi var. İz qəsdən görünür: auditor «bu, yüklənmiş faylın özüdürmü?» soruşur, və cavab ekranda olmalıdır, sütunda gizlənmiş halda yox.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick(`tbody tr:has-text("${STORY.supplier}") [data-testid=verif-open]`, '«Aç» düyməsi', 1500);
        const hash = await h.need('.card .hint[data-tip]', 'sənədin barmaq izi');
        await h.scrollTo(hash); await h.holdUntil(0.6);
        await h.moveTo(hash); await h.holdUntil(0.95);
      } },
    { az: 'Fayl adının üstünə basanda sənəd yüklənir. Yükləmə ayrıca ünvan üzərindən gedir və hər dəfə yenidən icazə tələb edir — sənəd açıq linkdə qalmır.',
      do: async (p, l, h) => { await h.moveTo('.card a[href="#"]'); await h.holdUntil(0.95); } },
    { az: 'Sənədlər yerindədir — təsdiq edirəm. Təchizatçı yoxlanılmış sayılır, və bu hal onun kartında görünür.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick('.card:has(.badge.is-info) [data-testid=verif-approve]', '«Təsdiqlə» düyməsi', 2200);
        await h.need(`tbody tr:has-text("${STORY.supplier}") .badge.APPROVED`, 'təsdiqlənmiş yoxlama');
        await h.moveTo(`tbody tr:has-text("${STORY.supplier}") .badge`); await h.holdUntil(0.95);
      } },
    { az: 'Yoxlama bir dəfəlik deyil: lisenziyanın və arayışların müddəti bitir, ona görə iş yenidən açıla bilər və köhnə sənədlər tarixçədə qalır.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.5); await h.moveTo('tbody tr'); await h.holdUntil(0.95); } },
  ]},
  // ГЛАВА «устройство»: правила, по которым всё предыдущее произошло.
  // Разделы адресуются своими id (#set-users, #set-method…), а не подписями: id в разметке
  // стоят именно для ссылок и от языка не зависят.
  'buyer-settings': { role: 'buyer', path: '/buyer/settings', scenes: [
    { az: 'Parametrlər — bütün əvvəlki bölmələrin qaydaları burada yazılır. Buradakı bir sətir sabah sorğunun hansı yolla gedəcəyini dəyişir, ona görə bu ekran axırda deyil, əvvəldə öyrənilməlidir.',
      must: true,
      do: async (p, l, h) => {
        await h.need('#set-users', 'istifadəçilər bölməsi');
        await h.moveTo('h1'); await h.holdUntil(0.45);
        await h.moveTo('#set-users'); await h.holdUntil(0.95);
      } },
    { az: 'İstifadəçilər və rollar: kim sorğu yazır, kim təsdiqləyir, kim tender aparır, kim pulu görür. Öz rolunu dəyişmək olmur — yoxsa istənilən istifadəçi bir kliklə administratora çevrilərdi.',
      do: async (p, l, h) => { await h.scrollTo('#set-users'); await h.holdUntil(0.4); await h.moveTo('#set-users + * tbody tr, #set-users ~ table tbody tr'); await h.holdUntil(0.95); } },
    { az: 'Kateqoriyalar vahid siyahıdır. Sorğudakı «OFFICE» məhz buradan gəldi: belə olmasa, «IT» və «it» ayrı kateqoriyaya çevrilər, və analitikadakı bölgü mənasını itirərdi.',
      must: true,
      do: async (p, l, h) => {
        const cat = await h.need('#set-categories', 'kateqoriyalar bölməsi');
        await h.scrollTo(cat); await h.holdUntil(0.5);
        await h.moveTo(cat); await h.holdUntil(0.95);
      } },
    { az: 'Şöbələr: kim xərcləyir. Hər şöbənin sahibi var, və büdcə xəbərdarlığı məhz ona gedir — qırx nəfərə göndərilən həyəcan siqnalı heç kimin işi olmur.',
      must: true,
      do: async (p, l, h) => {
        const dep = await h.need('#set-departments', 'şöbələr bölməsi');
        await h.scrollTo(dep); await h.holdUntil(0.5);
        await h.moveTo(dep); await h.holdUntil(0.95);
      } },
    { az: 'Büdcə həddləri: səksən faizdə xəbərdarlıq gedir, bağlama isə sönülüdür. Qoşulsa, həddi aşan təsdiq elə təsdiq anında dayanır və geri qaytarılır — sorğu göndərilmiş halda qalır.',
      must: true,
      do: async (p, l, h) => {
        const th = await h.need('#set-thresholds', 'həddlər bölməsi');
        await h.scrollTo(th); await h.holdUntil(0.55);
        await h.moveTo(th); await h.holdUntil(0.95);
      } },
    { az: 'Etiraz müddəti: qalib elan olunandan müqaviləyə qədər gözləmə. Bizim tenderimizdə o sıfır idi, ona görə müqavilə dərhal yarandı; qoşulsa, kart müddətin nə vaxt bitdiyini göstərər.',
      must: true,
      do: async (p, l, h) => {
        const st = await h.need('[data-testid=set-standstill]', 'etiraz müddəti bölməsi');
        await h.scrollTo(st); await h.holdUntil(0.55);
        await h.moveTo(st); await h.holdUntil(0.95);
      } },
    { az: 'Metod siyasəti — bütün hekayənin açarı. Əlli min manata qədər birbaşa sifariş, yuxarısı qapalı tender. Altmış dörd min manatlıq sorğu tenderə məhz buna görə getdi, və bunu insan seçmədi: zolağı qayda seçdi.',
      must: true,
      do: async (p, l, h) => {
        const m = await h.need('#set-method', 'metod siyasəti');
        await h.scrollTo(m); await h.holdUntil(0.4);
        await h.moveTo(m); await h.holdUntil(0.7);
        // Политика метода нарисована не таблицей, а цветной шкалой полос (`.mp-scale`):
        // первая редакция искала здесь `table tbody tr` и промахивалась — сцена доигрывала
        // по неподвижному экрану, и это был единственный промах за весь прогон.
        await h.moveTo('.mp-scale .mp-band'); await h.holdUntil(0.95);
      } },
    { az: 'Təsdiq zənciri: hansı məbləğdən sonra kim təsdiqləyir. Bir addım da ola bilər, üç də — böyük məbləğ daha çox gözə görünsün deyə. Zəncir boş olanda sorğunu istənilən təsdiqləyən təsdiqləyir, və bunu siyahı açıq yazır.',
      must: true,
      do: async (p, l, h) => {
        const ap = await h.need('#set-approval', 'təsdiq zənciri');
        await h.scrollTo(ap); await h.holdUntil(0.55);
        await h.moveTo(ap); await h.holdUntil(0.95);
      } },
  ]},
  // ГЛАВА «устройство»: панель поставщика в конце истории — она уже не пустая.
  'sup-dashboard': { role: 'sup', path: '/supplier/dashboard', scenes: [
    { az: 'Təchizatçının paneli. Yuxarıda yoxlama halı, sonra göstəricilər, aşağıda isə tapşırıqlar — məndən addım gözləyən işlər.',
      must: true,
      do: async (p, l, h) => {
        await h.need('[data-testid=sup-kpi]', 'göstəricilər');
        await h.moveTo('h1'); await h.holdUntil(0.4);
        await h.moveTo('[data-testid=sup-verification]'); await h.holdUntil(0.95);
      } },
    { az: 'Yoxlama kartı yaşıldır: sənədlərim təsdiqlənib. Təsdiqlənməmiş yoxlama bəzi alıcılar üçün maneədir, ona görə o, panelin başındadır — siyahının dərinliyində yox.',
      do: async (p, l, h) => { await h.moveTo('[data-testid=sup-verification]'); await h.holdUntil(0.5); await h.hover('[data-testid=sup-verification]', 1200); await h.holdUntil(0.95); } },
    { az: 'Göstəricilər: mənə açıq tenderlər, verdiyim təkliflər, işdəki sifarişlər və ödənilməmiş hesablar. Hər rəqəmin öz izahı var.',
      must: true,
      do: async (p, l, h) => {
        const k = await h.need('[data-testid=sup-kpi]', 'göstəricilər');
        await h.scrollTo(k); await h.holdUntil(0.35);
        await h.hover(k.locator('.card').first(), 1200); await h.holdUntil(0.7);
        await h.moveTo(k.locator('.card').last()); await h.holdUntil(0.95);
      } },
    { az: 'Tapşırıqlar: sistem bütün bölmələri özü gəzir və növbəsi məndə olan işləri bir siyahıya yığır — təklif ver, sifarişi təsdiqlə, hesab çıxar.',
      do: async (p, l, h) => { await h.scrollTo('h3'); await h.holdUntil(0.5); await h.moveTo('h3'); await h.holdUntil(0.95); } },
    { az: 'Günü buradan başlamaq rahatdır: boş siyahı hər şeyin öz vaxtında getdiyini bildirir, dolu siyahı isə nəyi itirdiyimi.',
      do: async (p, l, h) => { await h.moveTo('.card'); await h.holdUntil(0.6); await h.moveTo('h1'); await h.holdUntil(0.95); } },
  ]},
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
  // ГЛАВА 7 истории: поставщик подтверждает заказ и везёт.
  'sup-orders': { role: 'sup', path: '/supplier/orders', scenes: [
    { az: 'Sifarişlər bölməsi. Alıcıdan gələn sifariş burada göründü: nömrə, alıcı, məbləğ və status. Status «Göndərilib»dir — yəni məndən cavab gözlənilir.',
      must: true,
      do: async (p, l, h) => {
        await h.need(`${PO_ROW_SUP} .badge.ISSUED`, 'gələn sifariş');
        await h.moveTo('h1'); await h.holdUntil(0.3);
        await h.moveTo(`${PO_ROW_SUP} td.num`); await h.holdUntil(0.6);
        await h.moveTo(`${PO_ROW_SUP} .badge`); await h.holdUntil(0.95);
      } },
    { az: 'Təsdiq edirəm: şərtləri və əlli səkkiz min manatı qəbul etdim. Bundan sonra qiyməti tək tərəfli dəyişmək olmur — dəyişiklik ayrıca razılaşma tələb edir.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick(`${PO_ROW_SUP} [data-testid=sup-po-next-CONFIRMED]`, '«Təsdiqlə» düyməsi', 2000);
        await h.need(`${PO_ROW_SUP} .badge.CONFIRMED`, 'təsdiqlənmiş sifariş');
        await h.moveTo(`${PO_ROW_SUP} .badge`); await h.holdUntil(0.95);
      } },
    { az: 'İndi yük. Daşıyıcı və izləmə nömrəsi — sistem onları alıcıya göstərir, ona görə «harada qaldı» sualı yazışma ilə həll olunmur.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick(`${PO_ROW_SUP} [data-testid=sup-logistics]`, '«Logistika» düyməsi', 1200);
        await h.needClick(`${PO_ROW_SUP} [data-testid=sup-create-shipment]`, '«Yük yarat» düyməsi', 900);
        await h.needClick('[data-testid=dialog-confirm]', 'daşıyıcının təsdiqi', 900);
        await h.needClick('[data-testid=dialog-confirm]', 'izləmə nömrəsinin təsdiqi', 1800);
        await h.need(`${PO_ROW_SUP} .badge.CREATED, ${PO_ROW_SUP} .badge.NEW, ${PO_ROW_SUP} td:last-child b`, 'yaradılmış yük');
        await h.moveTo(`${PO_ROW_SUP} td:last-child`); await h.holdUntil(0.95);
      } },
    { az: 'Yığıldı, yola düşdü. Hər addım sifarişin statusunu dəyişir, və alıcı onu öz lövhəsində dərhal görür.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick(`${PO_ROW_SUP} [data-testid=sup-po-next-PACKED]`, '«Yığıldı» düyməsi', 1600);
        await h.holdUntil(0.5);
        await h.needClick(`${PO_ROW_SUP} [data-testid=sup-po-next-SHIPPED]`, '«Yola düşdü» düyməsi', 1600);
        await h.need(`${PO_ROW_SUP} .badge.SHIPPED`, 'yolda olan sifariş');
        await h.holdUntil(0.95);
      } },
    { az: 'Çatdırıldı. İndi söz alıcıdadır: malı qəbul etməlidir, və yalnız ondan sonra hesab-fakturanın yeri gəlir.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick(`${PO_ROW_SUP} [data-testid=sup-po-next-DELIVERED]`, '«Çatdırıldı» düyməsi', 1800);
        await h.need(`${PO_ROW_SUP} .badge.DELIVERED`, 'çatdırılmış sifariş');
        await h.moveTo(`${PO_ROW_SUP} .badge`); await h.holdUntil(0.95);
      } },
  ]},
  // ГЛАВА 9 истории: поставщик выставляет счёт на принятое.
  'sup-invoices': { role: 'sup', path: '/supplier/orders', poster: '/supplier/invoices', scenes: [
    { az: 'Mal qəbul olundu — indi hesab-faktura. Düymə sifarişin öz sətrindədir, çünki hesab sifarişdən doğur: sistem nəyin faktiki qəbul edildiyini bilir, ona görə məbləği mən yazmıram.',
      must: true,
      do: async (p, l, h) => {
        await h.need(`${PO_ROW_SUP} .badge.ACCEPTED`, 'qəbul edilmiş sifariş');
        await h.moveTo(`${PO_ROW_SUP} .badge`); await h.holdUntil(0.45);
        await h.hover(`${PO_ROW_SUP} [data-testid=sup-po-invoice]`, 1200); await h.holdUntil(0.95);
      } },
    { az: 'Ödəniş müddətini mən göstərirəm: o razılaşmadan gəlir, sistem onu özündən uydurmur. Otuz gün.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick(`${PO_ROW_SUP} [data-testid=sup-po-invoice]`, '«Hesab-faktura» düyməsi', 1500);
        // Тридцать дней ОТ ТОГО ЖЕ ДНЯ, который продукт запишет в дату выставления.
        // Первая редакция брала `Date.now() + 30 дней` и `toISOString()`, то есть день по
        // Гринвичу, а `invoices.issue_date` пишется по `APP_TIMEZONE` (Asia/Baku) — колонка,
        // которую и завели против этой самой ошибки. Съёмка поздним вечером по UTC давала
        // счёт, выписанный 10-го со сроком 9 декабря: двадцать девять дней под слова «отуз
        // гюн». Днём совпадало, вечером нет — то есть дефект, который видно через раз.
        const tz = process.env.APP_TIMEZONE ?? 'Asia/Baku';
        const day = new Date(`${new Date().toLocaleDateString('en-CA', { timeZone: tz })}T00:00:00Z`);
        day.setUTCDate(day.getUTCDate() + 30);
        const due = day.toISOString().slice(0, 10);
        await h.setDate('[data-testid=dialog-input]', due, 'ödəniş müddəti');
        await h.holdUntil(0.6);
        await h.needClick('[data-testid=dialog-confirm]', 'təsdiq düyməsi', 2500);
        await p.waitForURL(/\/supplier\/invoices/, { timeout: 15000 });
        await h.holdUntil(0.95);
      } },
    { az: 'Hesab siyahıdadır: nömrə, sifariş, tarix, ödəniş müddəti, məbləğ və status. Status «Uyğundur» — sistem hesabı sifarişlə və qəbulla özü tutuşdurub.',
      must: true,
      do: async (p, l, h) => {
        const row = await h.need(`${PO_ROW_SUP} .badge`, 'hesabın sətri');
        await h.moveTo(`${PO_ROW_SUP} td:nth-child(1)`); await h.holdUntil(0.35);
        await h.moveTo(`${PO_ROW_SUP} td:nth-child(5)`); await h.holdUntil(0.6);
        await h.moveTo(row); await h.holdUntil(0.95);
      } },
    { az: 'Mənim tərəfimdən iş bitdi. Növbəti addım alıcıdadır: tutuşdurma, təsdiq və ödəniş.',
      do: async (p, l, h) => { await h.moveTo(`${PO_ROW_SUP} td.num`); await h.holdUntil(0.5); await h.moveTo('h1'); await h.holdUntil(0.95); } },
  ]},
  // ГЛАВА «устройство»: живые торги — вторая покупка, от заявки до последнего шага цены.
  //
  // Четыре актёра и своя, вторая история: аукциону нужен СВОЙ предмет. Мебель для него не
  // годится — там важны качество и срок, а торг уместен там, где требование стандартное, а
  // цена биржевая. Поэтому вторая покупка — бумага.
  'sup-auction': { role: 'sup', path: '/buyer/requests', poster: '/supplier/market', scenes: [
    { as: 'requester',
      az: 'İkinci alış: ofis üçün A4 kağız. Tələb standartdır, qiymət isə bazarda bəllidir — belə alışda canlı hərrac qapalı tenderdən yaxşı işləyir.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick('[data-testid=req-new]', '«Yeni sorğu» düyməsi', 700);
        await h.needFill('[data-testid=req-title]', STORY.title2, 'Başlıq');
        await h.needFill('[data-testid=req-category]', STORY.category, 'Kateqoriya');
        await h.holdUntil(0.95);
      } },
    { as: 'requester',
      az: 'Beş yüz paket, hər biri yüz iyirmi manat — altmış min. Yaradıram və təsdiqə göndərirəm.',
      must: true,
      do: async (p, l, h) => {
        await h.needFill('[data-testid=item-name-0]', STORY.item2.name, 'mövqenin adı');
        await h.needFill('[data-testid=item-qty-0]', STORY.item2.qty, 'say');
        await h.needFill('[data-testid=item-price-0]', STORY.item2.price, 'qiymət');
        await h.holdUntil(0.5);
        await h.needClick('form button.btn:not(.ghost):not([type=button])', '«Yarat» düyməsi', 1500);
        await h.needClick(`${ROW2} [data-testid=req-submit]`, '«Göndər» düyməsi', 1500);
        await h.need(`${ROW2} .badge.SUBMITTED`, 'göndərilmiş sorğu');
        await h.holdUntil(0.95);
      } },
    { as: 'approver',
      az: 'Təsdiqləyən yenə içini açır və təsdiq edir: eyni iki klik, eyni büdcə yoxlaması.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick(`${ROW2} [data-testid=req-approve]`, '«Təsdiqlə» düyməsi', 1500);
        await h.holdUntil(0.5);
        await h.needClick(`${ROW2} [data-testid=req-approve]`, '«Təsdiqi təsdiq et» düyməsi', 1800);
        await h.need(`${ROW2} .badge.APPROVED`, 'təsdiqlənmiş sorğu');
        await h.moveTo(`${ROW2} .badge`); await h.holdUntil(0.95);
      } },
    { as: 'buyer',
      az: 'Bu dəfə prosedur başqadır. Siyahıda hərracın iki variantı var: dəvətlə və hamıya açıq. Dəvətlə olanı seçirəm.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick(`${ROW2} [data-testid=req-announce]`, '«Elan et» düyməsi', 1200);
        await h.need('[role=dialog] [data-testid=dialog-input]', 'prosedur seçimi');
        await h.moveTo('.pick:has(input[value="AUCTION"])'); await h.holdUntil(0.6);
        await h.moveTo('.pick:has(input[value="AUCTION_OPEN"])'); await h.holdUntil(0.95);
      } },
    { as: 'buyer',
      az: 'Hərracda başlanğıc qiymət smetadır, addım isə onun bir faizi — altı yüz manat. Yəni hər yeni təklif əvvəlkindən ən azı bu qədər aşağı olmalıdır, yoxsa torq saniyədə bir manatla sürünərdi.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick('.pick:has(input[value="AUCTION"])', 'dəvətlə hərrac', 700);
        await h.needClick('[data-testid=dialog-confirm]', 'təsdiq düyməsi', 1500);
        await p.waitForURL(/\/buyer\/events\/[0-9a-f-]{36}/, { timeout: 15000 });
        await h.need(`h1:has-text("${STORY.title2}")`, 'hərracın kartı');
        await h.moveTo('h1'); await h.holdUntil(0.95);
      } },
    { as: 'buyer',
      az: 'Hər iki təchizatçını dəvət edirəm və elan edirəm — saat işləməyə başladı.',
      must: true,
      do: async (p, l, h) => {
        await h.scrollTo('[data-testid=ev-invite-select]');
        if (!await selectByPrefix(p, '[data-testid=ev-invite-select]', STORY.supplier)) throw new Error(`нет «${STORY.supplier}» в списке приглашения`);
        await h.needClick('[data-testid=ev-invite]', '«Dəvət et» düyməsi', 900);
        if (!await selectByPrefix(p, '[data-testid=ev-invite-select]', STORY.supplier2)) throw new Error(`нет «${STORY.supplier2}» в списке приглашения`);
        await h.needClick('[data-testid=ev-invite]', '«Dəvət et» düyməsi', 900);
        await h.needClick('[data-testid=ev-publish]', '«Elan et» düyməsi', 1800);
        await h.need('h1 .badge.OPEN', 'açıq hərrac');
        await h.holdUntil(0.95);
      } },
    { as: 'sup',
      az: 'Mən iştirakçıyam. Panel ən yaxşı qiyməti göstərir, amma kiminki olduğunu yox: hərracda görünən qiymətdir, ad deyil. Öz qiymətimi verirəm — yüz on beş manat.',
      must: true,
      do: async (p, l, h) => {
        // Раздел открывается на странице заявок покупателя, а поставщика туда не пускают:
        // его прогон начинается с перенаправления, и куда именно — решает роутер, а не
        // сценарий. Поэтому витрина открывается явно.
        await p.goto(`${BASE}/supplier/market`);
        await h.needClick(`${ROW2} a`, 'hərracın başlığı', 1500);
        await p.waitForURL(/\/supplier\/events\/[0-9a-f-]{36}/, { timeout: 15000 });
        await h.need('.card:has-text("REVERSE")', 'hərrac paneli');
        await h.scrollTo('[data-testid=bid-price-0]');
        await h.needFill('[data-testid=bid-price-0]', STORY.auction[0], 'qiymət');
        await h.needClick('[data-testid=bid-submit]', '«Təklif ver» düyməsi', 2000);
        await h.holdUntil(0.95);
      } },
    { as: 'sup2',
      az: 'İkinci iştirakçı qiyməti aşağı salır: yüz on iki. Son saniyədə atılan təklif saatı uzadır — başqalarına cavab şansı qalsın deyə, yoxsa hərracı sürət udardı, qiymət yox.',
      must: true,
      do: async (p, l, h) => {
        // Раздел открывается на странице заявок покупателя, а поставщика туда не пускают:
        // его прогон начинается с перенаправления, и куда именно — решает роутер, а не
        // сценарий. Поэтому витрина открывается явно.
        await p.goto(`${BASE}/supplier/market`);
        await h.needClick(`${ROW2} a`, 'hərracın başlığı', 1500);
        await p.waitForURL(/\/supplier\/events\/[0-9a-f-]{36}/, { timeout: 15000 });
        await h.scrollTo('[data-testid=bid-price-0]');
        await h.needFill('[data-testid=bid-price-0]', STORY.auction[1], 'qiymət');
        await h.needClick('[data-testid=bid-submit]', '«Təklif ver» düyməsi', 2000);
        await h.scrollTo('h1'); await h.holdUntil(0.95);
      } },
    { as: 'sup',
      az: 'Cavab verirəm: yüz doqquz. Hərracın bütün mahiyyəti budur — qiymət danışıqda deyil, rəqabətdə formalaşır, və hər addım jurnalda qalır.',
      must: true,
      do: async (p, l, h) => {
        // Раздел открывается на странице заявок покупателя, а поставщика туда не пускают:
        // его прогон начинается с перенаправления, и куда именно — решает роутер, а не
        // сценарий. Поэтому витрина открывается явно.
        await p.goto(`${BASE}/supplier/market`);
        await h.needClick(`${ROW2} a`, 'hərracın başlığı', 1500);
        await p.waitForURL(/\/supplier\/events\/[0-9a-f-]{36}/, { timeout: 15000 });
        await h.scrollTo('[data-testid=bid-price-0]');
        await h.needFill('[data-testid=bid-price-0]', STORY.auction[2], 'qiymət');
        await h.needClick('[data-testid=bid-submit]', '«Təklif ver» düyməsi', 2200);
        await h.scrollTo('h1'); await h.holdUntil(0.6);
        await h.moveTo('.card:has-text("REVERSE")'); await h.holdUntil(0.95);
      } },
    { as: 'sup',
      az: 'Vaxt bitəndə ən yaxşı qiymət qalib olur. Alıcı onu ayrıca bal vermədən təsdiqləyir, çünki qiymət rəqabəti elə qiymətləndirmənin özüdür — və buna görə hərracı yalnız tələbi standart olan alışda seçmək lazımdır.',
      do: async (p, l, h) => { await h.moveTo('.card:has-text("REVERSE") b'); await h.holdUntil(0.6); await h.moveTo('h1'); await h.holdUntil(0.95); } },
  ]},
  // ГЛАВА «устройство»: поставщик кладёт документы в дело, открытое покупателем.
  'sup-verification': { role: 'sup', path: '/supplier/verification', scenes: [
    { az: 'Alıcı mənə yoxlama işi açıb. Siyahıda onun adı, işin statusu və sənədlərin sayı var — hələ sıfır.',
      must: true,
      do: async (p, l, h) => {
        const row = await h.need(`tbody tr:has-text("${STORY.buyer}")`, 'yoxlama işi');
        await h.moveTo('h1'); await h.holdUntil(0.4);
        await h.moveTo(row); await h.holdUntil(0.95);
      } },
    { az: 'Açıram və sənədin növünü seçirəm: VÖEN çıxarışı. Növ siyahıdan gəlir, ona görə alıcı nəyi aldığını bilir — fayl adına baxmaqla yox.',
      must: true,
      do: async (p, l, h) => {
        await h.needClick(`tbody tr:has-text("${STORY.buyer}") [data-testid=verif-open]`, '«Aç» düyməsi', 1500);
        const sel = await h.need('[data-testid=verif-doctype]', 'sənəd növü');
        await sel.selectOption('VOEN');
        await h.moveTo(sel); await h.holdUntil(0.95);
      } },
    { az: 'Faylı əlavə edirəm. Sistem onun barmaq izini özü hesablayır və saxlayır: sonradan dəyişdirilmiş fayl eyni iz verməz, və bunu yoxlamaq üçün heç kimə inanmaq lazım deyil.',
      must: true,
      do: async (p, l, h) => {
        await p.locator('[data-testid=verif-file]').setInputFiles({
          name: 'voen-supply-one.txt', mimeType: 'text/plain',
          buffer: Buffer.from('VÖEN 2345678901 — Supply One MMC\nQeydiyyat çıxarışı (nümunə sənəd).\n'),
        });
        const doc = await h.need('.card .badge.is-info', 'əlavə olunmuş sənəd');
        await h.scrollTo(doc); await h.holdUntil(0.6);
        await h.moveTo('.card .hint[data-tip]'); await h.holdUntil(0.95);
      } },
    { az: 'İkinci sənəd — bank arayışı. Növünü dəyişirəm və faylı qoyuram; siyahı belə yığılır.',
      must: true,
      do: async (p, l, h) => {
        const sel = await h.need('[data-testid=verif-doctype]', 'sənəd növü');
        await sel.selectOption('BANK');
        await h.moveTo(sel); await h.holdUntil(0.4);
        await p.locator('[data-testid=verif-file]').setInputFiles({
          name: 'bank-arayisi.txt', mimeType: 'text/plain',
          buffer: Buffer.from('Bank: Kapital Bank\nIBAN: AZ00KAPB00000000000000000000\n'),
        });
        await h.need('.card .badge.is-info >> nth=1', 'ikinci sənəd');
        await h.holdUntil(0.95);
      } },
    { az: 'Mənim tərəfimdən hamısı budur. Qərar alıcınındır, və onu gözləyərkən tenderlərdə iştirak etməyə heç nə mane olmur.',
      do: async (p, l, h) => { await h.moveTo(`tbody tr:has-text("${STORY.buyer}") .badge`); await h.holdUntil(0.5); await h.moveTo('h1'); await h.holdUntil(0.95); } },
  ]},
  // ГЛАВА «устройство»: тот же каталог со стороны поставщика — без кнопок покупателя.
  'sup-catalogs': { role: 'sup', path: '/supplier/catalogs', scenes: [
    { az: 'Kataloqlar mənim tərəfimdən. Bu, alıcının mənim müqaviləmdən düzəltdiyi kataloqdur: ad, alıcı, status və mövqelərin sayı.',
      must: true,
      do: async (p, l, h) => {
        const row = await h.need(`tbody tr:has-text("${STORY.buyer}")`, 'kataloqun sətri');
        await h.moveTo('h1'); await h.holdUntil(0.4);
        await h.moveTo(row); await h.holdUntil(0.95);
      } },
    { az: 'Açıram: razılaşdırılmış qiymətlər və minimal həcm. Burada düymə yoxdur — kataloqu alıcı idarə edir, mən isə nəyin hansı qiymətlə sifariş oluna biləcəyini görürəm.',
      must: true,
      do: async (p, l, h) => {
        // Именно по ССЫЛКЕ, а не по ячейке: обработчик висит на `<a>`, а клик по широкой
        // ячейке попадает в её середину — мимо текста ссылки, и ничего не раскрывается.
        await h.needClick(`tbody tr:has-text("${STORY.buyer}") td:first-child a`, 'kataloqun adı', 1500);
        const items = await h.need('.card:has(h3) tbody tr', 'mövqelər');
        await h.scrollTo(items); await h.holdUntil(0.6);
        await h.moveTo(items); await h.holdUntil(0.95);
      } },
    { az: 'Bu siyahıdan verilən sifariş birbaşa «Sifarişlər» bölməmdə görünür — tender də, danışıq da olmadan. Qiymət artıq razılaşdırılıb, ona görə addım bir dənədir: hazırla və göndər.',
      do: async (p, l, h) => { await h.moveTo('a[href="/supplier/orders"]'); await h.holdUntil(0.6); await h.moveTo('h1'); await h.holdUntil(0.95); } },
  ]},
  // ГЛАВА «устройство»: договор глазами поставщика — тот же экран без кнопок покупателя.
  'sup-contracts': { role: 'sup', path: '/supplier/contracts', scenes: [
    { az: 'Müqavilələr mənim tərəfimdən: hansı alıcı ilə, hansı müddətə, tavan məbləğ və ondan nə qədərinin artıq götürüldüyü.',
      must: true,
      do: async (p, l, h) => {
        const row = await h.need(`tbody tr:has-text("${STORY.buyer}")`, 'müqavilənin sətri');
        await h.moveTo('h1'); await h.holdUntil(0.35);
        await h.moveTo(row.locator('td').nth(3)); await h.holdUntil(0.65);
        await h.moveTo(row.locator('td.num').first()); await h.holdUntil(0.95);
      } },
    { az: 'Tavan vəd deyil, həddir: onun içində alıcı istədiyi qədər sifariş verə bilər, və hər sifarişin qiyməti müqavilədən gəlir — hər dəfə yenidən razılaşmaq lazım deyil.',
      do: async (p, l, h) => { await h.moveTo(`tbody tr:has-text("${STORY.buyer}") td:nth-child(6)`); await h.holdUntil(0.6); await h.moveTo('thead th:nth-child(6)'); await h.holdUntil(0.95); } },
    { az: 'Aşağıda bu müqavilə üzrə sifarişlər: nömrə, tarix, məbləğ və status. Burada düymə yoxdur — sifarişlə iş «Sifarişlər» bölməsindədir, bu ekran isə mənzərəni göstərir.',
      must: true,
      do: async (p, l, h) => {
        const orders = await h.need('.card:nth-of-type(2) tbody tr, .card h3 + .hint + * tbody tr', 'sifarişlərin cədvəli');
        await h.scrollTo(orders); await h.holdUntil(0.55);
        await h.moveTo(orders); await h.holdUntil(0.95);
      } },
    { az: 'Kataloqdan verilmiş sifariş də burada görünür. Mənim üçün fərq yoxdur: mənbəyi eyni müqavilədir, qiyməti də ondan.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.5); await h.moveTo('a[href="/supplier/orders"]'); await h.holdUntil(0.95); } },
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

// Что глава СОЗДАЁТ на стенде — и чего поэтому на нём быть не должно.
//
// Здесь стоял сторож обратного смысла: он требовал, чтобы на стенде УЖЕ лежало открытое
// событие с таким-то названием, потому что экскурсия снимала заранее залитые данные.
// История создаёт их сама, требование сняли со всех разделов — и сторож стал выходить на
// первой же строке (`if (!wanted.length) return`), продолжая утверждать комментарием, что
// он работает. Вместе с ним замолчала проверка ДУБЛЕЙ по названию, а она как раз стала
// нужнее: сцена ищет свою строку как `tr:has-text("<название>")` и берёт первую, поэтому
// второй тендер с тем же именем снимается молча и не тот.
//
// Проверяется обратное: если глава создаёт строку с таким названием, её на стенде быть не
// должно.
// Пара «как назвать» + «чем посчитать». Запрос пишется целиком, потому что считать
// приходится разное: строку с этим названием, договор по этому тендеру, любой каталог.
// Объявлены ВСЕ главы, которые оставляют на стенде новую строку, а не только те три, чьи
// сцены ищут её по названию: заново снятая глава на непустом стенде ломается по-разному,
// и отказ до съёмки дешевле разбора после.
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const CREATES = {
  'buyer-requests': [['заявка', `SELECT count(*) FROM procurement_requests WHERE title = ${lit(STORY.title)}`]],
  'buyer-events': [['тендер', `SELECT count(*) FROM sourcing_events WHERE title = ${lit(STORY.title)}`]],
  'buyer-contracts': [['договор', `SELECT count(*) FROM contracts WHERE title = ${lit(STORY.title)}`],
                      ['заказ', 'SELECT count(*) FROM purchase_orders']],
  'buyer-catalogs': [['каталог', 'SELECT count(*) FROM catalogs']],
  'sup-invoices': [['счёт', 'SELECT count(*) FROM invoices']],
  'buyer-suppliers': [['дело проверки', 'SELECT count(*) FROM supplier_verification_cases']],
  'sup-verification': [['документ проверки', 'SELECT count(*) FROM supplier_verification_documents']],
  'sup-auction': [['заявка', `SELECT count(*) FROM procurement_requests WHERE title = ${lit(STORY.title2)}`],
                  ['аукцион', `SELECT count(*) FROM sourcing_events WHERE title = ${lit(STORY.title2)}`]],
};

// На какой главе истории стоит стенд.
//
// `CREATES` отвечает на вопрос «не созданы ли уже строки ЭТОЙ главы». Этого мало, и вот
// чем: глава, которая ничего не создаёт, может сниматься на стенде, ушедшем ВПЕРЁД. Так и
// вышло — главу про бюджеты пересняли одну, после всего прогона, а она одиннадцатая из
// двадцати двух. В кадр попали обязательство 60 000 ₼ из заявки на бумагу (глава 22) и
// каталожный заказ (глава 17), экран показал 78,7% при «Plan üzrə +35,2%» красным, а голос
// в это время говорил «тридцать восемь процентов, от плана не отстаём». Ни промаха курсора,
// ни предупреждения: сцена нашла всё, что искала, — просто не те числа.
//
// Поэтому стенд ведёт список снятых глав, а глава отказывается сниматься, если на стенде
// уже сняты ПОЗДНИЕ. Список привязан к поколению стенда (id организации, которую заводит
// наполнение), поэтому пересев обнуляет его сам собой — помнить об этом не нужно.
const PROGRESS_DDL = `CREATE TABLE IF NOT EXISTS guides_progress(
  generation uuid NOT NULL, key text NOT NULL, at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (generation, key))`;

function standGeneration() {
  const gen = standSql(`SELECT id FROM organizations WHERE legal_name = 'Acme MMC' LIMIT 1;`);
  if (!gen) throw new Error('на стенде нет организации «Acme MMC» — он не засеян (pnpm --filter api seed)');
  return gen;
}

function standProgress() {
  standSql(`${PROGRESS_DDL};`);
  const gen = standGeneration();
  const done = standSql(`SELECT key FROM guides_progress WHERE generation = ${lit(gen)};`);
  return { gen, done: new Set(done ? done.split('\n').filter(Boolean) : []) };
}

function markRecorded(gen, key) {
  standSql(`INSERT INTO guides_progress(generation, key) VALUES (${lit(gen)}, ${lit(key)})
            ON CONFLICT DO NOTHING;`);
}

// Отказ — только когда стенд ушёл ВПЕРЁД. Недостающие ранние главы не беда: их данные либо
// на стенде есть (их снимали в прошлый раз), либо нет — и тогда `must`-сцена скажет об этом
// своими словами, назвав, чего не хватило на экране.
function assertStandAtChapter(key, done) {
  const idx = ORDER.indexOf(key);
  const ahead = [...done].filter((k) => ORDER.indexOf(k) > idx);
  if (!ahead.length) return;
  if (process.env.ALLOW_STALE_STAND) {
    console.log(`  ⚠ ${key}: стенд ушёл вперёд (${ahead.join(', ')}), но ALLOW_STALE_STAND снял запрет — `
      + 'числа в кадре могут не совпасть с озвучкой');
    return;
  }
  throw new Error(`Стенд ушёл вперёд истории: на нём уже сняты ${ahead.join(', ')}, а это главы ПОСЛЕ «${key}».\n`
    + `  Их данные попадут в кадр, а озвучка «${key}» о них не говорит — именно так глава про бюджеты\n`
    + '  однажды показала 78,7% под слова «тридцать восемь процентов».\n'
    + '  Пересейте стенд и снимите историю подряд; ALLOW_STALE_STAND=1 снимает запрет для главы,\n'
    + '  числа которой от положения стенда не зависят.');
}

function assertStandClean(keys) {
  const wanted = keys.flatMap((k) => CREATES[k] ?? []);
  if (!wanted.length) return;
  const problems = [];
  for (const [what, sql] of wanted) {
    const n = Number(standSql(`${sql};`));
    if (n > 0) problems.push(`${what}: на стенде уже ${n} — глава создаст ещё, а сцены ищут строку по названию и берут первую`);
  }
  if (problems.length) {
    throw new Error(`Стенд не пуст для этих глав:\n  ${problems.join('\n  ')}\n`
      + '  Пересейте стенд целиком и снимайте историю подряд, либо удалите то, что глава создаёт.');
  }
}

const SECTION_FIELDS = new Set(['role', 'path', 'poster', 'before', 'scenes']);
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
// В КАКОМ ПОРЯДКЕ снимать. Порядок ключей в объекте выше — порядок, в котором разделы
// исторически складывались; порядок съёмки — это порядок СОБЫТИЙ, и он объявлен здесь.
// Прогон без ключей идёт по нему.
//
// Пока порядком по умолчанию был `Object.keys(SECTIONS)`, прогон без ключей снимал первой
// панель, чья озвучка говорит «расход 58 000, экономия 6 000», по пустому экрану: сцена там
// просит только `.card`, поэтому ничего бы не оборвалось, — и умирал позже, на главе,
// которой нужен созданный тендер.
const ORDER = [
  // сквозная часть: одна закупка от заявки до оплаты
  'buyer-requests', 'buyer-events', 'sup-market', 'sup-bid', 'buyer-opening',
  'buyer-contracts', 'sup-orders', 'buyer-logistics', 'sup-invoices', 'buyer-invoices',
  'buyer-budgets', 'buyer-analytics', 'buyer-dashboard',
  // разделы «про устройство» — после неё и на её данных
  'buyer-suppliers', 'sup-verification', 'buyer-verification',
  'buyer-catalogs', 'sup-catalogs', 'sup-contracts', 'sup-dashboard', 'buyer-settings',
  // вторая, короткая история целиком
  'sup-auction',
];

// Список выше и объект разделов обязаны совпадать до ключа: разойдясь, они молча уронили бы
// главу из прогона без ключей (её данные потом не нашла бы следующая) или назвали бы
// несуществующую.
function assertOrderCoversSections() {
  const declared = new Set(Object.keys(SECTIONS));
  const missing = [...declared].filter((k) => !ORDER.includes(k));
  const extra = ORDER.filter((k) => !declared.has(k));
  const dupes = ORDER.filter((k, i) => ORDER.indexOf(k) !== i);
  if (missing.length || extra.length || dupes.length) {
    throw new Error('Порядок съёмки (ORDER) разошёлся с объявленными разделами:'
      + (missing.length ? `\n  нет в порядке: ${missing.join(', ')}` : '')
      + (extra.length ? `\n  нет такого раздела: ${extra.join(', ')}` : '')
      + (dupes.length ? `\n  повторяются: ${dupes.join(', ')}` : ''));
  }
}

function assertKeysExist(keys) {
  const unknown = keys.filter((k) => !SECTIONS[k]);
  if (unknown.length) {
    throw new Error(`Таких разделов нет: ${unknown.map((k) => `«${k}»`).join(', ')}.\n`
      + `  Есть: ${Object.keys(SECTIONS).join(', ')}`);
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

// Вход шести актёров подряд, и это ровно та граница, о которой предупреждает AGENTS.md:
// `/auth/login` ограничен десятью попытками в минуту (защита от перебора и от нагрузки
// argon2). Шесть входов съёмщика плюс пара проверок руками — и очередной вход получает 429,
// а на экране остаётся форма. Прежняя редакция ждала перехода и падала по таймауту
// «waitForURL: Timeout 20000ms», то есть называла ожидание причиной. Теперь читается ответ
// сервера: 429 — подождать и повторить ОДИН раз, любой другой отказ — назвать его кодом.
async function login(ctx, email, attempt = 1) {
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE}/login`);
    await page.fill('input[type=email]', email);
    await page.fill('input[type=password]', 'Passw0rd!');
    const answer = page.waitForResponse(
      (r) => r.url().includes('/auth/login') && r.request().method() === 'POST', { timeout: 20000 });
    await page.click('form button.btn:not(.ghost):not([type=button])');
    const status = (await answer).status();
    if (status === 429) {
      if (attempt > 1) throw new Error(`вход ${email}: сервер отвечает 429 и после паузы — ограничение 10 входов в минуту`);
      console.log(`  вход ${email}: 429, ждём минуту (ограничение 10 входов в минуту) и пробуем ещё раз`);
      await page.close();
      await P(62000);
      return login(ctx, email, attempt + 1);
    }
    if (status >= 400) throw new Error(`вход ${email}: сервер ответил ${status}`);
    await page.waitForURL(/\/(buyer|supplier)\//, { timeout: 20000 });
  } finally {
    await page.close().catch(() => {});
  }
}

(async () => {
  const keys = ONLY.length ? ONLY : ORDER;
  // Доступ к базе стенда обязателен для ЛЮБОГО прогона, а не только для создающих глав:
  // без него молчит сторож положения, а молчащий сторож — это сторож, которого нет.
  if (!process.env.GUIDES_PG_CONTAINER || !process.env.GUIDES_DB) {
    throw new Error('Нужны GUIDES_PG_CONTAINER и GUIDES_DB — без них нечем проверить, в какой точке\n'
      + '  истории стоит стенд, и глава может сняться по данным, о которых её озвучка не говорит.');
  }
  // История снимается на ОДНОМ стенде и за один язык: второму языку нужен свой пересеянный
  // стенд со своими данными, иначе он снимет то, что уже наговорил первый.
  if (LANGS.length > 1) {
    throw new Error(`Сквозная история снимается по одному языку за прогон (передано ${LANGS.join(',')}).\n`
      + '  Данные на стенде создаются самими главами, поэтому второй язык пойдёт по чужой истории —\n'
      + '  пересейте стенд и запустите его отдельно.');
  }
  // Before the stand is asked anything: these judge the source and the arguments, not the
  // data, and an early `return` added to a guard some day must not carry them off.
  assertSectionShape();
  assertOrderCoversSections();
  assertKeysExist(keys);
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
    // Чистота стенда проверяется ПОСЛЕ пересева: иначе прогон с RESEED=1 отказывал на
    // данных, которые сам же собирался стереть.
    assertStandClean(todo);
    const progress = standProgress();

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
        broke = `${key}: нет входа для роли ${[...new Set(unknown)].join(', ')}`;
        console.log(`✗ ${key}.${lang} ОБОРВАНА — ${broke}`);
        break;
      }
      // Стенд обязан стоять НЕ ПОЗЖЕ этой главы, иначе в кадр попадут данные, о которых
      // озвучка не говорит.
      try { assertStandAtChapter(key, progress.done); }
      catch (e) {
        broke = e.message;
        console.log(`✗ ${key}.${lang} ОБОРВАНА — ${e.message.split('\n')[0]}`);
        break;
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
          // Пауза после загрузки нужна первому прогону (зритель видит экран), а на шве между
          // актёрами она — тишина в середине главы. Швы и так дорогие: смена актёра значит
          // новую страницу и новую загрузку, и в главе про аукцион пять швов съедали пятую
          // часть её длины.
          await P(runIdx === 0 ? 1000 : 350);
          // Постер снимается с ПЕРВОГО прогона — если глава начинается на СВОЁМ экране.
          // Там, где она начинается на чужом (тендер рождается на заявках, каталог — на
          // договорах), постер снимается отдельно, после съёмки: иначе в строке подсказки
          // «Каталоги» висела миниатюра «Договоров», и ни одна проверка этого не видела —
          // приёмка смотрит у постера только то, что он вообще картинка.
          if (runIdx === 0 && !sec.poster) await page.screenshot({ path: join(OUT, `${key}.${lang}.png`) }); // clean poster (no cursor)
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
          await P(runIdx === runs.length - 1 ? 1200 : 400);
          parts.push({ actor: run.actor, video: page.video(), offsets, scenes: run.scenes.map((s) => ({ audio: s.audio })) });
          console.log(`  ✓ ${key}.${lang} · ${run.actor} (${Math.round((Date.now() - t0) / 1000)}s)`);
        } catch (e) {
          // Пропуск главы — это тот же обрыв. Раньше не открывшаяся страница или ненайденная
          // роль печатались как SKIPPED, и цикл шёл дальше: следующая глава снимала
          // состояние, которого пропущенная не создала, и обрыв случался позже, называя НЕ ТУ
          // главу. В сквозной истории пропускать нечего.
          broke = e.fatal ? e.message : `${key}: ${e.message.split('\n')[0]}`;
          console.log(`✗ ${key}.${lang} ОБОРВАНА — ${broke}`);
          ok = false;
        } finally {
          await page.close().catch(() => {});
        }
        if (!ok) break;
      }
      // Постер со своего экрана — для глав, которые начинаются на чужом.
      if (ok && parts.length && sec.poster) {
        const pg = await contexts[sec.role].newPage();
        try {
          await pg.goto(`${BASE}${sec.poster}`);
          await pg.waitForSelector('h1', { timeout: 20000 });
          await P(1200);
          await pg.screenshot({ path: join(OUT, `${key}.${lang}.png`) });
        } catch (e) {
          broke = `${key}: постер со своего экрана (${sec.poster}) не снялся — ${e.message.split('\n')[0]}`;
          console.log(`✗ ${key}.${lang} ОБОРВАНА — ${broke}`);
          ok = false;
        } finally {
          // Страница постера живёт в контексте с записью видео и оставляет в tmp ещё один
          // файл, который никому не нужен.
          const extra = pg.video();
          await pg.close().catch(() => {});
          await extra?.delete().catch(() => {});
        }
      }
      if (ok && parts.length) {
        markRecorded(progress.gen, key);
        progress.done.add(key);
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
