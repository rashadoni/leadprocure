#!/usr/bin/env node
// Produces the narrated section-guide videos in THREE languages (az/ru/en), one file per
// language: apps/web/public/guides/<key>.<lang>.webm (+ <key>.<lang>.png poster).
// For each language the UI is rendered in that language (localStorage lp_lang) AND narrated
// by Gemini native TTS — the video is never time-boxed, each scene is held for exactly its
// narration length (TTS measured first, then adelay+amix over the recording). A visible
// cursor performs the workflow (typing, hovering tooltips, clicking) during narration.
//
// Usage: node scripts/produce-guides.mjs [BASE_URL] [langs=az,ru,en] [keys…]
//   Env (Leadprocure/.env): GEMINI_API_KEY + AZURE_SPEECH_KEY/REGION
//
// TTS is per-language (see ENGINE): az+ru → Gemini, en → Azure (free Jenny, saves Gemini
// quota). Azure's Azerbaijani (Banu) was too weak, which is why az moved to Gemini.

import { createRequire } from 'module';
import { createHash } from 'crypto';
import { execSync } from 'child_process';
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
    const m = line.match(/^(AZURE_[A-Z_]+|GEMINI_API_KEY)=(.*)$/);
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

// ---------------- scenes: {ru,az,en} narration + camera action ----------------
const SECTIONS = {
  'buyer-dashboard': { role: 'buyer', path: '/buyer/dashboard', scenes: [
    { az: 'İdarə paneli — sistemə hər gün buradan başlayırsınız. Ekran iki suala cavab verir: pul harada dayanıb və indi sizdən nə tələb olunur. Yuxarıdakı göstəricilərdən başlayaq.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.4); await h.moveTo(p.locator('.card').nth(0)); await h.holdUntil(0.9); } },
    { az: 'Birinci rəqəm — ümumi xərc. Bura yalnız qəbul edilmiş sifarişlər düşür: nə planlar, nə təsdiq gözləyən sorğular. Yəni bu, artıq reallaşmış puldur.',
      do: async (p, l, h) => { await h.moveTo(p.locator('.card').nth(0)); await h.holdUntil(0.5); await h.moveTo(p.locator('.card').nth(1)); await h.holdUntil(0.92); } },
    { az: 'İkinci — tenderlərdə qənaət. Sistem sorğunun ilkin smetası ilə qalib təklifin məbləğini müqayisə edir. Fərq isə rəqabətin nə qədər pul qazandırdığını göstərir.',
      do: async (p, l, h) => { await h.moveTo(p.locator('.card').nth(1)); await h.holdUntil(0.55); await h.moveTo(p.locator('.card').nth(2)); await h.holdUntil(0.92); } },
    { az: 'Sonra aktiv tenderlər və işdə olan sifarişlər. Bu iki rəqəm yükü göstərir: nə qədər prosedur açıqdır və nə qədər sifariş hələ təchizatçıdadır.',
      do: async (p, l, h) => { await h.moveTo(p.locator('.card').nth(2)); await h.holdUntil(0.45); await h.moveTo(p.locator('.card').nth(3)); await h.holdUntil(0.9); } },
    { az: 'İndi ekranın ən faydalı hissəsi — tapşırıqlar. Sistem bütün sistemi gəzib sizdən qərar gözləyən işləri özü toplayır. Siz heç bir bölməni əl ilə yoxlamırsınız.',
      do: async (p, l, h) => { await h.scrollTo('h3'); await h.holdUntil(0.4); await h.moveTo('table'); await h.holdUntil(0.9); } },
    { az: 'Sətirlərə baxaq. Zərfləri aç — tenderin müddəti bitib, təkliflər açılışı gözləyir. Sifarişi təsdiqlə — kimsə xərc üçün icazə istəyir. Qalibi seç — təkliflər qiymətləndirilib, qərar sizdədir.',
      do: async (p, l, h) => { const r = p.locator('table tbody tr'); await h.moveTo(r.nth(0)); await h.holdUntil(0.35); await h.moveTo(r.nth(1)); await h.holdUntil(0.65); await h.moveTo(r.nth(2)); await h.holdUntil(0.92); } },
    { az: 'Hər tapşırığın yanında obyektin adı və tarixi var, sağda isə ox. Ox sizi düz lazım olan yerə aparır — tenderin kartına, sorğuya və ya sifarişə. Axtarmaq lazım gəlmir.',
      do: async (p, l, h) => { const r = p.locator('table tbody tr').nth(0); await h.moveTo(r); await h.holdUntil(0.45); await h.moveTo(r.locator('a, .btn').last()); await h.holdUntil(0.92); } },
    { az: 'Siyahı özü yenilənir: iş görüləndən sonra sətir yox olur. Yəni boş tapşırıq siyahısı — hər şeyin nəzarətdə olduğunun ən sadə göstəricisidir.',
      do: async (p, l, h) => { await h.wheel(200); await h.holdUntil(0.5); await h.moveTo('table'); await h.holdUntil(0.9); } },
    { az: 'Aşağıda bildirişlər axını var: yeni qaimələr, sifariş statuslarının dəyişməsi, təchizatçı cavabları, büdcə həddinin keçilməsi. Hər bildiriş həm də e-poçtla göndərilir, ona görə sistemi bütün gün açıq saxlamağa ehtiyac yoxdur.',
      do: async (p, l, h) => { await h.wheel(260); await h.holdUntil(0.45); await h.wheel(200); await h.holdUntil(0.9); } },
    { az: 'Və nəhayət, büdcə xəbərdarlığı. Hansısa şöbə planını aşarsa, bu barədə xəbər ilk növbədə burada, ön səhifədə görünür — büdcələr bölməsinə keçidlə birlikdə. Beləliklə aşım gizli qalmır.',
      do: async (p, l, h) => { await h.scrollTo('a[href="/buyer/budgets"]'); await h.holdUntil(0.4); await h.moveTo('a[href="/buyer/budgets"]'); await h.holdUntil(0.75); await h.click('a[href="/buyer/budgets"]'); await h.holdUntil(0.95); } },
  ]},
  'buyer-requests': { role: 'buyer', path: '/buyer/requests', scenes: [
    { az: 'Sifarişlər bölməsi — hər satınalma buradan başlayır. Sifariş daxili tələbatdır: kimsə nəyəsə ehtiyac duyur, onu rəsmiləşdirir, təsdiqdən keçirir. Yalnız bundan sonra pul hərəkət edir.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.45); await h.moveTo('form'); await h.holdUntil(0.9); } },
    { az: 'Yeni sifariş formasından başlayaq. Başlıq — nəyin və nə üçün alındığını bir cümlə ilə izah edir. Təsdiqləyən adam ilk növbədə məhz bunu oxuyur.',
      do: async (p, l, h) => { await h.fill('[data-testid=req-title]', 'Anbar üçün rəflər'); await h.holdUntil(0.9); } },
    { az: 'Kateqoriya — nə alırıq. O, iki şeyə təsir edir: hansı büdcədən pul gedəcək və satınalma metodu nə olacaq. Siyahı parametrlərdəki vahid kataloqdan gəlir, ona görə «IT» və «it» ayrılmır.',
      do: async (p, l, h) => { await h.fill('[data-testid=req-category]', 'OFFICE'); await h.holdUntil(0.9); } },
    { az: 'Şöbə — kim xərcləyir. Boş buraxsanız, sistem sizin öz şöbənizi qoyur. Bu sahə büdcənin şöbələr üzrə bölgüsünün əsasıdır: sifariş məhz buradan öz məsrəf mərkəzinə düşür.',
      do: async (p, l, h) => { await h.moveTo('[data-testid=req-department]'); await h.holdUntil(0.4); await selectByPrefix(p, '[data-testid=req-department]', 'OPS'); await h.holdUntil(0.92); } },
    { az: 'İndi mövqelər. Ad, say və vahid qiymətin smetası. Diqqət: siz ümumi məbləği yazmırsınız — server onu sətirlərdən özü hesablayır, ona görə səhv və ya uydurma cəm mümkün deyil.',
      do: async (p, l, h) => { await h.fill('[data-testid=item-name-0]', 'Metal rəf'); await h.holdUntil(0.4); await h.fill('[data-testid=item-qty-0]', '6'); await h.holdUntil(0.65); await h.fill('[data-testid=item-price-0]', '180'); await h.holdUntil(0.93); } },
    { az: 'Bir neçə mövqe lazımdırsa, sadəcə sətir əlavə edirsiniz. Sifariş qaralama olaraq yaradılır — istənilən vaxt düzəliş etmək olar. Biz indi yaratmırıq, forma yalnız nümayiş üçündür.',
      do: async (p, l, h) => { await h.moveTo('form button.ghost'); await h.holdUntil(0.5); await h.moveTo('form button.btn:not(.ghost)'); await h.holdUntil(0.92); } },
    { az: 'Aşağıda sifarişlərin reyestri. Sütunlarda nömrə, başlıq, kateqoriya və şöbə var — şöbə sütunu sayəsində dərhal görünür ki, hansı xərci hansı bölmə istəyib.',
      do: async (p, l, h) => { await h.scrollTo('table'); await h.holdUntil(0.4); await h.moveTo(p.locator('table tbody tr').nth(0)); await h.holdUntil(0.9); } },
    { az: 'Statuslar belə oxunur: qaralama — hələ redaktə olunur, göndərilib — təsdiq gözləyir, təsdiqlənib — satınalmanı başlatmaq olar. Rədd edilmiş sifariş isə tarixçədə qalır, silinmir.',
      do: async (p, l, h) => { const r = p.locator('table tbody tr'); await h.moveTo(r.nth(0).locator('.badge')); await h.holdUntil(0.4); await h.moveTo(r.nth(1).locator('.badge')); await h.holdUntil(0.7); await h.moveTo(r.nth(2).locator('.badge')); await h.holdUntil(0.93); } },
    { az: 'Təsdiq düyməsi iki mərhələlidir. Birinci klik sifarişin içini açır — mövqelər, məbləğ və ən əsası büdcəyə təsiri: hansı büdcədən nə qədər gedəcək və faiz neçəyə çatacaq. Yəni qərar məlumatsız verilmir.',
      do: async (p, l, h) => { await h.scrollTo('table'); await h.holdUntil(0.35); await h.moveTo(p.locator('tbody .btn').first()); await h.holdUntil(0.92); } },
    { az: 'Təsdiqlənmiş sifarişdən sonra prosedur seçilir: qapalı tender, texniki təkliflə tender, məlumat sorğusu və ya revers-auksion. Kiçik məbləğləri siyasət avtomatik birbaşa sifarişə göndərir — metodu istifadəçi seçmir, qaydalar seçir.',
      do: async (p, l, h) => { await h.wheel(220); await h.holdUntil(0.4); await h.moveTo('.hint'); await h.holdUntil(0.92); } },
    { az: 'Və sonuncu: təsdiqlənmiş, amma artıq lazım olmayan sifarişi ləğv etmək olar. Bu vacibdir, çünki ləğv büdcədəki öhdəliyi azad edir — pul boş yerə bloklanmış qalmır.',
      do: async (p, l, h) => { await h.moveTo(p.locator('tbody .btn').first()); await h.holdUntil(0.5); await h.wheel(180); await h.holdUntil(0.92); } },
  ]},
  // Tenders: the list, then a real tender's card — the sealed-bid rules are the point, and
  // they only make sense on a live procedure.
  'buyer-events': { role: 'buyer', path: '/buyer/events', scenes: [
    { az: 'Tenderlər bölməsi. Təsdiqlənmiş sorğudan başlayan hər satınalma proseduru buradadır: qapalı tender, texniki təklifli tender, məlumat sorğusu və revers-auksion. Siyahıdan başlayaq.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.4); await h.moveTo('table'); await h.holdUntil(0.7); await h.moveTo(p.locator('tbody tr').first()); await h.holdUntil(0.95); } },
    { az: 'Prosedurun növü nişanla göstərilir. Kilid — qapalı tender: təchizatçılar möhürlü qiymət verir və məbləğlər açılışa qədər heç kimə görünmür. Şimşək — revers-auksion: qiymət real vaxtda aşağı düşür.',
      do: async (p, l, h) => { await h.hover(p.locator('tbody .chip').first(), 900); await h.holdUntil(0.5); await h.hover(p.locator('tbody .chip').nth(1), 900); await h.holdUntil(0.95); } },
    { az: 'Status prosedurun harada olduğunu deyir: təkliflər qəbul olunur, qəbul bağlanıb və açılış gözlənilir, qiymətləndirmə gedir, yaxud qalib artıq seçilib. Sağdakı sütun neçə təklif gəldiyini göstərir — məbləğləri yox, sayı.',
      do: async (p, l, h) => { const rows = p.locator('tbody tr'); await h.hover(rows.nth(0).locator('.badge'), 800); await h.holdUntil(0.45); await h.moveTo(rows.nth(1).locator('.badge')); await h.holdUntil(0.75); await h.moveTo(rows.nth(2)); await h.holdUntil(0.95); } },
    { az: 'Konkret tenderi açaq — bütün iş orada gedir.',
      do: async (p, l, h) => { await h.moveTo(p.locator('tbody a').first()); await h.holdUntil(0.4); await h.click(p.locator('tbody a').first()); await h.holdUntil(0.95); } },
    { az: 'Yuxarıda tenderin adı, növü və statusu. Son tarixi server nəzarət edir: ondan sonra gələn təklif gec sayılır və iştirak etmir. Bu, mübahisə mövzusu deyil — vaxtı sistem qeyd edir, insan yox.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.4); await h.moveTo(p.locator('.badge').first()); await h.holdUntil(0.7); await h.hover(p.locator('.badge').first(), 800); await h.holdUntil(0.95); } },
    { az: 'Mövqelər sorğudan götürülmüş snapshotdur: ad, say və ilkin qiymət smetası. Tender başlayandan sonra bu siyahı dəyişmir — hamı eyni şərtlərə təklif verir.',
      do: async (p, l, h) => { await h.scrollTo('h3'); await h.holdUntil(0.35); await h.moveTo(p.locator('table').first()); await h.holdUntil(0.7); await h.moveTo(p.locator('tbody tr').first()); await h.holdUntil(0.95); } },
    { az: 'Lotlar mövqeləri qruplaşdırır. Bu, praktik şeydir: bir lotu bir təchizatçıya, digərini başqasına vermək olar — məsələn, serverləri biri, quraşdırmanı digəri.',
      do: async (p, l, h) => { await h.moveTo(p.locator('tbody tr').nth(1)); await h.holdUntil(0.4); await h.wheel(150); await h.holdUntil(0.7); await h.moveTo(p.locator('table').first()); await h.holdUntil(0.95); } },
    { az: 'Aşağıda təkliflər. Ən vacib qayda budur: açılışa qədər sifarişçi məbləğləri görmür — yalnız kimin iştirak etdiyini. Qiymətlər şifrələnmiş saxlanılır və açılış mərasimindən əvvəl açılmır.',
      do: async (p, l, h) => { await h.wheel(220); await h.holdUntil(0.35); await h.moveTo(p.locator('table').last()); await h.holdUntil(0.7); await h.moveTo(p.locator('table').last().locator('tbody tr').first()); await h.holdUntil(0.95); } },
    { az: 'Açılışdan sonra məbləğlər, çatdırılma müddətləri və qiymətləndirmə görünür. Qalib seçimi əsaslandırma tələb edir, əgər ən yaxşı təklif seçilmirsə və ya təklif tək idisə — qərar həmişə izah olunur.',
      do: async (p, l, h) => { await h.moveTo(p.locator('table').last().locator('tbody tr').last()); await h.holdUntil(0.4); await h.wheel(160); await h.holdUntil(0.7); await h.moveTo(p.locator('.badge').last()); await h.holdUntil(0.95); } },
    { az: 'Sual-cavab bloku bərabər məlumat prinsipini qoruyur: bir təchizatçının sualına verilən cavabı hamı görür. Beləliklə heç kim gizli izahat almır.',
      do: async (p, l, h) => { await h.wheel(240); await h.holdUntil(0.4); await h.moveTo(p.locator('h3').last()); await h.holdUntil(0.7); await h.wheel(120); await h.holdUntil(0.95); } },
    { az: 'Qalib seçiləndən sonra tenderdən müqavilə yaranır, müqavilədən isə sifariş. Yəni zəncir qırılmır: sorğu, tender, müqavilə, sifariş, qəbul və qaimə — hər addım əvvəlkinə bağlıdır.',
      do: async (p, l, h) => { await h.wheel(-300); await h.holdUntil(0.35); await h.moveTo('h1'); await h.holdUntil(0.7); await h.wheel(-200); await h.holdUntil(0.95); } },
    { az: 'Və bütün prosedur audit jurnalına yazılır: kim dərc etdi, kim açdı, kim qiymətləndirdi, kim qalibi seçdi. Bu, tender sisteminin əsas dəyəridir — nəticəni sonradan izah etmək mümkündür.',
      do: async (p, l, h) => { await h.moveTo(p.locator('.badge').first()); await h.holdUntil(0.4); await h.moveTo('table'); await h.holdUntil(0.7); await h.moveTo('h1'); await h.holdUntil(0.95); } },
  ]},
  'buyer-contracts': { role: 'buyer', path: '/buyer/contracts', scenes: [
    { az: 'Müqavilələr bölməsi. Müqavilə tenderin nəticəsindən doğulur: qalib seçiləndən sonra sistem qalib təklifin şərtlərini müqaviləyə köçürür. Yəni buradakı rəqəmlər əl ilə yazılmır, təklifdən gəlir.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.45); await h.moveTo(p.locator('.card').nth(0).locator('table')); await h.holdUntil(0.9); } },
    { az: 'Sütunlara baxaq: müqavilə nömrəsi, hansı tenderdən gəldiyi, təchizatçı, qüvvədə olma müddəti və ümumi məbləğ. Bu məbləğ müqavilənin tavanıdır.',
      do: async (p, l, h) => { const r = p.locator('.card').nth(0).locator('tbody tr').first(); await h.moveTo(r.locator('td').nth(0)); await h.holdUntil(0.35); await h.moveTo(r.locator('td').nth(2)); await h.holdUntil(0.65); await h.moveTo(r.locator('td').nth(4)); await h.holdUntil(0.93); } },
    { az: 'İstifadə olunub sütunu isə tavana nə qədər yaxınlaşdığınızı göstərir. Çərçivə müqaviləsi bir neçə sifarişə bölünə bilər, ona görə sistem cəmi izləyir və tavanı keçəndə xəbərdarlıq edir — amma bloklamır, çünki bu, qanuni haldır.',
      do: async (p, l, h) => { const r = p.locator('.card').nth(0).locator('tbody tr').first(); await h.moveTo(r.locator('td').last()); await h.holdUntil(0.5); await h.moveTo(r.locator('.badge')); await h.holdUntil(0.93); } },
    { az: 'Status vacibdir. Yalnız aktiv müqavilə sifariş və kataloq buraxa bilir. Qaralama müqavilə isə hələ heç nəyə icazə vermir — əvvəlcə onu aktivləşdirmək lazımdır.',
      do: async (p, l, h) => { await h.moveTo(p.locator('.card').nth(0).locator('.badge').first()); await h.holdUntil(0.5); await h.moveTo(p.locator('button:has-text("PO")').first()); await h.holdUntil(0.93); } },
    { az: 'Sifariş yarat düyməsi müqavilədən konkret sifariş çıxarır: mövqelər və qiymətlər müqavilədən götürülür, siz yalnız təsdiq edirsiniz. Biz indi yaratmırıq — sadəcə göstəririk.',
      do: async (p, l, h) => { await h.moveTo(p.locator('button:has-text("PO")').first()); await h.holdUntil(0.55); await h.scrollTo(p.locator('.card').nth(1)); await h.holdUntil(0.93); } },
    { az: 'Aşağıda sifarişlər bölməsi. Hər sifarişin öz həyat dövrü var: verilib, təchizatçı təsdiqləyib, qablaşdırılıb, göndərilib, çatdırılıb və nəhayət qəbul edilib.',
      do: async (p, l, h) => { const rows = p.locator('.card').nth(1).locator('tbody tr'); await h.moveTo(rows.nth(0)); await h.holdUntil(0.4); await h.moveTo(rows.nth(0).locator('.badge')); await h.holdUntil(0.9); } },
    { az: 'Statusu təchizatçı öz tərəfindən dəyişir, siz isə real vaxtda görürsünüz. Ən vacib addım sonuncudur: qəbul. Məhz qəbul edilmiş sifariş analitikada xərc kimi sayılır.',
      do: async (p, l, h) => { const rows = p.locator('.card').nth(1).locator('tbody tr'); await h.moveTo(rows.nth(1).locator('.badge')); await h.holdUntil(0.45); await h.moveTo(rows.last().locator('.badge')); await h.holdUntil(0.92); } },
    { az: 'Sifarişin şərtləri dəyişməlidirsə, dəyişiklik təklifi göndərilir: say və ya qiymət. Bu, birtərəfli düzəliş deyil — təchizatçı razılıq verməlidir, yalnız ondan sonra sifarişin məbləği yenidən hesablanır.',
      do: async (p, l, h) => { await h.moveTo(p.locator('.card').nth(1).locator('button[data-tip]').first()); await h.holdUntil(0.5); await h.wheel(200); await h.holdUntil(0.92); } },
    { az: 'Köhnə və yeni dəyər tarixçədə saxlanılır, ona görə sifariş dəyişsə də, nəyin nəyə çevrildiyi həmişə görünür. Bu, mübahisələrdə ən faydalı şeydir.',
      do: async (p, l, h) => { await h.wheel(220); await h.holdUntil(0.5); await h.moveTo('table'); await h.holdUntil(0.92); } },
    { az: 'Beləliklə zəncir tamamlanır: sorğu, tender, müqavilə, sifariş, qəbul və qaimə. Hər addım əvvəlkinə bağlıdır, ona görə istənilən xərci geriyə — konkret sorğuya qədər izləmək olar.',
      do: async (p, l, h) => { await h.wheel(-350); await h.holdUntil(0.45); await h.moveTo(p.locator('.card').nth(0).locator('table')); await h.holdUntil(0.92); } },
  ]},
  // Invoices: the last gate before money leaves the company. The stand deliberately carries
  // all four outcomes at once (matched, disputed, approved, paid) — a happy path alone would
  // hide the only thing finance cares about here.
  'buyer-invoices': { role: 'buyer', path: '/buyer/invoices', scenes: [
    { az: 'Qaimələr bölməsi. Bu, pul şirkətdən çıxmazdan əvvəlki son yoxlama nöqtəsidir. Təchizatçı sifariş üzrə qaimə verir, sistem isə onu dərhal üç mənbə ilə tutuşdurur: nə sifariş olunub, faktiki nə qəbul edilib və qaimədə nə yazılıb.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.4); await h.moveTo('table'); await h.holdUntil(0.95); } },
    { az: 'Statuslar sütununa baxın — burada dörd hal var. «Uyğundur» qərar gözləyir. «Mübahisəli» yoxlamadan keçməyib. «Təsdiqlənib» ödəniş gözləyir. «Ödənilib» isə artıq bağlanmış xərcdir.',
      do: async (p, l, h) => { const r = p.locator('table tbody tr'); await h.moveTo(r.nth(0).locator('td').nth(6)); await h.holdUntil(0.3); await h.moveTo(r.nth(1).locator('td').nth(6)); await h.holdUntil(0.55); await h.moveTo(r.nth(2).locator('td').nth(6)); await h.holdUntil(0.78); await h.moveTo(r.nth(3).locator('td').nth(6)); await h.holdUntil(0.95); } },
    { az: 'Uyğun gələn qaimədən başlayaq. Nömrəyə klikləyirik və aşağıda təfərrüat açılır: məbləğ ƏDV-siz və ƏDV ayrıca. ƏDV dərəcəsi sifarişin hər sətrindən götürülür — düz on səkkiz faiz kimi yox, çünki sıfır dərəcəli mövqelər də olur.',
      do: async (p, l, h) => { await h.click('table tbody tr:has-text("INV-2026-0002") a'); await h.holdUntil(0.5); await h.scrollTo('.card:has(h3:has-text("INV-2026-0002"))'); await h.moveTo('.card:has(h3:has-text("INV-2026-0002")) .hint'); await h.holdUntil(0.95); } },
    { az: 'Aşağıdakı cədvəl yoxlamanın özüdür. Solda qaimədəki qiymət və yanında sifarişdəki qiymət. Sonra qaimədəki miqdar və faktiki qəbul edilən miqdar. Sağdakı işarə isə sətrin keçib-keçmədiyini göstərir.',
      do: async (p, l, h) => { const t = p.locator('.card:has(h3:has-text("INV-2026-0002")) table'); await h.moveTo(t.locator('th').nth(0)); await h.holdUntil(0.3); await h.moveTo(t.locator('th').nth(1)); await h.holdUntil(0.5); await h.moveTo(t.locator('th').nth(3)); await h.holdUntil(0.72); await h.moveTo(t.locator('tbody tr').first()); await h.holdUntil(0.95); } },
    { az: 'İndi mübahisəli qaiməyə baxaq. Bağlayırıq və növbətisini açırıq — başlıqdakı işarə dərhal xəbərdarlığa dəyişir.',
      do: async (p, l, h) => { await h.click('table tbody tr:has-text("INV-2026-0002") a'); await h.holdUntil(0.3); await h.click('table tbody tr:has-text("INV-2026-0003") a'); await h.holdUntil(0.6); await h.scrollTo('.card:has(h3:has-text("INV-2026-0003"))'); await h.moveTo('.card:has(h3:has-text("INV-2026-0003")) h3'); await h.holdUntil(0.95); } },
    { az: 'Səbəb bir sətirdə görünür. Təchizatçı səkkiz ədəd yazıb, halbuki qəbul aktında beş ədəd var. Üstəlik qiymət də sifarişdəkindən yüksəkdir. İki müstəqil yoxlama, ikisi də keçməyib — və bir sətir kifayətdir ki, bütün qaimə mübahisəli olsun.',
      do: async (p, l, h) => { const t = p.locator('.card:has(h3:has-text("INV-2026-0003")) table tbody tr').first(); await h.moveTo(t.locator('td').nth(2)); await h.holdUntil(0.3); await h.moveTo(t.locator('td').nth(3)); await h.holdUntil(0.55); await h.moveTo(t.locator('td').nth(0)); await h.holdUntil(0.75); await h.moveTo(t.locator('td').nth(1)); await h.holdUntil(0.95); } },
    { az: 'Vacib olan budur: mübahisəli qaimə əbədi bloklanmır. Onu təsdiqləmək olar, amma yalnız yazılı əsaslandırma ilə — sistem səbəbi soruşur və onu dəyişilməz jurnala yazır. Yəni istisna qadağan deyil, sadəcə anonim ola bilmir.',
      do: async (p, l, h) => { await h.scrollTo('table tbody tr:has-text("INV-2026-0003")'); await h.holdUntil(0.3); await h.hover(p.locator('table tbody tr:has-text("INV-2026-0003") button.btn').first(), 1500); await h.holdUntil(0.7); await h.hover(p.locator('table tbody tr:has-text("INV-2026-0003") button.btn').nth(1), 1200); await h.holdUntil(0.95); } },
    { az: 'Çox vaxt isə heç nə etmək lazım deyil. Yoxlama canlıdır: təchizatçı malı çatmamış qaimə veribsə, qəbulu rəsmiləşdirən kimi sistem yoxlamanı özü yenidən aparır və qaimə bir klik olmadan uyğun statusuna keçir.',
      do: async (p, l, h) => { await h.moveTo(p.locator('table tbody tr:has-text("INV-2026-0003") td').nth(6)); await h.holdUntil(0.5); await h.moveTo(p.locator('table tbody tr:has-text("INV-2026-0002") td').nth(6)); await h.holdUntil(0.95); } },
    { az: 'Təsdiq və ödəniş ayrı addımlardır. Təsdiqlənmiş qaimədə artıq ödəmə düyməsi görünür — yəni «sənəd düzgündür» qərarı ilə «pulu köçürdük» qeydi bir-birinə qarışmır.',
      do: async (p, l, h) => { await h.moveTo(p.locator('table tbody tr:has-text("INV-2026-0004") td').nth(6)); await h.holdUntil(0.4); await h.hover(p.locator('table tbody tr:has-text("INV-2026-0004") button.btn').first(), 1500); await h.holdUntil(0.95); } },
    { az: 'Ödənilmiş qaimə isə büdcədə «fakt» sütununa düşür və eyni məbləği öhdəlikdən çıxarır. Beləliklə eyni pul iki dəfə sayılmır, və büdcə bölməsindəki rəqəm həmişə buradakı sənədlərdən yığılır.',
      do: async (p, l, h) => { await h.moveTo(p.locator('table tbody tr:has-text("INV-2026-0001") td').nth(5)); await h.holdUntil(0.45); await h.moveTo(p.locator('table tbody tr:has-text("INV-2026-0001") td').nth(6)); await h.holdUntil(0.95); } },
    { az: 'Bütün qaimələri mühasibat üçün bir fayla çıxarmaq olar — bu, Parametrlər bölməsindəki inteqrasiyalar kartındadır. Sistem məlumatı özündə saxlamır.',
      do: async (p, l, h) => { await h.moveTo('table'); await h.holdUntil(0.5); await h.moveTo('h1'); await h.holdUntil(0.95); } },
  ]},
  'buyer-catalogs': { role: 'buyer', path: '/buyer/catalogs', scenes: [
    { az: 'Kataloqlar bölməsi. Kataloq — təchizatçı ilə razılaşdırılmış qiymət cədvəlidir. Təkrarlanan xırda alışlar üçün hər dəfə tender keçirmək mənasızdır, ona görə qiymətlər bir dəfə razılaşdırılır və sonra sadəcə sifariş verilir.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.45); await h.moveTo('table'); await h.holdUntil(0.9); } },
    { az: 'Cədvəldə kataloqun adı, təchizatçı, status və mövqe sayı var. Kataloq müqavilədən yaradıla bilər — onda qiymətlər qalib təklifdən avtomatik köçürülür.',
      do: async (p, l, h) => { const r = p.locator('tbody tr').first(); await h.moveTo(r.locator('td').nth(0)); await h.holdUntil(0.4); await h.moveTo(r.locator('td').nth(1)); await h.holdUntil(0.7); await h.moveTo(r.locator('.badge')); await h.holdUntil(0.93); } },
    { az: 'Status yalnız aktiv olanda sifariş vermək mümkündür. Qaralama kataloq hazırlıq mərhələsidir: mövqeləri əlavə edirsiniz, qiymətləri yoxlayırsınız, sonra aktivləşdirirsiniz.',
      do: async (p, l, h) => { await h.moveTo(p.locator('.badge').first()); await h.holdUntil(0.55); await h.moveTo(p.locator('tbody tr a').first()); await h.holdUntil(0.92); } },
    { az: 'Adına klikləyəndə kataloqun içi açılır. Gəlin baxaq.',
      do: async (p, l, h) => { await h.click(p.locator('tbody tr a').first()); await h.holdUntil(0.9); } },
    { az: 'Burada mövqelər var: ad, minimum sifariş həcmi və razılaşdırılmış vahid qiymət. Minimum həcm təchizatçının şərtidir — ondan az sifariş sistem qəbul etmir.',
      do: async (p, l, h) => { await p.waitForSelector('input[type=number], table >> nth=1', { timeout: 8000 }).catch(() => {}); await h.scrollTo(p.locator('table').last()); await h.holdUntil(0.3); await h.moveTo(p.locator('table').last().locator('tbody tr').first()); await h.holdUntil(0.6); await h.moveTo(p.locator('table').last().locator('tbody tr').last()); await h.holdUntil(0.85); await h.moveTo('h1'); } },
    { az: 'Sağda say sahəsi var. Lazım olan miqdarı yazırsınız — sistem qiyməti özü vurur. Qiyməti dəyişmək olmur, çünki o, razılaşdırılıb.',
      do: async (p, l, h) => { const inp = p.locator('input[type=number]').first(); if (await inp.count()) { await h.fill(inp, '5'); } else { await h.moveTo(p.locator('table').last()); } await h.holdUntil(0.5); await h.moveTo(p.locator('tbody tr').first()); await h.holdUntil(0.85); await h.moveTo('h1'); } },
    { az: 'Sifariş verməzdən əvvəl şöbəni seçirsiniz. Bu vacibdir: kataloq sifarişinin arxasında sorğu yoxdur, ona görə şöbəni yalnız burada göstərmək olar. Boş buraxsanız, sistem sizin öz şöbənizi qoyur.',
      do: async (p, l, h) => { const sel = p.locator('select').last(); if (await sel.count()) { await h.moveTo(sel); } await h.holdUntil(0.4); await h.moveTo(p.locator('tbody tr a').first()); await h.holdUntil(0.75); if (await sel.count()) await h.moveTo(sel); await h.holdUntil(0.9); await h.moveTo('h1'); } },
    { az: 'Sifariş düyməsi kataloqdan birbaşa sifariş yaradır — tendersiz, müqavilə danışıqlarısız. Bu, kataloqun bütün mənasıdır: iki klik və sifariş hazırdır. Biz onu indi basmırıq.',
      do: async (p, l, h) => { const b = p.locator('button:has-text("📦")').first(); if (await b.count()) { await h.hover(b, 900); } else { await h.moveTo(p.locator('.badge').first()); } await h.holdUntil(0.55); await h.moveTo(p.locator('tbody tr').first()); await h.holdUntil(0.85); await h.moveTo('h1'); } },
    { az: 'Belə sifariş də büdcədən keçir. Kateqoriyası olmadığına görə onu yalnız kateqoriyasız büdcə — şöbə və ya bütün təşkilat səviyyəsindəki büdcə tuta bilər. Şöbə göstərilməyibsə, xərc «büdcədən kənar» hesabatına düşür.',
      do: async (p, l, h) => { await h.moveTo(p.locator('tbody tr a').first()); await h.holdUntil(0.35); await h.click(p.locator('tbody tr a').first()); await h.holdUntil(0.7); await h.click(p.locator('tbody tr a').first()); await h.holdUntil(0.9); await h.moveTo('h1'); } },
    { az: 'Yekunda: kataloq təkrarlanan alışları prosedurdan azad edir, amma nəzarəti saxlayır — qiymət razılaşdırılıb, minimum həcm qorunur, xərc isə düzgün büdcəyə yazılır.',
      do: async (p, l, h) => { await h.moveTo('table'); await h.holdUntil(0.35); await h.moveTo(p.locator('.badge').first()); await h.holdUntil(0.7); await h.moveTo('h1'); await h.holdUntil(0.9); await h.moveTo('table'); } },
  ]},
  // Budgets: the section finance runs the company from. Every scene performs the thing it
  // is talking about, and the beats are fractions of the narration (holdUntil), so the
  // cursor never runs ahead of the voice or freezes waiting for it.
  'buyer-budgets': { role: 'buyer', path: '/buyer/budgets', scenes: [
    { az: 'Büdcələr bölməsi. Burada şirkətin xərc planı yaşayır: hansı şöbənin nə qədər pulu var, nə qədəri öhdəliyə gedib, nə qədəri real xərclənib və dövrün sonunda nə gözlənilir. Şöbələr üzrə yekun cədvəlindən başlayaq.',
      do: async (p, l, h) => { await h.scrollTo('h3:text-is("Şöbələr üzrə yekun")'); await h.holdUntil(0.4); await h.moveTo('.card:has(h3:text-is("Şöbələr üzrə yekun")) table'); await h.holdUntil(0.75); await h.moveTo(p.locator('.card:has(h3:text-is("Şöbələr üzrə yekun")) tbody tr').first()); await h.holdUntil(0.95); } },
    { az: 'Öhdəlik — təsdiqlənmiş, amma hələ sifariş verilməmiş sorğulardır: pul ayrılıb, hələ xərclənməyib. Faktiki isə artıq verilmiş sifarişlərdir. Sistem eyni xərci iki dəfə saymır: sifariş veriləndə məbləğ öhdəlikdən faktikiyə keçir.',
      do: async (p, l, h) => { const r = p.locator('.card:has(h3:text-is("Şöbələr üzrə yekun")) tbody tr').nth(1); await h.moveTo(r.locator('td').nth(2)); await h.holdUntil(0.45); await h.moveTo(r.locator('td').nth(3)); await h.holdUntil(0.8); await h.moveTo(r.locator('td').nth(4)); await h.holdUntil(0.95); } },
    { az: 'Proqnoz sütunu ən çox soruşulan suala cavab verir: bu templə dövrün sonunda nə olacaq. Rəqəm qırmızıdırsa, plan aşılacaq, yanında isə aşımın məbləği yazılır. Səksən faiz mayda və səksən faiz noyabrda tamam fərqli şeylərdir.',
      do: async (p, l, h) => { const rows = p.locator('.card:has(h3:text-is("Şöbələr üzrə yekun")) tbody tr'); await h.moveTo(rows.nth(0).locator('td').nth(6)); await h.holdUntil(0.5); await h.moveTo(rows.nth(1).locator('td').nth(6)); await h.holdUntil(0.95); } },
    { az: 'İndi ən vacib imkan: hər rəqəmin arxasına baxmaq olar. Öhdəlik məbləğinə klikləyirik və sistem göstərir, məhz hansı sorğulardan ibarətdir. Maliyyəçinin istənilən cəm haqqında ilk sualı budur: nədən yığılıb.',
      do: async (p, l, h) => { await h.scrollTo('table .linklike'); await h.holdUntil(0.25); const cell = await firstNonZero(p, 'table .linklike'); await h.click(cell); await h.holdUntil(0.65); await h.wheel(160); await h.holdUntil(0.95); } },
    { az: 'Siyahıda sənədin nömrəsi, adı, kateqoriyası, şöbəsi və məbləği var. Bu siyahı həmişə yuxarıdakı rəqəmlə üst-üstə düşür, çünki eyni qayda ilə hesablanır — cədvəl ayrıca, rəqəm ayrıca yaşamır.',
      do: async (p, l, h) => { const inner = p.locator('table table tbody tr'); if (await inner.count()) { await h.moveTo(inner.first()); await h.holdUntil(0.4); await h.moveTo(inner.last()); } else { await h.wheel(120); } await h.holdUntil(0.75); await h.wheel(-120); await h.holdUntil(0.95); } },
    { az: 'Hər büdcənin öz statusu var. Qaralama hazırlanır və hələ pul saxlamır. Təsdiq gözləyən redaktə üçün bağlıdır. Qüvvədə olandan xərc silinir. Bağlanmış dövr isə artıq dəyişmir.',
      do: async (p, l, h) => { await h.scrollTo('tbody .badge'); await h.holdUntil(0.35); await h.moveTo(p.locator('tbody .badge').first()); await h.holdUntil(0.65); await h.hover(p.locator('tbody .badge').first(), 900); await h.holdUntil(0.95); } },
    { az: 'Bu, adi cədvəl sətri deyil — büdcə sənəddir. Qaralamanı redaktə edib təsdiqə göndərirsiniz, başqa bir adam onu təsdiqləyir. Öz göndərdiyini təsdiqləmək olmaz: bu, sorğularda olduğu kimi dörd göz qaydasıdır.',
      do: async (p, l, h) => { await h.moveTo(p.locator('tbody button[data-tip]').first()); await h.holdUntil(0.4); await h.hover(p.locator('tbody button[data-tip]').first(), 900); await h.holdUntil(0.75); await h.moveTo(p.locator('tbody button[data-tip]').nth(1)); await h.holdUntil(0.95); } },
    { az: 'Qüvvədə olan büdcənin adı, şöbəsi və dövrü artıq dəyişmir — bunlar təsdiqlənmiş şərtlərdir. Yalnız məbləğ düzəlir, özü də səbəb yazmadan yox. Saat düyməsi bütün düzəlişlərin tarixçəsini açır.',
      do: async (p, l, h) => { await h.moveTo('button[data-tip]:has-text("🕘")'); await h.holdUntil(0.3); await h.click('button[data-tip]:has-text("🕘")'); await h.holdUntil(0.7); await h.wheel(140); await h.holdUntil(0.95); } },
    { az: 'Yeni büdcə formadan yaradılır: ad, kateqoriya, şöbə və dövr. Şöbə boş qalsa, büdcə bütün təşkilata aid olur; konkret şöbə seçiləndə onun xərcləri məhz ora yazılır və şöbə büdcəsi ümumidən üstün olur.',
      do: async (p, l, h) => { await h.wheel(-500); await h.holdUntil(0.25); await h.fill(p.locator('form input').nth(0), 'Marketinq 2026'); await h.holdUntil(0.6); await selectByPrefix(p, 'form select', 'IT'); await h.holdUntil(0.95); } },
    { az: 'Dövr illik, rüblük və ya aylıq ola bilər. Rüblük seçirik — sistem rüb nömrəsini soruşur və tarix aralığını özü hesablayır. Sonra məbləğ və səbəb: səbəb tarixçəyə düşür, ona görə «plan niyə belədir» sualı həmişə cavablı qalır.',
      do: async (p, l, h) => { await p.locator('form select').nth(1).selectOption('QUARTER').catch(() => {}); await h.holdUntil(0.4); await h.fill(p.locator('form input').nth(2), '12000'); await h.holdUntil(0.7); await h.fill(p.locator('form input').nth(3), 'rüblük plan'); await h.holdUntil(0.95); } },
    { az: 'Yuxarıda büdcə hədləri bir sətirlə görünür: xəbərdarlıq faizi və blok faizi. Bunlar bütün təşkilat üçün qaydadır, ona görə özləri parametrlərdə redaktə olunur — burada isə sadəcə hansı qaydanın işlədiyi yazılır.',
      do: async (p, l, h) => { await h.wheel(-300); await h.holdUntil(0.35); await h.moveTo('.hint a'); await h.holdUntil(0.7); await h.hover('.hint a', 800); await h.holdUntil(0.95); } },
    { az: 'Ən aşağıda süzgəclər və ixrac: dövr növü, il, şöbə və CSV düyməsi. İxrac ekranda gördüyünüz seçimi olduğu kimi fayla yazır — plan, öhdəlik, faktiki və qalıq sütunları ilə.',
      do: async (p, l, h) => { await h.scrollTo('button:has-text("CSV")'); await h.holdUntil(0.35); await h.moveTo(p.locator('select').last()); await h.holdUntil(0.7); await h.moveTo('button:has-text("CSV")'); await h.holdUntil(0.95); } },
  ]},
  'buyer-analytics': { role: 'buyer', path: '/buyer/analytics', scenes: [
    { az: 'Analitika bölməsi. Burada pulun hara getdiyi görünür: aylar üzrə xərc, plan ilə müqayisə, büdcənin mənimsənilmə tempi, şöbələr, kateqoriyalar və təchizatçılar. Yuxarıdakı dörd yekundan başlayaq.',
      do: async (p, l, h) => { await p.waitForSelector('.chart-bar', { timeout: 15000 }); await h.moveTo(p.locator('.card').nth(0)); await h.holdUntil(0.45); await h.moveTo(p.locator('.card').nth(1)); await h.holdUntil(0.75); await h.moveTo(p.locator('.card').nth(2)); await h.holdUntil(0.95); } },
    { az: 'Diqqət edin: xərc ƏDV-siz, qaimələr isə ƏDV daxil göstərilir. Ona görə ödənilmiş məbləğ bəzən xərcdən böyük görünə bilər — bu, səhv deyil, sadəcə fərqli baza. Qənaət isə yalnız tenderlər üzrə hesablanır.',
      do: async (p, l, h) => { await h.moveTo(p.locator('.card').nth(2)); await h.holdUntil(0.4); await h.moveTo(p.locator('.card').nth(3)); await h.holdUntil(0.7); await h.moveTo(p.locator('.card').nth(1)); await h.holdUntil(0.95); } },
    { az: 'Dövr seçimi qrafikin üstündədir. Hazır düymələr ən çox soruşulan üç sualı örtür: son on iki ay, cari rüb və ilin əvvəlindən. Başqa aralıq lazımdırsa, iki ay sahəsini əl ilə doldurmaq olar.',
      do: async (p, l, h) => { await h.scrollTo('.chart'); await h.holdUntil(0.25); await h.moveTo(p.locator('button:has-text("12")').first()); await h.holdUntil(0.5); await h.click(p.locator('button:has-text("12")').first()); await h.holdUntil(0.8); await h.moveTo(p.locator('input[type=month]').first()); await h.holdUntil(0.95); } },
    { az: 'Seçilmiş dövr bütün panellərə tətbiq olunur — təkcə qrafikə yox, həm də kateqoriyalara, şöbələrə və təchizatçılara. Yəni «üçüncü rübü göstər» sualı bir kliklə cavab alır.',
      do: async (p, l, h) => { await h.moveTo(p.locator('button:has-text("Rüb")').first()); await h.holdUntil(0.35); await h.click(p.locator('button:has-text("Rüb")').first()); await h.holdUntil(0.75); await p.waitForTimeout(400); await h.moveTo('.chart'); await h.holdUntil(0.95); } },
    { az: 'Sütunlar faktiki xərcdir: yalnız qəbul edilmiş sifarişlər sayılır, plan və ya təsdiq gözləyən sorğular yox. Punktir xətt isə həmin ayın planıdır — büdcə öz dövrünə bərabər bölünür, bu, bölgü deyil, mütənasib hesablamadır.',
      do: async (p, l, h) => { await h.click(p.locator('button:has-text("12")').first()); await h.holdUntil(0.3); await h.moveTo(p.locator('.chart-bar').nth(8)); await h.holdUntil(0.6); await h.moveTo(p.locator('.chart-bar').last()); await h.holdUntil(0.95); } },
    { az: 'Ekranda gördüyünüz dövrü CSV faylına çıxarmaq olar: ay, plan və faktiki sütunları ilə. Hesabatı əl ilə yığmaq lazım gəlmir.',
      do: async (p, l, h) => { await h.moveTo('button:has-text("CSV")'); await h.holdUntil(0.5); await h.hover('button:has-text("CSV")', 900); await h.holdUntil(0.95); } },
    { az: 'Aşağıda büdcənin mənimsənilmə tempi. Sol tərəfdə şöbə və plan, sonra mənimsənilən faiz, onun yanında isə dövrün nə qədərinin keçdiyi. Bu iki rəqəm yan-yana durmalıdır, çünki ayrılıqda heç nə demir.',
      do: async (p, l, h) => { await h.scrollTo('h3:text-is("Büdcənin mənimsənilmə tempi")'); await h.holdUntil(0.4); const t = p.locator('.card:has(h3:text-is("Büdcənin mənimsənilmə tempi")) tbody tr').nth(1); await h.moveTo(t.locator('td').nth(2)); await h.holdUntil(0.7); await h.moveTo(t.locator('td').nth(3)); await h.holdUntil(0.95); } },
    { az: 'Sonuncu sütun tempdir: mənimsənilən faizdən keçən vaxtın faizi çıxılır. Müsbət rəqəm o deməkdir ki, şöbə təqvimdən qabaqda xərcləyir. On faizdən çox fərq qırmızı ilə işarələnir — bu, söhbət üçün siqnaldır.',
      do: async (p, l, h) => { const rows = p.locator('.card:has(h3:text-is("Büdcənin mənimsənilmə tempi")) tbody tr'); await h.moveTo(rows.nth(1).locator('td').last()); await h.holdUntil(0.45); await h.moveTo(rows.nth(2).locator('td').last()); await h.holdUntil(0.8); await h.moveTo(rows.nth(0).locator('td').last()); await h.holdUntil(0.95); } },
    { az: 'Şöbələr üzrə xərcdə bir texniki incəlik var: bölgü sifarişin öz şöbə sahəsindən oxunur, sorğu zəncirindən yox. Ona görə birbaşa alışlar və kataloq sifarişləri də düzgün şöbəyə düşür.',
      do: async (p, l, h) => { await h.scrollTo('h3:text-is("Şöbələr üzrə xərc")'); await h.holdUntil(0.4); await h.moveTo('.card:has(h3:text-is("Şöbələr üzrə xərc")) .budget-bar'); await h.holdUntil(0.75); await h.wheel(120); await h.holdUntil(0.95); } },
    { az: 'Yanında kateqoriyalar üzrə bölgü: bu, «nə alırıq» sualına cavabdır, şöbə isə «kim xərcləyir» sualına. İki fərqli ölçü, hər ikisi lazımdır — biri digərini əvəz etmir.',
      do: async (p, l, h) => { await h.moveTo('.card:has(h3:text-is("Kateqoriyalar üzrə"))'); await h.holdUntil(0.4); await h.moveTo(p.locator('.card:has(h3:text-is("Kateqoriyalar üzrə")) .budget-bar').first()); await h.holdUntil(0.75); await h.moveTo('.card:has(h3:text-is("Şöbələr üzrə xərc"))'); await h.holdUntil(0.95); } },
    { az: 'Ən aşağıda əsas təchizatçılar: qəbul edilmiş sifarişlərin həcminə görə ilk beşlik və hər biri üzrə sifariş sayı. Bu siyahı danışıqlarda faydalıdır, çünki həcm arqumentdir.',
      do: async (p, l, h) => { await h.scrollTo('h3:text-is("Əsas təchizatçılar")'); await h.holdUntil(0.4); await h.moveTo('.card:has(h3:text-is("Əsas təchizatçılar")) tbody tr'); await h.holdUntil(0.75); await h.wheel(-150); await h.holdUntil(0.95); } },
    { az: 'Bütün rəqəmlər real vaxtda hesablanır və yalnız sizin təşkilatınızın məlumatlarını əhatə edir. Hesabat yığmaq lazım deyil — bölməni açmaq və lazımi dövrü seçmək kifayətdir.',
      do: async (p, l, h) => { await h.wheel(-400); await h.holdUntil(0.35); await h.moveTo('.chart'); await h.holdUntil(0.7); await h.moveTo(p.locator('.card').nth(0)); await h.holdUntil(0.95); } },
  ]},
  // Logistics: a read-only board. The value is in what the statuses mean and in the line
  // between "delivered" and "accepted" — the old single-scene version said neither.
  'buyer-logistics': { role: 'buyer', path: '/buyer/logistics', scenes: [
    { az: 'Logistika bölməsi. Bu, sifarişləriniz üzrə yolda olan bütün göndərişlərin lövhəsidir. Burada siz izləyirsiniz, hadisələri isə təchizatçı qeyd edir — çünki mal onun əlindədir. Bu bölmə qəsdən yalnız oxunur.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.4); await h.moveTo('table'); await h.holdUntil(0.95); } },
    { az: 'Sütunlar sadədir: hansı sifariş, hansı təchizatçı, daşıyıcı şirkət, izləmə nömrəsi, cari status və gözlənilən çatdırılma tarixi. İzləmə nömrəsi ilə daşıyıcının öz saytında da yoxlamaq olar.',
      do: async (p, l, h) => { const th = p.locator('thead th'); await h.moveTo(th.nth(0)); await h.holdUntil(0.25); await h.moveTo(th.nth(2)); await h.holdUntil(0.5); await h.moveTo(th.nth(3)); await h.holdUntil(0.72); await h.moveTo(th.nth(5)); await h.holdUntil(0.95); } },
    { az: 'Statuslar marşrutu təkrarlayır. Əvvəlcə mal daşıyıcıya təhvil verilir, sonra yolda olur, gömrükdən keçir, çatır və nəhayət təhvil verilir. Lövhədə hazırda bu mərhələlərin hamısı eyni anda görünür.',
      do: async (p, l, h) => { const r = p.locator('table tbody tr'); await h.moveTo(r.nth(0).locator('td').nth(4)); await h.holdUntil(0.3); await h.moveTo(r.nth(1).locator('td').nth(4)); await h.holdUntil(0.52); await h.moveTo(r.nth(3).locator('td').nth(4)); await h.holdUntil(0.74); await h.moveTo(r.nth(4).locator('td').nth(4)); await h.holdUntil(0.95); } },
    { az: 'Bu göndəriş gömrükdədir. Beynəlxalq marşrutlarda ən çox vaxt məhz burada itir, ona görə mərhələ ayrıca status kimi qeyd olunur — sadəcə «yoldadır» yazmaq gecikmənin səbəbini gizlədərdi.',
      do: async (p, l, h) => { await h.moveTo(p.locator('table tbody tr:has-text("AZ60000001") td').nth(4)); await h.holdUntil(0.45); await h.moveTo(p.locator('table tbody tr:has-text("AZ60000001") td').nth(0)); await h.holdUntil(0.7); await h.moveTo(p.locator('table tbody tr:has-text("AZ60000001") td').nth(5)); await h.holdUntil(0.95); } },
    { az: 'Bu sətir isə diqqət tələb edir: göndərişdə hadisə baş verib. Təchizatçı səbəbi qeyd edir, siz isə problemi mal qapıya çatanda yox, elə yolda ikən görürsünüz.',
      do: async (p, l, h) => { await h.moveTo(p.locator('table tbody tr:has-text("AZ60000002") td').nth(4)); await h.holdUntil(0.5); await h.moveTo(p.locator('table tbody tr:has-text("AZ60000002")')); await h.holdUntil(0.95); } },
    { az: 'Gözlənilən tarix sütununa fikir verin. Əgər bu tarix artıq keçibsə, amma status hələ yolda qalıbsa — bu, təchizatçı ilə danışmaq üçün ən erkən siqnaldır.',
      do: async (p, l, h) => { const r = p.locator('table tbody tr'); await h.moveTo(r.nth(0).locator('td').nth(5)); await h.holdUntil(0.35); await h.moveTo(r.nth(1).locator('td').nth(5)); await h.holdUntil(0.6); await h.moveTo(r.nth(3).locator('td').nth(5)); await h.holdUntil(0.95); } },
    { az: 'Bir vacib fərq: «təhvil verildi» ilə «qəbul edildi» eyni şey deyil. Lövhədəki status yalnız malın gəldiyini bildirir. Rəsmi qəbul isə sifariş kartında aparılır — orada nə qədər gəldiyini siz təsdiqləyirsiniz.',
      do: async (p, l, h) => { await h.moveTo(p.locator('table tbody tr:has-text("AZ60000003") td').nth(4)); await h.holdUntil(0.5); await h.moveTo(p.locator('table tbody tr:has-text("AZ60000003") td').nth(0)); await h.holdUntil(0.95); } },
    { az: 'Zəncir də elə buradan bağlanır: göndəriş, qəbul, sonra qaimə. Qaimə məhz qəbul edilmiş miqdarla tutuşdurulur, ödənilən məbləğ isə büdcədə fakt olur. Yəni bu lövhə pulun hərəkətinin başlanğıcıdır.',
      do: async (p, l, h) => { await h.moveTo('table'); await h.holdUntil(0.5); await h.moveTo('h1'); await h.holdUntil(0.95); } },
  ]},
  'buyer-suppliers': { role: 'buyer', path: '/buyer/suppliers', scenes: [
    { az: 'Təchizatçılar bölməsi. Burada iki siyahı var: sizin reyestriniz və platformadakı ümumi kataloq. Reyestr — kimlərlə işləməyə icazə verdiyinizdir.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.4); await h.moveTo(p.locator('.card').nth(0)); await h.holdUntil(0.9); } },
    { az: 'Reyestrdə şirkət adı, VÖEN və status görünür. Status üç cür olur: dəvət olunub, təsdiqlənib və bloklanıb. Bu, sadəcə etiket deyil — sistem ona görə davranır.',
      do: async (p, l, h) => { const r = p.locator('.card').nth(0).locator('tbody tr').first(); await h.moveTo(r.locator('td').nth(0)); await h.holdUntil(0.4); await h.moveTo(r.locator('td').nth(1)); await h.holdUntil(0.7); await h.moveTo(r.locator('.badge')); await h.holdUntil(0.93); } },
    { az: 'Yalnız təsdiqlənmiş təchizatçı birbaşa sifariş və kataloq ala bilər. Bloklanmış təchizatçı isə tenderlərə dəvət olunmur. Yəni reyestr real girişi idarə edir.',
      do: async (p, l, h) => { const rows = p.locator('.card').nth(0).locator('tbody tr'); await h.moveTo(rows.nth(0).locator('.badge')); await h.holdUntil(0.45); await h.moveTo(rows.nth(1)); await h.holdUntil(0.92); } },
    { az: 'Sağdakı düymələr statusu dəyişir: bloklamaq və ya blokdan çıxarmaq. Hər dəyişiklik audit jurnalına yazılır — kim, nə vaxt və kimi bloklayıb.',
      do: async (p, l, h) => { await h.moveTo(p.locator('button[data-tip]').first()); await h.holdUntil(0.5); await h.moveTo(p.locator('button[data-tip]').nth(1)); await h.holdUntil(0.92); } },
    { az: 'Hər təchizatçı üzrə reytinq toplanır. Bu, subyektiv rəy deyil: qiymətlər real sifarişlərin nəticələrinə görə verilir — vaxtında çatdırıldımı, keyfiyyət necə idi, ünsiyyət necə qurulurdu.',
      do: async (p, l, h) => { await h.hover(p.locator('button[data-tip]').last(), 900); await h.holdUntil(0.45); await h.moveTo(p.locator('tbody tr').nth(1)); await h.holdUntil(0.75); await h.hover(p.locator('button[data-tip]').first(), 700); await h.holdUntil(0.9); await h.moveTo('h1'); } },
    { az: 'Reytinq iki yerdə işləyir. Birincisi, tender qiymətləndirilməsində: sistem etibarlılıq indeksini nəzərə alaraq tövsiyə verir. İkincisi, danışıqlarda — rəqəmlərlə arqument gətirmək asandır.',
      do: async (p, l, h) => { await h.moveTo(p.locator('tbody tr').nth(0)); await h.holdUntil(0.35); await h.moveTo(p.locator('tbody tr').nth(1)); await h.holdUntil(0.65); await h.hover(p.locator('button[data-tip]').nth(2), 700); await h.holdUntil(0.9); await h.moveTo('table'); } },
    { az: 'İkinci kart — platformanın ümumi kataloqu. Burada bütün qeydiyyatdan keçmiş təchizatçılar var, o cümlədən sizinlə hələ işləməyənlər.',
      do: async (p, l, h) => { await h.scrollTo(p.locator('.card').nth(1)); await h.holdUntil(0.3); await h.moveTo(p.locator('.card').nth(1).locator('table')); await h.holdUntil(0.6); await h.wheel(140); await h.holdUntil(0.92); } },
    { az: 'Yeni təchizatçı tapanda onu reyestrinizə dəvət edirsiniz. Dəvətdən sonra o, sizin tenderlərinizi görməyə başlayır — amma birbaşa sifariş üçün hələ təsdiq lazımdır.',
      do: async (p, l, h) => { const b = p.locator('.card').nth(1).locator('button').first(); if (await b.count()) { await h.hover(b, 900); } else { await h.moveTo(p.locator('.card').nth(1)); } await h.holdUntil(0.5); await h.moveTo(p.locator('.card').nth(1).locator('tbody tr').first()); await h.holdUntil(0.85); await h.moveTo('h1'); } },
    { az: 'Təsdiqdən əvvəl adətən yoxlama aparılır: vergi nömrəsi, lisenziyalar, bank rekvizitləri. Bunun üçün ayrıca bölmə var — yoxlama. Reyestr və yoxlama birlikdə işləyir.',
      do: async (p, l, h) => { await h.wheel(-200); await h.holdUntil(0.3); await h.moveTo('a[href="/buyer/verification"]'); await h.holdUntil(0.6); await h.hover('a[href="/buyer/verification"]', 800); await h.holdUntil(0.9); await h.moveTo('h1'); } },
    { az: 'Beləliklə reyestr sadə sualı həll edir: kim sizin pulunuza yaxın buraxılır. Hər ad orada təsadüfən deyil, qərarla görünür — və bu qərar həmişə izlənilir.',
      do: async (p, l, h) => { await h.moveTo(p.locator('tbody tr').first()); await h.holdUntil(0.35); await h.hover(p.locator('button[data-tip]').first(), 800); await h.holdUntil(0.7); await h.moveTo('h1'); await h.holdUntil(0.9); await h.moveTo('table'); } },
  ]},
  // Verification: a supplier dossier. Two cases on the stand — one waiting for a decision
  // with three documents, one already approved with a written conclusion.
  'buyer-verification': { role: 'buyer', path: '/buyer/verification', scenes: [
    { az: 'Yoxlama bölməsi. Bu, təchizatçının sənəd dosyesidir. Siz iş açırsınız, təchizatçı sənədləri özü yükləyir, siz isə baxıb qərar verirsiniz. Yəni «bu şirkət kimdir» sualının cavabı söz yox, sənəd olur.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.4); await h.moveTo('table'); await h.holdUntil(0.95); } },
    { az: 'Siyahıda üç sütun var: təchizatçı, işin statusu və yüklənmiş sənədlərin sayı. Say sıfırdırsa, hələ gözləmək lazımdır — qərar verməyə əsas yoxdur.',
      do: async (p, l, h) => { const r = p.locator('table tbody tr'); await h.moveTo(r.nth(0).locator('td').nth(1)); await h.holdUntil(0.35); await h.moveTo(r.nth(1).locator('td').nth(1)); await h.holdUntil(0.6); await h.moveTo(r.nth(1).locator('td').nth(2)); await h.holdUntil(0.95); } },
    { az: 'Qərar gözləyən işi açaq. Adına klikləyirik və altda dosye açılır: hər sənədin növü və faylın adı görünür.',
      do: async (p, l, h) => { await h.click('table tbody tr:has-text("Baku Metal") a'); await h.holdUntil(0.5); await h.scrollTo('.card:has(h3:has-text("Baku Metal"))'); await h.moveTo('.card:has(h3:has-text("Baku Metal")) .badge'); await h.holdUntil(0.95); } },
    { az: 'Sənəd növləri təsadüfi deyil: vergi nömrəsi, fəaliyyət lisenziyası, bank rekvizitləri və sığorta. Faylın adına klikləyəndə sənəd açılır — yəni qərar sənədin özünə baxaraq verilir.',
      do: async (p, l, h) => { const c = p.locator('.card:has(h3:has-text("Baku Metal"))'); await h.moveTo(c.locator('a').nth(0)); await h.holdUntil(0.3); await h.moveTo('table'); await h.holdUntil(0.5); await h.moveTo(c.locator('a').nth(1)); await h.holdUntil(0.72); await h.moveTo(c.locator('a').nth(2)); await h.holdUntil(0.95); } },
    { az: 'Hər faylın yanında kilid işarəsi və qısa kod var. Bu, faylın məzmununun barmaq izidir. Sənədi sonradan dəyişsələr, iz uyğun gəlməyəcək — yəni dosyeni səssizcə əvəzləmək mümkün deyil.',
      do: async (p, l, h) => { const c = p.locator('.card:has(h3:has-text("Baku Metal"))'); await h.moveTo('table'); await h.holdUntil(0.2); await h.hover(c.locator('[data-tip]').first(), 900); await h.holdUntil(0.6); await h.hover(c.locator('[data-tip]').nth(1), 800); await h.holdUntil(0.95); } },
    { az: 'Qərar düymələri aşağıdadır: təsdiq və imtina. Qərar dəyişilməz jurnala yazılır — kim, nə vaxt və hansı sənədlərə əsasən. Ona görə də bu bölmə audit zamanı ən çox soruşulan yerdir.',
      do: async (p, l, h) => { const c = p.locator('.card:has(h3:has-text("Baku Metal"))'); await h.moveTo(c.locator('button.btn').first()); await h.holdUntil(0.35); await h.hover(c.locator('button.btn').first(), 900); await h.holdUntil(0.7); await h.hover(c.locator('button.btn').nth(1), 800); await h.holdUntil(0.95); } },
    { az: 'İndi artıq təsdiqlənmiş işə baxaq. Burada qərar düymələri yoxdur — iş bağlanıb, statusu isə siyahıda dərhal görünür.',
      do: async (p, l, h) => { await h.click('table tbody tr:has-text("Baku Metal") a'); await h.holdUntil(0.2); await h.click('table tbody tr:has-text("Supply One") a'); await h.holdUntil(0.5); await h.scrollTo('.card:has(h3:has-text("Supply One"))'); await h.moveTo('.card:has(h3:has-text("Supply One")) h3'); await h.holdUntil(0.72); await h.moveTo('.card:has(h3:has-text("Supply One")) .badge'); await h.holdUntil(0.95); } },
    { az: 'Ən vacibi isə budur: yoxlama reyestrə bağlıdır. Yalnız təsdiqlənmiş təchizatçı birbaşa sifariş və kataloq ala bilər. Yəni bu bölmə sadəcə arxiv deyil — real girişi açan qapıdır.',
      do: async (p, l, h) => { await h.moveTo('.card:has(h3:has-text("Supply One")) a'); await h.holdUntil(0.3); await h.moveTo(p.locator('table tbody tr').first().locator('.badge')); await h.holdUntil(0.55); await h.moveTo('a[href="/buyer/suppliers"]'); await h.holdUntil(0.78); await h.moveTo(p.locator('table tbody tr').nth(1).locator('.badge')); await h.holdUntil(0.95); } },
  ]},
  'buyer-settings': { role: 'buyer', path: '/buyer/settings', scenes: [
    { az: 'Parametrlər bölməsi. Burada məlumat yox, qaydalar yaşayır: kim nə edə bilər, hansı məbləğdən tender başlayır, büdcə həddi keçiləndə nə olur və sifarişi kim imzalayır. Hər kart digər bölmələrin davranışını dəyişir.',
      do: async (p, l, h) => { await h.moveTo('h1'); await h.holdUntil(0.4); await h.moveTo(p.locator('.card').nth(0)); await h.holdUntil(0.95); } },
    { az: 'İstifadəçilər və rollar. Administrator hər şeyi idarə edir. Təsdiqləyən sifarişləri təsdiqləyir. Maliyyəçi büdcə tərəfinin sahibidir — planlar, hədlər, dövrün bağlanması — amma satınalma aparmır. İstifadəçi isə yalnız sifariş yaradır.',
      do: async (p, l, h) => { const r = p.locator('.card').nth(0).locator('tbody tr'); await h.moveTo(r.nth(0)); await h.holdUntil(0.35); await h.moveTo(r.nth(1)); await h.holdUntil(0.6); await h.moveTo(r.nth(2)); await h.holdUntil(0.95); } },
    { az: 'Hər istifadəçiyə ev şöbəsi təyin olunur. Bu texniki xırdalıq deyil: onun yaratdığı sifarişlər avtomatik həmin şöbənin büdcəsinə düşür — yəni xərc kimin olduğunu heç kim əl ilə seçmir.',
      do: async (p, l, h) => { const r = p.locator('.card').nth(0).locator('tbody tr'); await h.moveTo(r.nth(2).locator('td').last()); await h.holdUntil(0.5); await h.moveTo(r.nth(1).locator('td').last()); await h.holdUntil(0.95); } },
    { az: 'Kateqoriya kataloqu vahid siyahı saxlayır ki, «IT», «it» və «AyTi» siyasətdə, büdcədə və analitikada üç ayrı şeyə çevrilməsin. Kod qısa və sabit olur, ad isə izah üçündür.',
      do: async (p, l, h) => { await h.scrollTo('.card:has(h3:text-is("Kateqoriya kataloqu"))'); await h.holdUntil(0.35); await h.moveTo(p.locator('.card:has(h3:text-is("Kateqoriya kataloqu")) .badge').first()); await h.holdUntil(0.65); await h.moveTo(p.locator('.card:has(h3:text-is("Kateqoriya kataloqu")) .badge').nth(3)); await h.holdUntil(0.95); } },
    { az: 'Şöbələr — məsrəf mərkəzlərinin kataloqu. Şöbənin yuxarı şöbəsi ola bilər: onda yekun cədvəldə mərkəz öz tabeliyindəkiləri toplayır. Sahib isə büdcə həddi keçiləndə bildiriş alan konkret adamdır.',
      do: async (p, l, h) => { await h.scrollTo('.card:has(h3:text-is("Şöbələr (məsrəf mərkəzləri)"))'); await h.holdUntil(0.3); const r = p.locator('.card:has(h3:text-is("Şöbələr (məsrəf mərkəzləri)")) tbody tr'); await h.moveTo(r.nth(0)); await h.holdUntil(0.6); await h.moveTo(r.nth(0).locator('td').last()); await h.holdUntil(0.95); } },
    { az: 'Xərci olan şöbə silinmir — arxivə göndərilir. Səbəb sadədir: silinmə keçmiş sifarişləri sahibsiz qoyardı, arxiv isə tarixçəni saxlayır, amma şöbəni yeni xərc üçün seçilməz edir.',
      do: async (p, l, h) => { await h.moveTo(p.locator('.card:has(h3:text-is("Şöbələr (məsrəf mərkəzləri)")) button[data-tip]').first()); await h.holdUntil(0.4); await h.hover(p.locator('.card:has(h3:text-is("Şöbələr (məsrəf mərkəzləri)")) button[data-tip]').first(), 1200); await h.holdUntil(0.95); } },
    { az: 'Büdcə hədləri. Xəbərdarlıq faizi keçiləndə şöbənin sahibinə bildiriş gedir. Blok faizi isə təsdiqi dayandırır — sahə boşdursa, təsdiq heç vaxt dayanmır. Altdakı sətir qaydanın nə etdiyini sözlə yazır.',
      do: async (p, l, h) => { await h.scrollTo('.card:has(h3:text-is("Büdcə hədləri"))'); await h.holdUntil(0.3); await h.moveTo(p.locator('.card:has(h3:text-is("Büdcə hədləri")) input').first()); await h.holdUntil(0.55); await h.moveTo(p.locator('.card:has(h3:text-is("Büdcə hədləri")) input').nth(1)); await h.holdUntil(0.75); await h.moveTo(p.locator('.card:has(h3:text-is("Büdcə hədləri")) .hint').first()); await h.holdUntil(0.95); } },
    { az: 'Dəyişiklik yalnız «Yadda saxla» basılandan sonra qüvvəyə minir. Bu qəsdəndir: bu sahələr bütün şirkətdə xərci dayandıra bilər, ona görə təsadüfi kliklə dəyişməməlidir.',
      do: async (p, l, h) => { await h.moveTo(p.locator('.card:has(h3:text-is("Büdcə hədləri")) select')); await h.holdUntil(0.45); await h.moveTo(p.locator('.card:has(h3:text-is("Büdcə hədləri")) button.btn')); await h.holdUntil(0.95); } },
    { az: 'Metod siyasəti məbləğ şkalasıdır: hansı məbləğə qədər birbaşa sifariş, hansından qapalı tender. Metodu istifadəçi seçmir — qayda seçir, və satınalmanın şəffaflığı məhz bundan başlayır.',
      do: async (p, l, h) => { await h.scrollTo('.card:has(h3:has-text("Metod siyasəti"))'); await h.holdUntil(0.3); const b = p.locator('.card:has(h3:has-text("Metod siyasəti")) .mp-band'); await h.moveTo(b.first()); await h.holdUntil(0.6); await h.moveTo(b.last()); await h.holdUntil(0.95); } },
    { az: 'Göndərmə kanalları: öz poçt serveriniz və ya WhatsApp nömrəniz. Qoşulmayıbsa, sistem öz standart kanalından istifadə edir — yəni bildirişlər hər halda çatır.',
      do: async (p, l, h) => { await h.scrollTo('.ch-item'); await h.holdUntil(0.3); await h.moveTo(p.locator('.ch-item').first()); await h.holdUntil(0.65); await h.moveTo(p.locator('.ch-item').nth(1)); await h.holdUntil(0.95); } },
    { az: 'İnteqrasiyalar: qaimələri bir düymə ilə mühasibat üçün ixrac etmək olur. Sistem qapalı qutu deyil — məlumat həmişə çıxarıla bilir.',
      do: async (p, l, h) => { await h.scrollTo('.card:has(h3:text-is("İnteqrasiyalar"))'); await h.holdUntil(0.4); await h.moveTo(p.locator('.card:has(h3:text-is("İnteqrasiyalar")) .btn').first()); await h.holdUntil(0.95); } },
    { az: 'Və ən sonda təsdiq zənciri: sifarişi məbləğdən asılı olaraq kim imzalayır. Hazır sxemlər var — bir addım, iki addım, yaxud böyük məbləğlər üçün maliyyəçinin vizası. Öz sifarişini təsdiqləmək isə qadağandır.',
      do: async (p, l, h) => { await h.scrollTo('.card:has(h3:has-text("Təsdiq zənciri"))'); await h.holdUntil(0.3); const c = p.locator('.card:has(h3:has-text("Təsdiq zənciri")) [role="button"]'); await h.moveTo(c.first()); await h.holdUntil(0.6); await h.moveTo(c.last()); await h.holdUntil(0.95); } },
  ]},
  'sup-dashboard': { role: 'sup', path: '/supplier/dashboard', scenes: [
    { ru: 'Рабочий стол поставщика. Открытые тендеры, мои ставки, выигранные контракты, заказы в работе и счета — всё на одном экране.',
      az: 'Təchizatçının idarə paneli. Açıq tenderlər, mənim təkliflərim, udulmuş müqavilələr, işdə olan sifarişlər və qaimələr — hamısı bir ekranda.',
      en: 'The supplier dashboard. Open tenders, my bids, won contracts, orders in progress and invoices — all on one screen.' },
    { ru: 'В задачах — что требует действий: подать ставку на новый тендер, продвинуть доставку или выставить счёт по принятому заказу.',
      az: 'Tapşırıqlarda — nə tələb olunur: yeni tenderə təklif vermək, çatdırılmanı irəlilətmək və ya qəbul edilmiş sifariş üzrə qaimə vermək.',
      en: 'In the tasks — what needs action: bid on a new tender, advance a delivery, or invoice an accepted order.',
      do: async (p) => { await scrollTo(p, 'table'); await slowScroll(p, 3); } },
  ]},
  'sup-market': { role: 'sup', path: '/supplier/market', scenes: [
    { ru: 'Открытые тендеры — процедуры, куда вас пригласил закупщик, плюс публичные. В колонке «Моя ставка» видно, где вы уже участвуете. Наведём на статус — подсказка объяснит, на каком этапе тендер.',
      az: 'Açıq tenderlər — alıcının sizi dəvət etdiyi prosedurlar, üstəgəl açıq olanlar. «Mənim təklifim» sütununda harada iştirak etdiyiniz görünür. Statusun üzərinə gətirək — ipucu tenderin hansı mərhələdə olduğunu izah edəcək.',
      en: 'Open tenders — the procedures the buyer invited you to, plus public ones. The “My bid” column shows where you already take part. Hover a status and the tooltip explains the tender’s stage.',
      do: (p) => hoverTip(p, '.badge[data-tip]') },
    { ru: 'Заходим в тендер офисной мебели, чтобы подать ставку.',
      az: 'Təklif vermək üçün ofis mebeli tenderinə keçirik.',
      en: 'Let’s open the office-furniture tender to place a bid.',
      do: async (p, lang) => { await clickAt(p, `a:has-text("${NAV.furnitureTender[lang]}")`, 1400); await p.waitForSelector('h1', { timeout: 15000 }); } },
    { ru: 'Вводим цену за единицу по каждой позиции — итоговую сумму система считает сама. Заполнить нужно все позиции лота: неполная ставка считается неответственной и не рассматривается.',
      az: 'Hər mövqe üzrə vahid qiymət daxil edirik — yekun məbləği sistem özü hesablayır. Lotun bütün mövqelərini doldurmaq lazımdır: natamam təklif cavabsız sayılır və nəzərə alınmır.',
      en: 'We enter a unit price for each line — the system totals it for us. Every line of the lot must be filled: an incomplete bid is non-responsive and won’t be considered.',
      do: async (p) => {
        const prices = p.locator('input[step="0.01"]');
        const n = await prices.count();
        for (let i = 0; i < n; i++) await fillAt(p, prices.nth(i), String(20 + i * 5) + '.00');
        await fillAt(p, 'input[min="1"]', '14');
      } },
    { ru: 'Ставка запечатывается: до церемонии вскрытия закупщик видит только факт вашего участия, но не суммы — они зашифрованы. До дедлайна ставку можно отозвать и подать заново. Нажимаем «Подать ставку».',
      az: 'Təklif möhürlənir: açılış mərasiminə qədər alıcı yalnız iştirakınızı görür, məbləğləri yox — onlar şifrələnib. Son tarixədək təklifi geri götürüb yenidən vermək olar. «Təklif ver» düyməsini basırıq.',
      en: 'The bid is sealed: until the opening ceremony the buyer sees only that you took part, not the amounts — they’re encrypted. Before the deadline you can withdraw and resubmit. We click Submit bid.',
      do: async (p) => { await hoverTip(p, '.sealed, .hint:has-text("🔒")', 1200); await clickAt(p, 'button.btn:not(.ghost):has-text("🔒")', 1400); } },
    { ru: 'Вопросы по тендеру задавайте в разделе вопросов и ответов. Ответ закупщика все участники видят одинаково — это требование равного отношения ко всем поставщикам.',
      az: 'Tenderlə bağlı sualları suallar və cavablar bölməsində verin. Alıcının cavabını bütün iştirakçılar eyni cür görür — bu, bütün təchizatçılara bərabər münasibət tələbidir.',
      en: 'Ask questions in the questions-and-answers area. The buyer’s reply is shown to every participant equally — the equal-treatment rule for all suppliers.',
      do: (p) => scrollTo(p, 'h3:has-text("Q"), input') },
  ]},
  'sup-orders': { role: 'sup', path: '/supplier/orders', scenes: [
    { ru: 'Заказы в работе — ваш конвейер поставки. Подтвердите заказ, упакуйте, отгрузите, доставьте: каждый шаг двигается одной кнопкой, а закупщик видит статус в реальном времени.',
      az: 'İşdə olan sifarişlər — sizin çatdırılma konveyeriniz. Sifarişi təsdiqləyin, qablaşdırın, göndərin, çatdırın: hər addım bir düymə ilə, alıcı isə statusu real vaxtda görür.',
      en: 'Orders in progress — your delivery pipeline. Confirm the order, pack, ship, deliver: each step moves with one button, and the buyer sees the status in real time.' },
    { ru: 'Если закупщик предложил изменение заказа, вы увидите точный расчёт: старое и новое количество, цена и итоговая сумма. Принять или отклонить — решаете вы. При согласии суммы пересчитаются автоматически.',
      az: 'Əgər alıcı sifarişin dəyişməsini təklif edibsə, dəqiq hesablamanı görəcəksiniz: köhnə və yeni miqdar, qiymət və yekun məbləğ. Qəbul və ya rədd — siz qərar verirsiniz. Razılıqda məbləğlər avtomatik yenilənir.',
      en: 'If the buyer proposed a change to the order, you’ll see the exact figures: old and new quantity, price and the resulting total. Accept or reject — that’s your call. On acceptance the amounts recompute automatically.',
      do: async (p) => { if (await p.locator('button:has-text("✎")').first().count()) await clickAt(p, 'button:has-text("✎")', 900); } },
    { ru: 'Для доставки создайте отгрузку с перевозчиком и трек-номером и отмечайте события в пути — заказчик видит движение груза в реальном времени.',
      az: 'Çatdırılma üçün daşıyıcı və izləmə nömrəsi ilə göndəriş yaradın və yol hadisələrini qeyd edin — alıcı yükün hərəkətini real vaxtda görür.',
      en: 'For delivery, create a shipment with a carrier and tracking number, and mark the events along the way — the buyer watches the cargo move in real time.',
      do: async (p) => { if (await p.locator('button:has-text("🚚")').first().count()) await hoverTip(p, 'button:has-text("🚚")', 1100); } },
    { ru: 'А после доставки выставляйте счёт одним нажатием — он автоматически уйдёт закупщику на трёхстороннюю сверку.',
      az: 'Çatdırılmadan sonra isə qaiməni bir kliklə verin — o, avtomatik olaraq üçtərəfli yoxlama üçün alıcıya gedəcək.',
      en: 'And after delivery, raise the invoice in one click — it goes to the buyer automatically for the three-way match.' },
  ]},
  'sup-invoices': { role: 'sup', path: '/supplier/invoices', scenes: [
    { ru: 'Раздел «Счета». Здесь ваши счета по заказам и их статусы: система автоматически сверяет счёт с заказом и фактической приёмкой — трёхсторонняя сверка.',
      az: 'Qaimələr bölməsi. Burada sifarişlər üzrə qaimələriniz və onların statusları var: sistem qaiməni sifariş və faktiki qəbulla avtomatik üzləşdirir — üçtərəfli yoxlama.',
      en: 'The Invoices section. Here are your invoices by order and their statuses: the system automatically reconciles the invoice against the order and the actual receipt — the three-way match.',
      do: (p) => hoverTip(p, '.badge[data-tip]') },
    { ru: 'Совпало — статус «MATCHED», закупщик утверждает и оплачивает. Расхождение — «DISPUTED», с деталями по строкам. Кнопкой можно выгрузить счёт в международном формате UBL для электронного обмена.',
      az: 'Uyğun gəldi — «MATCHED» statusu, alıcı təsdiqləyib ödəyir. Uyğunsuzluq — «DISPUTED», sətirlər üzrə təfərrüatla. Düymə ilə qaiməni elektron mübadilə üçün beynəlxalq UBL formatında ixrac etmək olar.',
      en: 'A match gives the MATCHED status — the buyer approves and pays. A discrepancy is DISPUTED, with per-line details. A button exports the invoice in the international UBL format for electronic exchange.',
      do: (p) => scrollTo(p, 'table') },
  ]},
  'sup-auction': { role: 'sup', path: '/supplier/market', scenes: [
    { ru: 'Отдельный тип процедуры — реверс-аукцион. Открываем аукцион на дизельное топливо.',
      az: 'Ayrıca prosedur növü — revers-auksion. Dizel yanacağı üzrə auksionu açırıq.',
      en: 'A distinct procedure type — the reverse auction. We open the diesel-fuel auction.',
      do: async (p, lang) => { await clickAt(p, `a:has-text("${NAV.fuelTender[lang]}")`, 1400); await p.waitForSelector('h1', { timeout: 15000 }); } },
    { ru: 'Здесь цены открыты и идут в реальном времени. Панель показывает лучшую текущую ставку и максимум, который примут от вас на следующем шаге — он всегда ниже лучшего на шаг снижения. Ваша задача — предложить дешевле.',
      az: 'Burada qiymətlər açıqdır və real vaxtda gedir. Panel cari ən yaxşı təklifi və növbəti addımda sizdən qəbul olunacaq maksimumu göstərir — o həmişə ən yaxşıdan bir addım aşağıdır. Vəzifəniz — daha ucuz təklif etmək.',
      en: 'Here prices are open and move in real time. The panel shows the current best bid and the maximum accepted from you on the next step — always one decrement below the best. Your job is to bid lower.',
      do: (p) => scrollTo(p, 'h3, table, input') },
    { ru: 'Как только кто-то перебивает вашу цену в последние секунды — дедлайн автоматически продлевается, чтобы избежать «снайпинга». Побеждает лучшая цена на момент закрытия.',
      az: 'Kimsə son saniyələrdə qiymətinizi keçəndə — «snayping»in qarşısını almaq üçün son tarix avtomatik uzadılır. Bağlanma anında ən yaxşı qiymət qalib gəlir.',
      en: 'The moment someone beats your price in the final seconds, the deadline auto-extends to prevent sniping. The best price at close wins.' },
  ]},
  'sup-verification': { role: 'sup', path: '/supplier/verification', scenes: [
    { ru: 'Раздел «Верификация». Чтобы получать прямые заказы, поставщик проходит проверку: загружает документы — VÖEN, лицензии, сертификаты. Здесь виден статус вашего кейса и список запрошенных документов.',
      az: 'Yoxlama bölməsi. Birbaşa sifarişlər almaq üçün təchizatçı yoxlamadan keçir: sənədləri yükləyir — VÖEN, lisenziyalar, sertifikatlar. Burada işinizin statusu və tələb olunan sənədlərin siyahısı görünür.',
      en: 'The Verification section. To receive direct orders, a supplier passes a check: uploading documents — VÖEN, licenses, certificates. Here you see your case status and the list of requested documents.',
      do: (p) => scrollTo(p, 'table, .card') },
    { ru: 'После загрузки закупщик рассматривает документы и выносит решение. Одобрение автоматически открывает вам прямые заказы и каталоги — без отдельного тендера.',
      az: 'Yükləmədən sonra alıcı sənədləri nəzərdən keçirir və qərar verir. Təsdiq sizə birbaşa sifarişləri və kataloqları avtomatik açır — ayrıca tender olmadan.',
      en: 'After upload, the buyer reviews the documents and decides. Approval automatically unlocks direct orders and catalogs for you — with no separate tender.' },
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
        execSync(`node ${join(ROOT, 'scripts/demo-fill.mjs')} ${API_URL}`, {
          env: { ...process.env, DEMO_RESET: '1', DEMO_LANG: lang }, stdio: 'pipe',
        });
      } catch (e) { console.log(`  ! reseed failed: ${e.message.split('\n')[0]}`); }
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
