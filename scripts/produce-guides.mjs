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
// TTS engine is per-language (see ENGINE): az and ru → Gemini, en → Azure (free Jenny,
// saves Gemini quota). Azure DOES have an Azerbaijani neural voice (az-AZ-BanuNeural, kept
// in AZURE_VOICE and reachable with TTS_AZ=azure), but it was judged too weak by ear, which
// is why az moved to Gemini. Treat that as a listening decision, not a capability limit.
//
// The scenarios themselves were re-written on 2026-11-01 against the interface AFTER the
// October UI pass — see the comment over SECTIONS below.

import { createRequire } from 'module';
import { createHash } from 'crypto';
import { execSync,execFileSync } from 'child_process';
import {assertDemoTarget} from './demo-target.mjs';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
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
const GEMINI_VOICE = { az: 'Kore', ru: 'Kore', en: 'Kore' };
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash-preview-tts';

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
  if (await el.count()) { await el.scrollIntoViewIfNeeded(); await P(700); }
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
async function moveToLoc(page, loc, hold = 650) {
  await injectCursor(page); // re-inject after any navigation wiped the overlay
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  const box = await loc.boundingBox();
  if (!box) return false;
  const x = Math.round(box.x + Math.min(box.width / 2, 70));
  const y = Math.round(box.y + box.height / 2);
  await page.evaluate(([x, y]) => window.__moveCur && window.__moveCur(x, y), [x, y]);
  await page.mouse.move(x, y);
  await P(hold);
  return true;
}
const L = (page, sel) => (typeof sel === 'string' ? page.locator(sel).first() : sel);
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
async function moveTo(page, sel, hold) { return moveToLoc(page, L(page, sel), hold); }
async function fillAt(page, sel, text, delay = 65) {
  const loc = L(page, sel);
  if (!(await moveToLoc(page, loc))) return;
  await loc.click({ delay: 40 }).catch(() => {});
  await loc.selectText().catch(() => {}); // replace any pre-filled value instead of appending
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
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_VOICE[lang] } } },
    },
  };
  let lastErr;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEYS[gKeyIdx]}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) },
      );
      // 429 = per-minute rate/quota cap on the TTS preview model. The window rolls every
      // ~60s, so wait it out (short backoff throws away the whole run) rather than fail.
      if (res.status === 429) {
        const bodyText = await res.text().catch(() => '');
        if (/PerDay/i.test(bodyText)) {
          gExhausted.add(gKeyIdx);
          const next = GEMINI_KEYS.findIndex((_, i) => !gExhausted.has(i));
          if (next === -1) throw new Error('Gemini: all keys hit their DAILY quota');
          console.log(`  · Gemini key #${gKeyIdx + 1} daily cap — switching to key #${next + 1}`);
          gKeyIdx = next; continue;
        }
        const wait = Math.min(62000, 18000 * attempt);
        console.log(`  · Gemini 429 (rate limit) — waiting ${Math.round(wait / 1000)}s, retry ${attempt}/10`);
        await P(wait);
        continue;
      }
      if (!res.ok) throw new Error(`Gemini TTS ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const j = await res.json();
      const part = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
      if (!part) throw new Error('Gemini TTS: no audio in response');
      const rate = (part.inlineData.mimeType.match(/rate=(\d+)/) || [])[1] || '24000';
      const raw = `${out}.pcm`;
      writeFileSync(raw, Buffer.from(part.inlineData.data, 'base64'));
      execSync(`ffmpeg -y -loglevel error -f s16le -ar ${rate} -ac 1 -i "${raw}" -codec:a libmp3lame -q:a 3 "${out}"`);
      await P(1200); // gentle pacing to stay under the per-minute cap
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < 10) await P(2000 * attempt);
    }
  }
  throw lastErr;
}

// Per-language content typed live into forms during a scene — so the az video types
// Azerbaijani, the ru video Russian, the en video English (never a foreign string on screen).
const FILL = {
  ru: { reqTitle: 'Ноутбуки для отдела продаж', reqItem: 'Ноутбук 15", 16 ГБ' },
  az: { reqTitle: 'Satış şöbəsi üçün noutbuklar', reqItem: 'Noutbuk 15", 16 GB' },
  en: { reqTitle: 'Laptops for the sales team', reqItem: 'Laptop 15", 16 GB' },
};
// Localized substrings for the "click a tender by title" navigation — must match the titles
// demo-fill seeds per language (TXT.*Ev), so the click lands on the same row in every language.
const NAV = {
  serverTender: { ru: 'серверное оборудование', az: 'server avadanlığı', en: 'server hardware' },
  furnitureTender: { ru: 'офисная мебель', az: 'ofis mebeli', en: 'office furniture' },
  fuelTender: { ru: 'дизельное топливо', az: 'dizel yanacağı', en: 'diesel fuel' },
};
// Localized button captions the scenarios click (t() keys from apps/web/src/i18n.tsx).
const BTN = {
  invite: { ru: 'Пригласить', az: 'Dəvət et', en: 'Invite' },
  cancel: { ru: 'Отмена', az: 'Ləğv et', en: 'Cancel' },
  bids: { ru: 'Ставки', az: 'Təkliflər', en: 'Bids' },
};
const API_URL = process.env.DEMO_API ?? 'http://localhost:3000';
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
  ]},
  // Requests. The pass changed this screen most: the table gained the author and the
  // method columns (separation of duties is visible now), and the four procedure
  // buttons became ONE dropdown with the policy's own choice preselected.
  'buyer-requests': { role: 'buyer', path: '/buyer/requests', scenes: [
    { az: 'Sorğular bölməsi — hər satınalma buradan başlayır. Sorğu daxili tələbatdır: kimsə nəyəsə ehtiyac duyur, onu rəsmiləşdirir və təsdiqdən keçirir. Yalnız bundan sonra pul hərəkət edir.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.45); await h.moveTo('form'); await h.holdUntil(0.9); } },
    { az: 'Yeni sorğu forması yuxarıdadır. Başlıq — nəyin və nə üçün alındığını bir cümlə ilə izah edir. Təsdiqləyən adam ilk növbədə məhz bunu oxuyur.',
      do: async (p, l, h) => { await h.fill('[data-testid=req-title]', 'Anbar üçün metal rəflər'); await h.holdUntil(0.9); } },
    { az: 'Kateqoriya — nə alırıq. O, iki şeyə təsir edir: hansı büdcədən pul gedəcək və satınalma metodu nə olacaq. Siyahı parametrlərdəki vahid kataloqdan gəlir, ona görə «IT» və «it» ayrı kateqoriyaya çevrilmir.',
      do: async (p, l, h) => { await h.fill('[data-testid=req-category]', 'OFFICE'); await h.holdUntil(0.9); } },
    { az: 'Şöbə — kim xərcləyir. Boş buraxsanız, sistem sizin öz şöbənizi qoyur. Bu sahə büdcənin şöbələr üzrə bölgüsünün əsasıdır: sorğu məhz buradan öz məsrəf mərkəzinə düşür. Arxivə göndərilmiş şöbə yeni sorğuda seçilmir.',
      do: async (p, l, h) => { await h.moveTo('[data-testid=req-department]'); await h.holdUntil(0.4); await selectByPrefix(p, '[data-testid=req-department]', 'OPS'); await h.holdUntil(0.92); } },
    { az: 'İndi mövqelər: ad, say və vahid qiymətin smetası. Diqqət edin — siz ümumi məbləği yazmırsınız. Server onu sətirlərdən özü hesablayır, ona görə səhv və ya uydurma cəm mümkün deyil.',
      do: async (p, l, h) => { await h.fill('[data-testid=item-name-0]', 'Metal rəf 200×100'); await h.holdUntil(0.4); await h.fill('[data-testid=item-qty-0]', '6'); await h.holdUntil(0.65); await h.fill('[data-testid=item-price-0]', '180'); await h.holdUntil(0.93); } },
    { az: 'Bir neçə mövqe lazımdırsa, «Mövqelər» düyməsi yeni sətir əlavə edir. «Yarat» düyməsi sorğunu qaralama kimi yaradır — istənilən vaxt düzəliş etmək olar. Biz indi yaratmırıq, forma yalnız nümayiş üçündür.',
      do: async (p, l, h) => { await h.hover('form button.ghost', 1100); await h.holdUntil(0.5); await h.moveTo('form button.btn:not(.ghost)'); await h.holdUntil(0.92); } },
    { az: 'Aşağıda sorğuların reyestri. Yuxarıda axtarış sahəsi və şöbə süzgəci var: başlıqdan axtarırsınız və ya bir şöbənin bütün sorğularını göstərirsiniz.',
      do: async (p, l, h) => { await h.scrollTo('table'); await h.holdUntil(0.35); await h.moveTo(p.locator('input[placeholder*="Başlıq"]')); await h.holdUntil(0.65); await h.moveTo(p.locator('.card select').first()); await h.holdUntil(0.92); } },
    { az: 'Sütunlar: nömrə, başlıq, kateqoriya, şöbə, tarix, təşəbbüsçü, məbləğ, status və metod. Təşəbbüsçü sütunu təsadüfi deyil — öz sorğusunu təsdiqləmək qadağandır, ona görə kimin yazdığı siyahıda açıq görünməlidir.',
      do: async (p, l, h) => { const th = p.locator('thead th'); await h.moveTo(th.nth(3)); await h.holdUntil(0.3); await h.moveTo(th.nth(5)); await h.holdUntil(0.6); await h.moveTo(p.locator('tbody tr').first().locator('td').nth(5)); await h.holdUntil(0.92); } },
    { az: 'Statuslar belə oxunur: qaralama — hələ redaktə olunur, göndərilib — təsdiq gözləyir, təsdiqlənib — satınalmanı başlatmaq olar. Rədd edilmiş sorğu tarixçədə qalır, silinmir. Təsdiq zənciri varsa, statusun altında addımların sayı və növbənin kimdə olduğu yazılır.',
      do: async (p, l, h) => { const r = p.locator('tbody tr'); await h.hover(r.nth(0).locator('.badge'), 900); await h.holdUntil(0.4); await h.hover(r.nth(1).locator('.badge'), 900); await h.holdUntil(0.7); await h.moveTo(r.nth(2).locator('.badge')); await h.holdUntil(0.93); } },
    { az: 'Təsdiq iki klikdən ibarətdir, və bu qəsdəndir. Birinci klik sorğunun içini açır: mövqelər, qiymətlər və ən əsası büdcəyə təsiri — hansı büdcədən nə qədər gedəcək və faiz neçəyə çatacaq. İkinci klik artıq təsdiqdir, düymənin özü də «Təsdiqi təsdiq et» olur.',
      do: async (p, l, h) => { const b = p.locator('tbody button:text-is("Təsdiqlə")').first(); if (await b.count()) { await h.click(b, 1400); } else { await h.moveTo(p.locator('tbody .btn').first()); } await h.holdUntil(0.93); } },
    { az: 'Büdcəyə uyğun plan yoxdursa, sistem bunu da deyir — rəqəmi uydurmur. Həddi aşan təsdiq isə dayandırılır, və yalnız administrator yazılı əsaslandırma ilə keçə bilər. Əsaslandırma audit jurnalına düşür.',
      do: async (p, l, h) => { const imp = p.locator('tbody tr td[colspan] b').first(); if (await imp.count()) { await h.moveTo(imp); await h.holdUntil(0.5); await h.moveTo(p.locator('tbody tr td[colspan] .hint').last()); } else { await h.moveTo('table'); await h.holdUntil(0.5); } await h.holdUntil(0.93); } },
    { az: 'Təsdiqlənmiş sorğuda prosedur seçimi görünür. Əvvəl burada yan-yana dörd düymə dururdu və onları başa salmaq üçün altda legenda lazım idi. İndi bir siyahı var, və metod siyasətinin özü seçdiyi variant əvvəlcədən qoyulub — adi hal bir klikdə qalır.',
      do: async (p, l, h) => { await h.scrollTo('table'); await h.holdUntil(0.3); const sel = p.locator('select[aria-label="Satınalma üsulu"]').first(); if (await sel.count()) { await h.moveTo(sel); await h.holdUntil(0.65); await h.hover(p.locator('button:text-is("Elan et")').first(), 1100); } else { await h.moveTo('.hint'); } await h.holdUntil(0.93); } },
    { az: 'Siyahıda beş variant var: qapalı tender möhürlü qiymətlərlə, açıq tender — eyni möhürlü qiymətlər, amma bütün təchizatçılara açıq, texniki təklifli tender, məlumat sorğusu və revers-auksion. Hamısının izahı cədvəlin üstündəki legendadadır.',
      do: async (p, l, h) => { await h.moveTo('.hint:has-text("açıq tender")'); await h.holdUntil(0.55); await h.hover('.hint a[href="/buyer/settings"]', 1100); await h.holdUntil(0.93); } },
    { az: 'Kiçik məbləğləri siyasət avtomatik birbaşa sifarişə göndərir — metodu istifadəçi seçmir, qaydalar seçir. Onda prosedur siyahısı yerinə «Birbaşa sifariş» düyməsi görünür və sizdən yalnız təchizatçını seçmək istənilir.',
      do: async (p, l, h) => { const d = p.locator('button:has-text("Birbaşa sifariş")').first(); if (await d.count()) { await h.hover(d, 1400); } else { await h.moveTo(p.locator('thead th').nth(8)); } await h.holdUntil(0.93); } },
    { az: 'Və sonuncu: təsdiqlənmiş, amma artıq lazım olmayan sorğunu ləğv etmək olar. Bu, cədvəldə yeganə dağıdıcı əməliyyatdır, ona görə ayrıca, sətrin sonunda durur və səbəb tələb edir. Ləğv büdcədəki öhdəliyi azad edir — pul boş yerə bloklanmış qalmır.',
      do: async (p, l, h) => { const c = p.locator('tbody button.danger').first(); if (await c.count()) { await h.hover(c, 1400); } else { await h.moveTo(p.locator('tbody tr').first()); } await h.holdUntil(0.93); } },
  ]},
  // Tenders: the list, then a real tender's card. The chip is the point of the first
  // half — PR #74 taught it to tell a closed tender from an open one — and the sealed
  // amounts are the point of the second.
  'buyer-events': { role: 'buyer', path: '/buyer/events', scenes: [
    { az: 'Tenderlər bölməsi. Təsdiqlənmiş sorğudan başlayan hər satınalma proseduru buradadır. Sütunlar: başlıq, metod, status, son tarix və gələn təkliflərin sayı — sayı, məbləğləri yox.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.4); await h.moveTo('table'); await h.holdUntil(0.7); await h.moveTo(p.locator('thead th').nth(4)); await h.holdUntil(0.95); } },
    { az: 'Metod sütunu nişanla göstərilir və hər nişanın öz izahı var. Qıfıl — qapalı tender: təchizatçılar möhürlü qiymət verir və məbləğlər açılışa qədər heç kimə görünmür, iştirak isə dəvət üzrədir.',
      do: async (p, l, h) => { await h.hover(p.locator('tbody .chip').first(), 1500); await h.holdUntil(0.6); await h.moveTo(p.locator('tbody .chip').nth(1)); await h.holdUntil(0.95); } },
    { az: 'Qlobus — açıq tender. Qiymətlər eyni şəkildə möhürlənir, lakin tenderi bütün təchizatçılar görür və hər kəs təklif verə bilər. Bu fərq vacibdir: əvvəl açıq tender də qıfılla göstərilirdi, yəni ekran onu dəvət üzrə prosedur kimi — tam tərsinə — adlandırırdı.',
      do: async (p, l, h) => { const g = p.locator('tbody .chip:has-text("Açıq tender")').first(); if (await g.count()) { await h.hover(g, 1500); } else { await h.hover(p.locator('tbody .chip').nth(1), 1200); } await h.holdUntil(0.95); } },
    { az: 'Qalan üç nişan: sənəd — texniki təklifli tender, sual işarəsi — məlumat sorğusu, qiymətsiz, və şimşək — revers-auksion, orada qiymət real vaxtda aşağı düşür. Auksion adı interfeysin dilində yazılır, çünki o, üç hərflik qısaltma deyil.',
      do: async (p, l, h) => { const chips = p.locator('tbody .chip'); const n = await chips.count(); await h.hover(chips.nth(Math.min(2, n - 1)), 1200); await h.holdUntil(0.5); await h.hover(chips.nth(Math.min(3, n - 1)), 1200); await h.holdUntil(0.95); } },
    { az: 'Status prosedurun harada olduğunu deyir: təkliflər qəbul olunur, qəbul bağlanıb və açılış gözlənilir, qiymətləndirmə gedir, yaxud qalib artıq seçilib. Statusun da izahı var — nişanın üzərinə gətirmək kifayətdir.',
      do: async (p, l, h) => { const rows = p.locator('tbody tr'); await h.hover(rows.nth(0).locator('.badge'), 1300); await h.holdUntil(0.5); await h.hover(rows.nth(1).locator('.badge'), 1100); await h.holdUntil(0.95); } },
    { az: 'Konkret tenderi açaq — bütün iş onun kartında gedir.',
      do: async (p, l, h) => { await h.moveTo(p.locator('tbody a').first()); await h.holdUntil(0.4); await h.click(p.locator('tbody a').first(), 1800); await p.waitForSelector('h1', { timeout: 15000 }); await h.holdUntil(0.95); } },
    { az: 'Başlığın yanında eyni metod nişanı və status var — siyahıda nə gördünüzsə, kartda da onu görürsünüz. Altda isə faktlar sətri: hər fakt öz adı ilə yazılıb. Əvvəl orada tarix, bazadan çıxmış bir söz və tək bir valyuta kodu dururdu, və heç biri nə olduğunu demirdi.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.35); await h.moveTo(p.locator('.fact').nth(0)); await h.holdUntil(0.65); await h.hover(p.locator('.fact').nth(1), 1300); await h.holdUntil(0.95); } },
    { az: 'Son tarixi server nəzarət edir: ondan sonra gələn təklif gec sayılır və iştirak etmir. Bu, mübahisə mövzusu deyil — vaxtı sistem qeyd edir, insan yox. Görünürlük isə kimin təklif verə biləcəyini sözlə deyir, kod kimi yox.',
      do: async (p, l, h) => { await h.moveTo(p.locator('.fact').nth(0).locator('.fact-v')); await h.holdUntil(0.45); await h.moveTo(p.locator('.fact').nth(2)); await h.holdUntil(0.95); } },
    { az: 'Düymələr tenderin statusuna görə görünür: qaralamanı dərc edirsiniz, müddəti bitəni açırsınız, auksionu yekunlaşdırırsınız. Yanında OCDS ixracı var, və altında onun nə olduğu bir sətirlə yazılıb — üç hərf Bakıda heç nə demir, əgər kimsə onu açmayıbsa.',
      do: async (p, l, h) => { await h.moveTo(p.locator('.card button.btn').first()); await h.holdUntil(0.4); await h.hover(p.locator('button:has-text("OCDS")').first(), 1300); await h.holdUntil(0.7); await h.moveTo(p.locator('.hint:has-text("OCDS")').first()); await h.holdUntil(0.95); } },
    { az: 'Təkliflər qəbul olunarkən təchizatçıları dəvət edirsiniz: siyahıdan şirkəti seçib «Dəvət et» düyməsini basırsınız. Dəvət olunan tenderi öz ekranında görür.',
      do: async (p, l, h) => { const sel = p.locator('.card select').first(); if (await sel.count()) { await h.moveTo(sel); await h.holdUntil(0.55); await h.hover(p.locator('button:text-is("Dəvət et")').first(), 1200); } else { await h.moveTo('.fact-row'); } await h.holdUntil(0.95); } },
    { az: 'Cavab verməyən dəvətlilər üçün avtomatik xatırlatmalar var: addımlar, kanal və hər addımın nə qədər sonra gedəcəyi. İlk təklif gələn kimi zəncir özü dayanır — yəni təklif verən adama xatırlatma getmir.',
      do: async (p, l, h) => { const fu = p.locator('.card:has(h3:has-text("Avtomatik xatırlatmalar"))'); if (await fu.count()) { await h.scrollTo(fu); await h.holdUntil(0.4); await h.moveTo(fu.locator('.hint').first()); await h.holdUntil(0.7); await h.moveTo(fu.locator('table, .chip').first()); } else { await h.wheel(250); } await h.holdUntil(0.95); } },
    { az: 'Mövqelər sorğudan götürülmüş snapshotdur: ad, say və ilkin qiymət smetası. Tender başlayandan sonra bu siyahı dəyişmir — hamı eyni şərtlərə təklif verir. Lotlar mövqeləri qruplaşdırır, və bu praktik şeydir: serverləri bir təchizatçıya, quraşdırmanı başqasına vermək olar.',
      do: async (p, l, h) => { await h.scrollTo('h3:has-text("Lotlar")'); await h.holdUntil(0.4); await h.moveTo('.card:has(h3:has-text("Lotlar")) table'); await h.holdUntil(0.7); await h.moveTo(p.locator('.card:has(h3:has-text("Lotlar")) tbody tr').first()); await h.holdUntil(0.95); } },
    { az: 'Aşağıda təkliflər. Ən vacib qayda budur: açılışa qədər sifarişçi məbləğləri görmür — yalnız kimin iştirak etdiyini. Başlıqdaki qıfıl elə bunu bildirir, məbləğ sütununda da qıfıl durur. Qiymətlər şifrələnmiş saxlanılır və açılış mərasimindən əvvəl açılmır.',
      do: async (p, l, h) => { await h.scrollTo('h3:has-text("Təkliflər")'); await h.holdUntil(0.35); const sealed = p.locator('.sealed').first(); if (await sealed.count()) await h.moveTo(sealed); await h.holdUntil(0.65); await h.moveTo(p.locator('.card:has(h3:has-text("Təkliflər")) tbody tr').first()); await h.holdUntil(0.95); } },
    { az: 'Açılışdan sonra məbləğlər, çatdırılma müddətləri və qiymətləndirmə görünür. Qiymətləndirmə sütunu yüzdən hesablanır, və bu da başlıqda yazılıb: əvvəl orada «Qiymətləndir» əmri dururdu, yəni sütun felin adını daşıyırdı.',
      do: async (p, l, h) => { const sc = p.locator('th:has-text("Qiymətləndirmə")').first(); if (await sc.count()) { await h.hover(sc, 1400); } else { await h.moveTo(p.locator('.card:has(h3:has-text("Təkliflər")) thead th').nth(2)); } await h.holdUntil(0.95); } },
    { az: 'Meyarlar və çəkilər tender yaradılanda təsbit olunur və açılışdan sonra dəyişmir — yoxsa qalibi meyarları yenidən çəkməklə seçmək olardı. Siz yalnız qiymətləri yazırsınız, çəkili cəmi sistem hesablayır.',
      do: async (p, l, h) => { const inp = p.locator('.card:has(h3:has-text("Təkliflər")) input[type=number]').first(); if (await inp.count()) { await h.moveTo(inp); await h.holdUntil(0.5); await h.hover(p.locator('button:text-is("Qiymətləndir")').first(), 1200); } else { await h.moveTo('table'); } await h.holdUntil(0.95); } },
    { az: 'Qalib hər lot üzrə ayrıca seçilir. Ulduz qiymətləndirmədə birinci olan təklifi göstərir — auksionda isə ən yaxşı qiyməti. Ulduz olmayan təklifi seçmək olar, amma onda əsaslandırma tələb olunur, və tək təklif olanda da. Qərar həmişə izah olunur.',
      do: async (p, l, h) => { const aw = p.locator('.card:has(h3:has-text("Qalib seç"))'); if (await aw.count()) { await h.scrollTo(aw); await h.holdUntil(0.4); await h.hover(aw.locator('button.btn').first(), 1400); await h.holdUntil(0.75); await h.moveTo(aw.locator('button.btn').last()); } else { await h.wheel(220); } await h.holdUntil(0.95); } },
    { az: 'Təklifi kənarlaşdırmaq da olar — səbəblə. Səbəb audit jurnalına düşür və kartda görünür; təchizatçı isə təklifinin kənarlaşdırıldığını görür, səbəbi görmür. Səhv seçilmiş qalibi isə ləğv etmək və lotu yenidən seçmək mümkündür.',
      do: async (p, l, h) => { const dq = p.locator('button:has-text("Diskvalifikasiya")').first(); const ca = p.locator('button:has-text("Qalibi ləğv et")').first(); if (await dq.count()) await h.hover(dq, 1300); else if (await ca.count()) await h.hover(ca, 1300); await h.holdUntil(0.95); } },
    { az: 'Süni intellekt tövsiyəsi ayrı kartdadır. O, açılmış təklifləri qiymət, müddət və təchizatçının etibarlılığı üzrə sıralayır və hər sətri izah edir. Kartın üzərində birbaşa yazılıb ki, bu tövsiyədir, qərar deyil — qalibi siz seçirsiniz.',
      do: async (p, l, h) => { const ai = p.locator('.card:has(h3:has-text("Süni intellekt"))'); if (await ai.count()) { await h.scrollTo(ai); await h.holdUntil(0.4); await h.moveTo(ai.locator('.hint').first()); await h.holdUntil(0.7); await h.hover(ai.locator('button.btn').first(), 1200); } else { await h.wheel(250); } await h.holdUntil(0.95); } },
    { az: 'Sual-cavab bloku bərabər məlumat prinsipini qoruyur: bir təchizatçının sualına verilən cavabı bütün iştirakçılar görür. İzah dərc etmək də olar — o da hamıya gedir. Beləliklə heç kim gizli izahat almır.',
      do: async (p, l, h) => { await h.scrollTo('h3:has-text("Sual-cavab")'); await h.holdUntil(0.4); await h.moveTo(p.locator('.card:has(h3:has-text("Sual-cavab"))')); await h.holdUntil(0.95); } },
    { az: 'Qalib seçiləndən sonra tenderdən müqavilə yaranır, müqavilədən isə sifariş. Zəncir qırılmır: sorğu, tender, müqavilə, sifariş, qəbul və qaimə. Hər addım audit jurnalına yazılır — kim dərc etdi, kim açdı, kim qiymətləndirdi, kim qalibi seçdi. Nəticəni sonradan izah etmək mümkündür.',
      do: async (p, l, h) => { await h.wheel(-900); await h.holdUntil(0.35); const mc = p.locator('button:has-text("Müqavilə yarat")').first(); if (await mc.count()) { await h.hover(mc, 1400); } else { await h.moveTo('h1'); } await h.holdUntil(0.95); } },
  ]},
  // Contracts and orders. The orders table lost its second <h1> in the pass and the
  // action cell was re-ordered: the primary action leads, stopping an order sits last
  // behind a divider. The ceiling column («İstifadə olunub») is the one finance reads.
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
    { az: 'Əməliyyatlar bir sətirdə düzülüb və sıralama məna üzrədir: əsas addım əvvəldə, sifarişi dayandırmaq isə ən sonda, ayırıcıdan sonra. Əvvəl düymələr mənbə kodundaki sıra ilə düşürdü, və dağıdıcı olan birinci dura bilirdi.',
      do: async (p, l, h) => { const act = p.locator('.card:has(h3:has-text("Satınalma sifarişləri")) .actions').first(); if (await act.count()) { await h.moveTo(act.locator('button').first()); await h.holdUntil(0.55); await h.moveTo(act.locator('button').last()); } else { await h.moveTo('table'); } await h.holdUntil(0.92); } },
    { az: 'Ən vacib addım qəbuldur: «Qəbul et» düyməsi gələn malı rəsmiləşdirir. Məhz qəbul edilmiş sifariş analitikada və büdcədə xərc kimi sayılır — göndərilmiş deyil, qəbul edilmiş.',
      do: async (p, l, h) => { const r = p.locator('button:has-text("Qəbul et")').first(); if (await r.count()) { await h.hover(r, 1500); } else { await h.moveTo(p.locator('.card:has(h3:has-text("Satınalma sifarişləri")) tbody tr').last()); } await h.holdUntil(0.92); } },
    { az: 'Sifarişin şərtləri dəyişməlidirsə, «Dəyişdir» düyməsi dəyişiklik təklifi açır: say və ya qiymət, üstəgəl səbəb. Bu, birtərəfli düzəliş deyil — təchizatçı razılıq verməlidir, yalnız ondan sonra sifarişin məbləği yenidən hesablanır.',
      do: async (p, l, h) => { const am = p.locator('button:has-text("Dəyişdir")').first(); if (await am.count()) { await h.click(am, 1600); await h.holdUntil(0.6); await h.moveTo(p.locator('.card:has(h3:has-text("Dəyişikliklər")) table').first()); } else { await h.wheel(200); } await h.holdUntil(0.92); } },
    { az: 'Köhnə və yeni dəyər tarixçədə saxlanılır, ona görə sifariş dəyişsə də, nəyin nəyə çevrildiyi həmişə görünür. Beləliklə zəncir tamamlanır: sorğu, tender, müqavilə, sifariş, qəbul və qaimə — istənilən xərci geriyə, konkret sorğuya qədər izləmək olar.',
      do: async (p, l, h) => { await h.wheel(-400); await h.holdUntil(0.45); await h.moveTo(p.locator('.card').nth(0).locator('table')); await h.holdUntil(0.92); } },
  ]},
  // Invoices: the last gate before money leaves. The stand carries all four outcomes at
  // once. The payment-due column was REMOVED in the pass (it stood empty on every row
  // in every org), so the status column is now the sixth cell, not the seventh.
  'buyer-invoices': { role: 'buyer', path: '/buyer/invoices', scenes: [
    { az: 'Qaimələr bölməsi. Bu, pul şirkətdən çıxmazdan əvvəlki son yoxlama nöqtəsidir. Təchizatçı sifariş üzrə qaimə verir, sistem isə onu dərhal üç mənbə ilə tutuşdurur: nə sifariş olunub, faktiki nə qəbul edilib və qaimədə nə yazılıb.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.4); await h.moveTo('table'); await h.holdUntil(0.95); } },
    { az: 'Sütunlar: qaimənin nömrəsi, hansı sifariş üzrə verildiyi, təchizatçı, tarix, məbləğ və status. Burada «ödəniş müddəti» sütunu yox idi deyə yox, əksinə — o vardı və bütün sətirlərdə boş dururdu. Boş sütun söz vermiş olur, ona görə götürüldü.',
      do: async (p, l, h) => { const th = p.locator('thead th'); await h.moveTo(th.nth(1)); await h.holdUntil(0.35); await h.moveTo(th.nth(4)); await h.holdUntil(0.68); await h.moveTo(th.nth(5)); await h.holdUntil(0.95); } },
    { az: 'Statuslarda dörd hal var. «Uyğundur» — yoxlamadan keçib, qərar gözləyir. «Mübahisəli» — keçməyib. «Təsdiqlənib» — ödəniş gözləyir. «Ödənilib» — artıq bağlanmış xərc. Hər nişanın izahı özündədir.',
      do: async (p, l, h) => { const r = p.locator('tbody tr'); await h.hover(r.nth(0).locator('.badge'), 1200); await h.holdUntil(0.35); await h.hover(r.nth(1).locator('.badge'), 1100); await h.holdUntil(0.65); await h.hover(r.nth(2).locator('.badge'), 1100); await h.holdUntil(0.95); } },
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
      do: async (p, l, h) => { await h.moveTo(p.locator('tbody tr:has-text("INV-2026-0003") td').nth(5)); await h.holdUntil(0.5); await h.moveTo(p.locator('tbody tr:has-text("INV-2026-0002") td').nth(5)); await h.holdUntil(0.95); } },
    { az: 'Təsdiq və ödəniş ayrı addımlardır. Təsdiqlənmiş qaimədə «Ödə» düyməsi görünür — yəni «sənəd düzgündür» qərarı ilə «pulu köçürdük» qeydi bir-birinə qarışmır.',
      do: async (p, l, h) => { const pay = p.locator('button:has-text("Ödə")').first(); if (await pay.count()) { await h.hover(pay, 1600); } else { await h.moveTo(p.locator('tbody tr').nth(3).locator('td').nth(5)); } await h.holdUntil(0.95); } },
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
      do: async (p, l, h) => { const r = p.locator('[data-testid=budget-rollup] tbody tr').first(); await h.hover(r.locator('td').nth(4), 1800); await h.holdUntil(0.7); await h.moveTo(r.locator('td').nth(5)); await h.holdUntil(0.95); } },
    { az: 'Proqnoz sütunu ən çox soruşulan suala cavab verir: bu templə dövrün sonunda nə olacaq. Rəqəm qırmızıdırsa, plan aşılacaq. Yanında isə mənimsənilmə faizi və onun altında «planla indiyə qədər nə qədər olmalı idi» yazılır. Səksən faiz mayda və səksən faiz noyabrda tamam fərqli şeylərdir.',
      do: async (p, l, h) => { const rows = p.locator('[data-testid=budget-rollup] tbody tr'); await h.hover(rows.nth(0).locator('td').nth(6), 1500); await h.holdUntil(0.55); await h.moveTo(rows.nth(0).locator('td').nth(7)); await h.holdUntil(0.95); } },
    { az: 'Təqvim payının bir şərti var: o, xərcin il boyu bərabər getdiyini güman edir. Həqiqətdə isə belə olmur — istilik qışa düşür, texnika alışı ilin sonuna. Ona görə planı aylara bölmək olar: sətirdəki təqvim düyməsini açırıq.',
      do: async (p, l, h) => { await h.scrollTo('[data-testid=budget-list]'); await h.holdUntil(0.4); const ph = p.locator('[data-testid=budget-list] button:has-text("Aylar üzrə bölgü")').first(); if (await ph.count()) { await h.click(ph, 1600); } else { await h.moveTo('[data-testid=budget-list]'); } await h.holdUntil(0.95); } },
    { az: 'Hər ay üçün payı faizlə yazırsınız, altında dərhal məbləğ görünür. Cəmi mütləq yüz faiz olmalıdır — sistem yarımçıq bölgünü yadda saxlamır, çünki cəmi yüz olmayan plan plan deyil. Bölgünü silmək isə bərabər bölgüyə qaytarır.',
      do: async (p, l, h) => { const c = p.locator('tr:has-text("Aylar üzrə bölgü")').first(); if (await c.count()) { await h.moveTo(c.locator('input').nth(0)); await h.holdUntil(0.35); await h.moveTo(c.locator('input').nth(6)); await h.holdUntil(0.65); await h.moveTo(c.locator('.hint').last()); } await h.holdUntil(0.95); } },
    { az: 'Bölgü veriləndən sonra tempin mənası dəyişir. İndi «planla nə qədər olmalı idi» sualına təqvim yox, sizin öz mövsümiliyiniz cavab verir — və payıza yığılmış büdcə yazda daha artıq xərclənmiş kimi görünmür. Yekun cədvəlində hansı sətrin bölgü ilə oxunduğu da bilinir.',
      do: async (p, l, h) => { await h.scrollTo('[data-testid=budget-rollup]'); await h.holdUntil(0.45); await h.hover(p.locator('[data-testid=budget-rollup] tbody tr').first().locator('td').nth(7), 1600); await h.holdUntil(0.95); } },
    { az: 'İndi ən vacib imkan: hər rəqəmin arxasına baxmaq olar. Öhdəlik və faktiki məbləğlər klikləniləndir — sistem göstərir, məhz hansı sənədlərdən ibarətdir. Maliyyəçinin istənilən cəm haqqında ilk sualı budur: nədən yığılıb.',
      do: async (p, l, h) => { await h.scrollTo('[data-testid=budget-list]'); await h.holdUntil(0.25); const cell = await firstNonZero(p, '[data-testid=budget-list] .linklike'); await h.click(cell, 1400); await h.holdUntil(0.75); await h.wheel(140); await h.holdUntil(0.95); } },
    { az: 'Siyahıda sənədin nömrəsi, adı, kateqoriyası, şöbəsi, tarixi və məbləği var. Bu siyahı həmişə yuxarıdaki rəqəmlə üst-üstə düşür, çünki eyni qayda ilə hesablanır — cədvəl ayrıca, rəqəm ayrıca yaşamır.',
      do: async (p, l, h) => { const inner = p.locator('[data-testid=budget-list] table table tbody tr'); if (await inner.count()) { await h.moveTo(inner.first()); await h.holdUntil(0.45); await h.moveTo(inner.last()); } else { await h.wheel(120); } await h.holdUntil(0.95); } },
    { az: 'Hər büdcənin öz statusu var və bu, adi cədvəl sətri deyil — büdcə sənəddir. Qaralama hazırlanır və hələ pul saxlamır. Təsdiq gözləyən redaktə üçün bağlıdır. Qüvvədə olandan xərc silinir. Bağlanmış dövr isə artıq dəyişmir.',
      do: async (p, l, h) => { await h.scrollTo('[data-testid=budget-list]'); await h.holdUntil(0.3); const b = p.locator('[data-testid=budget-list] tbody .badge'); await h.hover(b.first(), 1400); await h.holdUntil(0.65); await h.hover(b.nth(1), 1200); await h.holdUntil(0.95); } },
    { az: 'Qaralamanı «Göndər» düyməsi təsdiqə yollayır, başqa bir adam onu təsdiqləyir və ya rədd edir. Göndərilmiş büdcəni geri almaq da olar — redaktə üçün. Rədd səbəbi, geri açma səbəbi, hamısı yazılır.',
      do: async (p, l, h) => { const row = p.locator('[data-testid=budget-list] tbody tr').first(); await h.moveTo(row.locator('button').first()); await h.holdUntil(0.4); await h.hover(row.locator('button').first(), 1300); await h.holdUntil(0.75); await h.moveTo(row.locator('button').nth(1)); await h.holdUntil(0.95); } },
    { az: 'Qüvvədə olan büdcənin adı, şöbəsi və dövrü artıq dəyişmir — bunlar təsdiqlənmiş şərtlərdir. Yalnız məbləğ düzəlir, özü də səbəb yazmadan yox. Saat düyməsi bütün düzəlişlərin tarixçəsini açır: tarix, məbləğ, fərq, səbəb və kimin etdiyi.',
      do: async (p, l, h) => { const hb = p.locator('[data-testid=budget-list] button:has-text("Tarixçə")').first(); if (await hb.count()) { await h.click(hb, 1500); await h.holdUntil(0.7); await h.wheel(130); } else { await h.moveTo('[data-testid=budget-list]'); } await h.holdUntil(0.95); } },
    { az: 'Xərclənməmiş qalığı başqa büdcəyə köçürmək olar — «Köçür» düyməsi ilə. Köçürmə hədəf büdcənin tarixçəsində mənbəyə istinad edən dəyişiklik kimi yazılır, yəni pulun haradan gəldiyi sonradan da görünür.',
      do: async (p, l, h) => { const ro = p.locator('[data-testid=budget-list] button:has-text("Köçür")').first(); if (await ro.count()) { await h.hover(ro, 1600); } else { await h.moveTo('[data-testid=budget-list] tbody tr'); } await h.holdUntil(0.95); } },
    { az: 'Yeni büdcə yuxarıdaki formadan yaradılır: ad, kateqoriya, şöbə və dövr. Şöbə boş qalsa, büdcə bütün təşkilata aid olur; konkret şöbə seçiləndə onun xərcləri məhz ora yazılır və şöbə büdcəsi ümumidən üstün olur.',
      do: async (p, l, h) => { await h.scrollTo('h1'); await h.holdUntil(0.25); await h.fill(p.locator('form input').nth(0), 'Marketinq 2026'); await h.holdUntil(0.65); await h.moveTo(p.locator('form select').nth(0)); await h.holdUntil(0.95); } },
    { az: 'Dövr illik, rüblük və ya aylıq ola bilər. Rüblük seçəndə sistem rüb nömrəsini soruşur və tarix aralığını özü hesablayır. Sonra məbləğ və səbəb: səbəb tarixçəyə düşür, ona görə «plan niyə belədir» sualı həmişə cavablı qalır.',
      do: async (p, l, h) => { await p.locator('form select').nth(1).selectOption('QUARTER').catch(() => {}); await h.holdUntil(0.4); await h.fill(p.locator('form input[type=number]').last(), '12000'); await h.holdUntil(0.72); await h.moveTo(p.locator('form button.btn').first()); await h.holdUntil(0.95); } },
    { az: 'Eyni şöbə, kateqoriya və dövrü əhatə edən iki büdcə yaratmaq mümkün deyil: baza özü imtina edir və ekran bunu insan dili ilə deyir. Səbəb sadədir — onda hər xərci hansı planın tutduğu bilinməz olardı.',
      do: async (p, l, h) => { await h.moveTo(p.locator('form input').nth(0)); await h.holdUntil(0.45); await h.moveTo(p.locator('form button.btn').first()); await h.holdUntil(0.95); } },
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
      do: async (p, l, h) => { await h.hover(p.locator('.card').nth(0), 1500); await h.holdUntil(0.5); await h.hover(p.locator('.card').nth(2), 1500); await h.holdUntil(0.95); } },
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
  // Logistics: a read-only board. The pass inserted the order's OWN status beside the
  // shipment's, which is the one thing worth slowing down for here.
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
      do: async (p, l, h) => { const rows = p.locator('.card:has(h3:text-is("Reyestr")) tbody tr'); await h.hover(rows.nth(0).locator('.badge'), 1400); await h.holdUntil(0.55); await h.hover(p.locator('button:text-is("Təsdiqlə")').first(), 1300); await h.holdUntil(0.95); } },
    { az: 'Yoxlama düyməsi KYC işi açır: təchizatçı sənədlərini yükləyir, siz baxıb qərar verirsiniz. Əvvəl bu düymədə yalnız qalxan nişanı vardı və nə etdiyini demirdi — indi yanında sözü də var.',
      do: async (p, l, h) => { const v = p.locator('button:has-text("Yoxlama")').first(); if (await v.count()) { await h.hover(v, 1800); } else { await h.moveTo(p.locator('.card:has(h3:text-is("Reyestr")) tbody tr').first()); } await h.holdUntil(0.95); } },
    { az: 'Reytinq düyməsi çatdırılma qiymətləndirməsini açır: sıfırdan yüzə qədər — vaxtında və tam çatdırılan sifarişlərin payı. Satınalmada bu göstərici OTIF adlanır, və izahda da belə yazılıb.',
      do: async (p, l, h) => { const r = p.locator('button:has-text("Reytinq")').first(); if (await r.count()) { await h.hover(r, 1800); } else { await h.moveTo('table'); } await h.holdUntil(0.95); } },
    { az: 'Rəqəm təkcə bəzək deyil: süni intellekt tövsiyəsi təchizatçının etibarlılığını məhz bu qiymətləndirmələrdən götürür. Yəni bir dəfə qoyulmuş qiymət növbəti tenderin müqayisəsində işləyir.',
      do: async (p, l, h) => { await h.moveTo(p.locator('.card:has(h3:text-is("Reyestr")) tbody tr').first()); await h.holdUntil(0.5); await h.moveTo(p.locator('.card:has(h3:text-is("Reyestr")) tbody tr').last()); await h.holdUntil(0.95); } },
    { az: 'Bloklama isə dağıdıcı əməliyyatdır: bloklanmış təchizatçı bundan sonra heç bir tenderə və sifarişə düşmür. Ona görə o, sətrin sonunda, ayırıcıdan sonra durur — əvvəl «Təsdiqlə» düyməsinin yanında idi, yan-yana.',
      do: async (p, l, h) => { const b = p.locator('button:has-text("Blokla")').first(); if (await b.count()) { await h.hover(b, 1800); } else { await h.moveTo(p.locator('.actions').first()); } await h.holdUntil(0.95); } },
    { az: 'Aşağıdakı cədvəl isə kataloqdur: sistemdəki bütün təchizatçılar. Bu, sizin siyahınız deyil — buradan reyestrə dəvət edirsiniz. Elə buna görə sütunlar da fərqlidir: statusun yerinə kateqoriyalar durur.',
      do: async (p, l, h) => { await h.scrollTo('h3:text-is("Kataloq")'); await h.holdUntil(0.4); await h.moveTo('.card:has(h3:text-is("Kataloq")) .hint'); await h.holdUntil(0.7); await h.moveTo(p.locator('.card:has(h3:text-is("Kataloq")) thead th').nth(2)); await h.holdUntil(0.95); } },
    { az: 'Kateqoriyalar təchizatçının öz profilindən gəlir — nə satdığını özü göstərir. Reyestrdə artıq olan şirkətin yanında dəvət düyməsi görünmür, çünki onu ikinci dəfə dəvət etmək mənasızdır.',
      do: async (p, l, h) => { const inv = p.locator('.card:has(h3:text-is("Kataloq")) button:text-is("Dəvət et")').first(); if (await inv.count()) { await h.hover(inv, 1600); } else { await h.moveTo('.card:has(h3:text-is("Kataloq")) table'); } await h.holdUntil(0.95); } },
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
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.35); await h.moveTo(p.locator('.hint a').first()); await h.holdUntil(0.65); await h.moveTo(p.locator('.hint a').last()); await h.holdUntil(0.95); } },
    { az: 'İstifadəçilər. Cədvəldə e-poçt, ad, rol və şöbə var. Şöbə sütunu sadəcə məlumat deyil: o, həmin adamın yeni sorğularında standart şöbə olur və onun büdcələrə girişini müəyyən edir.',
      do: async (p, l, h) => { await h.moveTo('h3#set-users'); await h.holdUntil(0.4); await h.moveTo(p.locator('.card:has(h3#set-users) thead th').nth(2)); await h.holdUntil(0.7); await h.moveTo(p.locator('.card:has(h3#set-users) thead th').nth(3)); await h.holdUntil(0.95); } },
    { az: 'Rollar beşdir: administrator, təsdiqləyən, istifadəçi, maliyyəçi və təchizatçı. Öz rolunuzu dəyişmək mümkün deyil — sistem bunu açıq imtina ilə deyir. Rol dəyişəndə həmin adamın bütün sessiyaları bağlanır, yəni yeni hüquq dərhal işə düşür.',
      do: async (p, l, h) => { const sel = p.locator('.card:has(h3#set-users) tbody select').first(); if (await sel.count()) { await h.moveTo(sel); } await h.holdUntil(0.55); await h.moveTo(p.locator('.card:has(h3#set-users) form').first()); await h.holdUntil(0.95); } },
    { az: 'Kateqoriya kataloqu. Bu, vahid siyahıdır, və məqsədi birdir: «IT», «it» və «AyTi» üç ayrı kateqoriyaya çevrilməsin. Çünki kateqoriya həm metod siyasətini, həm büdcəni, həm analitikanı idarə edir — üç yerdə birdən dağılır.',
      do: async (p, l, h) => { await h.scrollTo('h3#set-categories'); await h.holdUntil(0.4); await h.moveTo('.card:has(h3#set-categories) .hint'); await h.holdUntil(0.7); await h.moveTo('.card:has(h3#set-categories) table'); await h.holdUntil(0.95); } },
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
      do: async (p, l, h) => { const bands = p.locator('.mp-band'); await h.moveTo(bands.first()); await h.holdUntil(0.4); const n = await bands.count(); await h.moveTo(bands.nth(Math.min(1, n - 1))); await h.holdUntil(0.7); const e = p.locator('.card:has(h3#set-method) button:has-text("Dəyiş")').first(); if (await e.count()) await h.moveTo(e); await h.holdUntil(0.95); } },
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
    { az: 'Beləliklə iş qaydası sadədir: panelə baxırsınız, tapşırıqları bağlayırsınız. Növbəti addım — açıq tenderlərə baxmaq.',
      do: async (p, l, h) => { await h.scrollTo('h1'); await h.holdUntil(0.35); await h.moveTo('[data-testid=sup-kpi]'); await h.holdUntil(0.95); } },
  ]},
  // Supplier market → a real sealed bid on a live tender. The market list gained the
  // procedure column in PR #79: before it, a closed tender, a live auction and a request
  // for information looked identical until the row was opened.
  'sup-market': { role: 'sup', path: '/supplier/market', scenes: [
    { az: 'Açıq tenderlər bölməsi. Burada sifarişçinin sizi dəvət etdiyi prosedurlar və hamıya açıq elan olunanlar bir siyahıdadır. Yəni işi axtarmaq lazım deyil — o özü bu ekranda görünür.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.4); await h.moveTo('table'); await h.holdUntil(0.95); } },
    { az: 'Sütunlar: başlıq, metod, sifarişçi, status, son tarix və ən sonda «Mənim təklifim». Sonuncu sütun dərhal göstərir, harada artıq iştirak edirsiniz, harada isə yox.',
      do: async (p, l, h) => { const th = p.locator('thead th'); await h.moveTo(th.nth(0)); await h.holdUntil(0.25); await h.moveTo(th.nth(2)); await h.holdUntil(0.5); await h.moveTo(th.nth(4)); await h.holdUntil(0.72); await h.moveTo(th.nth(5)); await h.holdUntil(0.95); } },
    { az: 'Metod sütunu bu ekranda ən çox işə yarayandır, çünki prosedurun növü «təklif verməyə dəyərmi» sualını həll edir. Əvvəl bu sütun burada yox idi: qapalı tender, auksion və məlumat sorğusu sətri açana qədər eyni görünürdü.',
      do: async (p, l, h) => { const chips = p.locator('tbody .chip'); await h.hover(chips.first(), 1500); await h.holdUntil(0.6); const n = await chips.count(); await h.hover(chips.nth(Math.min(1, n - 1)), 1300); await h.holdUntil(0.95); } },
    { az: 'Qıfıl — qapalı tender, möhürlü qiymətlər. Qlobus — açıq tender: eyni möhürlü qiymətlər, amma hamı iştirak edə bilər. Şimşək — auksion, orada qiymətlər gizli deyil. Sual işarəsi isə məlumat sorğusudur: qiymət istənilmir, yalnız mətn cavabı.',
      do: async (p, l, h) => { const chips = p.locator('tbody .chip'); const n = await chips.count(); await h.hover(chips.nth(Math.min(2, n - 1)), 1300); await h.holdUntil(0.5); await h.hover(chips.nth(Math.min(3, n - 1)), 1300); await h.holdUntil(0.95); } },
    { az: 'Son tarix qəti şərtdir. Vaxt bitəndən sonra forma bağlanır və gecikmiş təklif sistemə ümumiyyətlə düşmür — bu, bütün iştirakçılar üçün eyni qaydadır və vaxtı server qeyd edir.',
      do: async (p, l, h) => { const r = p.locator('tbody tr'); await h.moveTo(r.nth(0).locator('td').nth(4)); await h.holdUntil(0.45); await h.hover(r.nth(0).locator('td').nth(3).locator('.badge'), 1300); await h.holdUntil(0.95); } },
    { az: 'Təklif vermək üçün noutbuk və monitorlar tenderini açırıq.',
      do: async (p, l, h) => { await h.click('tbody tr:has-text("noutbuk") a', 1800); await p.waitForSelector('h1', { timeout: 15000 }); await h.holdUntil(0.95); } },
    { az: 'Başlığın yanında metod nişanı və status var — siyahıda nə gördünüzsə, kartda da onu. Altda sifarişçi və son tarix. Sonra mövqelər: ad və miqdar. Diqqət edin — sifarişçinin gözlədiyi qiymət burada yazılmayıb. Bu qəsdəndir: rəqəmi göstərmək təklifinizi həmin rəqəmə bağlayardı.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.35); await h.moveTo(p.locator('.card').first()); await h.holdUntil(0.65); await h.scrollTo('.card:has(h3:has-text("Mövqelər"))'); await h.moveTo('.card:has(h3:has-text("Mövqelər")) table'); await h.holdUntil(0.95); } },
    { az: 'Vahid qiyməti hər mövqe üzrə ayrıca daxil edirik. Bütün sətirləri doldurmaq lazımdır: natamam təklif qiymətləndirməyə buraxılmır.',
      do: async (p, l, h) => { const i = p.locator('.card:has(h3:has-text("Mövqelər")) input[step="0.01"]'); await h.fill(i.nth(0), '1690'); await h.holdUntil(0.5); await h.fill(i.nth(1), '385'); await h.holdUntil(0.95); } },
    { az: 'Yekun məbləği sistem özü hesablayır — kalkulyator lazım deyil. Yanında çatdırılma müddəti var: qiymət tək meyar deyil, müddət də qiymətləndirmədə iştirak edir və onun öz çəkisi olur.',
      do: async (p, l, h) => { await h.fill(p.locator('.card:has(h3:has-text("Mövqelər")) input[min="1"]').first(), '10'); await h.holdUntil(0.6); await h.moveTo(p.locator('.card:has(h3:has-text("Mövqelər")) .row div').nth(1)); await h.holdUntil(0.95); } },
    { az: 'İndi ən vacib hissə. Düymənin özündə qıfıl var, altında isə bir sətir: məbləğlər açılışa qədər gizlidir. Yəni açılış anına qədər sifarişçi yalnız sizin iştirak etdiyinizi görür, rəqəmi yox.',
      do: async (p, l, h) => { await h.moveTo('.card:has(h3:has-text("Mövqelər")) .hint'); await h.holdUntil(0.5); await h.moveTo('.card:has(h3:has-text("Mövqelər")) button.btn'); await h.holdUntil(0.95); } },
    { az: 'Göndəririk. Təklif verildikdən sonra onun statusu yuxarıdaki kartda görünür, yanında isə öz məbləğiniz — onu yalnız siz görürsünüz. Sənəd əlavə etmək də olar: texniki vərəqələr, sertifikatlar.',
      do: async (p, l, h) => { await h.click('.card:has(h3:has-text("Mövqelər")) button.btn', 2200); await h.holdUntil(0.6); await h.scrollTo('h1'); await h.moveTo(p.locator('.card').first()); await h.holdUntil(0.95); } },
    { az: 'Son tarixədək fikrinizi dəyişə bilərsiniz: «Geri götür» düyməsi təklifi geri alır, sonra yenisini verirsiniz. Vaxt bitəndən sonra isə heç kim heç nəyi dəyişə bilmir — nə siz, nə sifarişçi. Qapanmış tenderdə öz qiymətiniz yenə görünür, çünki o, sizin sənədinizdir.',
      do: async (p, l, h) => { const w = p.locator('button:has-text("Geri götür")').first(); if (await w.count()) { await h.hover(w, 1600); } else { await h.moveTo(p.locator('.card').first().locator('.badge').first()); } await h.holdUntil(0.95); } },
    { az: 'Suallarınız varsa, aşağıdaki sual-cavab bölməsində yazın. Sifarişçinin cavabını bütün iştirakçılar eyni anda görür — heç kim əlavə məlumat ala bilmir. Bu, bərabər şərtlər qaydasıdır, və qalib seçimi sonradan məhz buna görə müdafiə oluna bilir.',
      do: async (p, l, h) => { await h.scrollTo('h3:has-text("Sual-cavab")'); await h.holdUntil(0.4); await h.moveTo(p.locator('.card').last()); await h.holdUntil(0.95); } },
  ]},
  // Supplier orders: the delivery pipeline. Every icon-only control here gained its word
  // in PR #72 (🚚 Logistika, 🧾 Qaimə, ✎ Dəyişikliklər), and the shipment history stopped
  // printing raw enum codes — so the scenes name buttons instead of describing pictures.
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
    { az: 'Çatdırılmadan sonra «Qaimə» düyməsi işə düşür. Vacib incəlik: qaimə sifarişdən yox, faktiki qəbul edilmiş miqdardan doldurulur. Ona görə də o, sifarişçinin üçtərəfli yoxlamasından adətən ilk dəfədən keçir.',
      do: async (p, l, h) => { const inv = p.locator('button:has-text("Qaimə")').first(); if (await inv.count()) { await h.hover(inv, 1800); } else { await h.moveTo(p.locator('tbody tr').first().locator('.badge')); } await h.holdUntil(0.95); } },
    { az: 'Qəbul ediləsi qalıq yoxdursa, sistem bunu açıq deyir və boş qaimə yaratmır. Beləliklə bir ekranda bütün dövr yığılır: təsdiq, yığım, göndəriş, çatdırılma və qaimə. Növbəti bölmə isə həmin qaimələrin taleyini göstərir.',
      do: async (p, l, h) => { await h.scrollTo('h1'); await h.holdUntil(0.35); await h.moveTo('table'); await h.holdUntil(0.95); } },
  ]},
  // Supplier invoices: the same three-way match, read from the side that gets paid. The
  // status column is the SIXTH cell since the payment-due column was removed.
  'sup-invoices': { role: 'sup', path: '/supplier/invoices', scenes: [
    { az: 'Qaimələr bölməsi. Burada verdiyiniz bütün qaimələr və onların taleyi var. Qaimə verildiyi andan sistem onu iki mənbə ilə tutuşdurur: sifarişlə və sifarişçinin qəbul aktı ilə.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.4); await h.moveTo('table'); await h.holdUntil(0.95); } },
    { az: 'Sütunlar: nömrə, hansı sifariş üzrə, sifarişçi, tarix, məbləğ və status. Statuslar sizin üçün belə oxunur: «Uyğundur» — hər şey yerindədir, qərar gözləyirsiniz. «Təsdiqlənib» — ödəniş növbəsindədir. «Ödənilib» — pul köçürülüb. «Mübahisəli» isə nəsə uyğun gəlməyib deməkdir.',
      do: async (p, l, h) => { const r = p.locator('tbody tr'); await h.hover(r.nth(0).locator('td').nth(5).locator('.badge'), 1300); await h.holdUntil(0.4); await h.hover(r.nth(1).locator('td').nth(5).locator('.badge'), 1200); await h.holdUntil(0.7); await h.hover(r.nth(2).locator('td').nth(5).locator('.badge'), 1200); await h.holdUntil(0.95); } },
    { az: 'Mübahisəli qaiməni açaq — səbəbi gizlətmirlər, siz də eyni cədvəli görürsünüz.',
      do: async (p, l, h) => { await h.click('tbody tr:has-text("INV-2026-0003") a', 1600); await h.scrollTo('.card:has(h3:has-text("INV-2026-0003"))'); await h.holdUntil(0.95); } },
    { az: 'Cədvəldə dörd rəqəm üz-üzə durur: sizin qiymətiniz və sifarişdəki qiymət, sizin miqdarınız və faktiki qəbul edilən miqdar. Burada həm qiymət yüksəkdir, həm də miqdar qəbul ediləndən çoxdur — ona görə sətir keçmir.',
      do: async (p, l, h) => { const t = p.locator('.card:has(h3:has-text("INV-2026-0003")) table tbody tr').first(); await h.moveTo(t.locator('td').nth(0)); await h.holdUntil(0.3); await h.moveTo(t.locator('td').nth(1)); await h.holdUntil(0.52); await h.moveTo(t.locator('td').nth(2)); await h.holdUntil(0.74); await h.moveTo(t.locator('td').nth(3)); await h.holdUntil(0.95); } },
    { az: 'Bu, mübahisə üçün əsas deyil, aydınlıq üçün alətdir: ya qalan malı çatdırırsınız və qəbul rəsmiləşəndən sonra yoxlama özü yenidən işləyir, ya da qaiməni düzgün miqdarla yenidən verirsiniz. Sifarişçi isə onu yazılı əsaslandırma ilə təsdiqləyə də bilər.',
      do: async (p, l, h) => { await h.moveTo('.card:has(h3:has-text("INV-2026-0003")) h3'); await h.holdUntil(0.5); await h.moveTo(p.locator('tbody tr:has-text("INV-2026-0003") td').nth(5)); await h.holdUntil(0.95); } },
    { az: 'Uyğun gələn qaimədə isə hər sətir yaşıl işarə ilə keçir. Yuxarıda məbləğ ƏDV-siz və ƏDV ayrıca göstərilir — dərəcə sifarişin sətrindən götürülür, ona görə sıfır dərəcəli mövqelər düz hesablanır.',
      do: async (p, l, h) => { await h.click('tbody tr:has-text("INV-2026-0003") a', 700); await h.click('tbody tr:has-text("INV-2026-0002") a', 1600); await h.scrollTo('.card:has(h3:has-text("INV-2026-0002"))'); await h.moveTo('.card:has(h3:has-text("INV-2026-0002")) .hint'); await h.holdUntil(0.95); } },
    { az: 'Qaimə verilməyib siyahı boş qalanda, ekran bunu da izah edir: qaimə qəbul edilmiş sifarişdəki düymə ilə göndərilir. Yəni boş siyahı sualsız qalmır.',
      do: async (p, l, h) => { await h.scrollTo('h1'); await h.holdUntil(0.4); await h.moveTo('table'); await h.holdUntil(0.95); } },
    { az: 'Təsdiq və ödəniş sifarişçinin addımlarıdır, amma ikisi də burada görünür. Yəni ödənişin harada dayandığını soruşmaq üçün zəng etmək lazım deyil — status özü deyir.',
      do: async (p, l, h) => { const r = p.locator('tbody tr'); const n = await r.count(); await h.moveTo(r.nth(Math.min(3, n - 1)).locator('td').nth(5)); await h.holdUntil(0.6); await h.moveTo('table'); await h.holdUntil(0.95); } },
  ]},
  // Reverse auction from the supplier's seat. Not reachable from the help bar: the map in
  // apps/web/src/guides.ts keys on the ROUTE, and an auction lives on the same
  // /supplier/events/:id as a sealed tender, so that route plays sup-market. Kept in sync
  // here so the file exists the day the widget learns to pick a guide by the event's own
  // format; until then nothing in the product loads it.
  'sup-auction': { role: 'sup', path: '/supplier/market', scenes: [
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
    for (const role of ['buyer', 'sup']) {
      if (!todo.some((k) => SECTIONS[k].role === role)) continue;
      const ctx = await browser.newContext({
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
      await login(ctx, role === 'buyer' ? 'admin@acme.test' : 'seller@supply-one.test');
      contexts[role] = ctx;
    }

    const produced = [];
    for (const key of todo) {
      const sec = SECTIONS[key];
      const page = await contexts[sec.role].newPage();
      const t0 = Date.now();
      try {
        await page.goto(`${BASE}${sec.path}`);
        await page.waitForSelector('h1', { timeout: 20000 });
        await P(1000);
        await page.screenshot({ path: join(OUT, `${key}.${lang}.png`) }); // clean poster (no cursor)
        await injectCursor(page);
        const offsets = [];
        const LEAD = 650; // narration starts first; the cursor follows so voice never lags behind
        const h = makeHelpers(page);
        for (const scene of sec.scenes) {
          const startMs = Date.now() - t0;        // audio starts at the scene boundary
          offsets.push(startMs);
          await P(LEAD);                          // let the voice begin before the cursor moves
          h.setSceneBudget(scene.sec * 1000);     // anchor holdUntil() to THIS narration
          try { await scene.do?.(page, lang, h); }
          catch (e) { console.log(`  (${key}/${lang}: ${e.message.split('\n')[0]})`); }
          // hold the scene until its narration (plus a small tail) has fully played out
          const remain = startMs + scene.sec * 1000 + 700 - (Date.now() - t0);
          // A scene whose actions outlast their narration leaves dead air. Say so here,
          // by scene number — otherwise it is only found afterwards, as silence in ffmpeg.
          if (remain < -1500) {
            console.log(`  ⏱ ${key}/${lang} сцена ${offsets.length}: действия дольше озвучки на ${Math.round(-remain / 1000)}с`);
          }
          if (remain > 0) await P(remain);
        }
        await P(1200);
        produced.push({ key, video: page.video(), offsets, scenes: sec.scenes.map((s) => ({ audio: s.audio })) });
        console.log(`✓ ${key}.${lang} (${Math.round((Date.now() - t0) / 1000)}s)`);
      } catch (e) {
        console.log(`✗ ${key}.${lang} SKIPPED — ${e.message.split('\n')[0]}`);
      } finally {
        await page.close().catch(() => {});
      }
    }
    for (const c of Object.values(contexts)) await c.close();
    await browser.close();

    // 3) mux voice onto footage at recorded offsets
    for (const { key, video, offsets, scenes } of produced) {
      const src = await video.path();
      const inputs = scenes.map((s) => `-i "${s.audio}"`).join(' ');
      const delays = scenes.map((_, i) => `[${i + 1}:a]adelay=${offsets[i]}:all=1[a${i}]`).join(';');
      const mix = scenes.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${scenes.length}:normalize=0[a]`;
      const out = join(tmp, `${key}.${lang}.final.webm`);
      execSync(`ffmpeg -y -loglevel error -i "${src}" ${inputs} -filter_complex "${delays};${mix}" -map 0:v -map "[a]" -c:v copy -c:a libopus -b:a 64k "${out}"`);
      renameSync(out, join(OUT, `${key}.${lang}.webm`));
      console.log(`🎬 ${key}.${lang}.webm (${dur(join(OUT, `${key}.${lang}.webm`)).toFixed(1)}s)`);
    }
  }
  console.log('\nDone. Rebuild the web container to ship.');
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
