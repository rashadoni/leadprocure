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
const scrollTo = async (page, sel) => { const el = page.locator(sel).first(); if (await el.count()) { await el.scrollIntoViewIfNeeded(); await P(700); } };
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
async function moveTo(page, sel, hold) { return moveToLoc(page, L(page, sel), hold); }
async function fillAt(page, sel, text, delay = 65) {
  const loc = L(page, sel);
  if (!(await moveToLoc(page, loc))) return;
  await loc.click({ delay: 40 }).catch(() => {});
  await loc.selectText().catch(() => {}); // replace any pre-filled value instead of appending
  await loc.pressSequentially(text, { delay });
  await P(300);
}
async function hoverTip(page, sel, hold = 1500) {
  const loc = L(page, sel);
  if (!(await moveToLoc(page, loc))) return;
  await loc.hover().catch(() => {});
  await P(hold); // let the CSS tooltip fade in and be readable
}
async function clickAt(page, sel, waitMs = 900) {
  const loc = L(page, sel);
  if (!(await moveToLoc(page, loc))) return;
  await loc.click().catch(() => {});
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
    { ru: 'Раздел «Заявки» — отсюда начинается любая закупка. Заявка фиксирует внутреннюю потребность компании: что нужно, в каком количестве и по какой ориентировочной цене. Давайте создадим новую заявку вместе, шаг за шагом.',
      az: 'Sifarişlər bölməsi — istənilən satınalma buradan başlayır. Sifariş şirkətin daxili tələbatını qeyd edir: nə lazımdır, hansı miqdarda və təxminən hansı qiymətə. Gəlin birlikdə, addım-addım yeni sifariş yaradaq.',
      en: 'The Requests section — every purchase begins here. A request captures an internal need: what is needed, in what quantity, and at roughly what price. Let’s create a new one together, step by step.',
      do: async (p, l, h) => { await h.moveTo(p.locator('form > .row').nth(0).locator('input').nth(0)); await h.holdUntil(0.55); await h.moveTo('table'); await h.holdUntil(0.92); } },
    { ru: 'Сначала — название и категория. Категория здесь ключевая: именно по ней срабатывает политика метода закупки, ведётся контроль бюджета и строится аналитика по направлениям. Наводим курсор на поле и заполняем.',
      az: 'Əvvəlcə ad və kateqoriya. Kateqoriya burada açardır: məhz ona görə satınalma metodu siyasəti işə düşür, büdcə nəzarəti aparılır və istiqamətlər üzrə analitika qurulur. Kursoru sahəyə gətirib doldururuq.',
      en: 'First, the title and category. The category is pivotal: it drives the procurement-method policy, budget control, and per-category analytics. We move the cursor to the field and fill it in.',
      do: async (p, lang, h) => {
        await h.fill(p.locator('form > .row').nth(0).locator('input').nth(0), FILL[lang].reqTitle);
        await h.holdUntil(0.55);
        await h.fill('input[list="req-categories"]', 'IT');
        await h.holdUntil(0.92);
      } },
    { ru: 'Теперь позиции. По каждой указываем наименование, количество и цену за единицу. Итоговую сумму считает сервер — по количеству и цене каждой позиции, поэтому она всегда точная и защищена от подмены. Строк можно добавить сколько угодно кнопкой «плюс позиция».',
      az: 'İndi mövqelər. Hər biri üçün ad, miqdar və vahid qiyməti göstəririk. Yekun məbləği server hesablayır — hər mövqenin sayı və qiymətinə görə, ona görə həmişə dəqiqdir və dəyişdirilmədən qorunur. «Mövqe əlavə et» düyməsi ilə istənilən qədər sətir əlavə etmək olar.',
      en: 'Now the line items. For each we enter a name, a quantity and a unit price. The total is computed by the server — from each line’s quantity and price — so it is always accurate and protected from tampering. You can add as many rows as needed with the plus-item button.',
      do: async (p, lang, h) => {
        const row = p.locator('form > .row').nth(1);
        await h.fill(row.locator('input').nth(0), FILL[lang].reqItem);
        await h.holdUntil(0.35);
        await h.fill(row.locator('input').nth(1), '10');
        await h.holdUntil(0.5);
        await h.fill(row.locator('input').nth(2), '1500');
        await h.holdUntil(0.72);
        await h.hover('button.ghost.small', 900);
        await h.holdUntil(0.92);
      } },
    { ru: 'Нажимаем «Создать» — и заявка появляется в реестре ниже, со статусом «черновик». Дальше её отправляют на утверждение; причём утвердить собственную заявку нельзя — это разделение полномочий, второй пары глаз.',
      az: 'Yarat düyməsini basırıq — və sifariş aşağıdakı reyestrdə «qaralama» statusu ilə görünür. Sonra o, təsdiqə göndərilir; özü də öz sifarişini təsdiqləmək olmaz — bu, səlahiyyətlərin bölünməsidir, ikinci cüt gözdür.',
      en: 'We click Create — and the request appears in the register below as a draft. Then it’s sent for approval; note you cannot approve your own request — that’s segregation of duties, a second pair of eyes.',
      do: async (p, l, h) => { await h.click('form button.btn:not(.ghost):not([type=button])', 1100); await h.holdUntil(0.45); await h.scrollTo('table'); await h.holdUntil(0.92); } },
    { ru: 'У утверждённой заявки открывается выбор процедуры закупки. Наведём курсор на кнопки — и подсказки объяснят каждую: RFQ — закрытый тендер с запечатанными ценами; RFP — с техническим предложением; RFI — сбор информации без цен; а молния — реверс-аукцион, где поставщики снижают цену в реальном времени. Мелкие суммы политика отправляет напрямую в заказ, без тендера.',
      az: 'Təsdiqlənmiş sifarişdə satınalma proseduru seçimi açılır. Kursoru düymələrin üzərinə gətirək — ipuçları hər birini izah edəcək: RFQ — möhürlü qiymətlərlə qapalı tender; RFP — texniki təkliflə; RFI — qiymətsiz məlumat toplama; şimşək isə revers-auksiondur, təchizatçılar qiyməti real vaxtda aşağı salır. Kiçik məbləğləri siyasət tendersiz birbaşa sifarişə göndərir.',
      en: 'An approved request opens the choice of procurement procedure. We hover the buttons and the tooltips explain each: RFQ — a sealed tender with encrypted prices; RFP — with a technical proposal; RFI — information gathering without prices; and the lightning — a reverse auction where suppliers drive the price down in real time. Small amounts go straight to a direct order, no tender.',
      do: async (p, l, h) => {
        await h.hover('button:has-text("RFQ")', 1400); await h.holdUntil(0.4);
        await h.hover('button:has-text("RFP")', 1400); await h.holdUntil(0.62);
        await h.hover('button:has-text("RFI")', 1400); await h.holdUntil(0.92);
      } },
    { ru: 'Кто решает, будет тендер или прямой заказ? Не автор заявки — колонку «метод» заполняет система в момент утверждения, по политике организации: до какой суммы прямой заказ, с какой — тендер. Настроить шкалу администратор может по ссылке с весами прямо отсюда — так исключаются закупки в обход конкуренции.',
      az: 'Tender, yoxsa birbaşa sifariş olacağını kim həll edir? Sifarişin müəllifi yox — «metod» sütununu sistem təsdiq anında doldurur, təşkilatın siyasətinə görə: hansı məbləğə qədər birbaşa sifariş, hansından tender. Şkalanı administrator elə buradakı tərəzili keçidlə tənzimləyə bilər — beləcə rəqabətdən yan keçən satınalmalar istisna olunur.',
      en: 'Who decides between a tender and a direct order? Not the requester — the method column is filled by the system at approval time, from the organisation’s policy: up to which amount a direct order, from which a tender. The admin tunes the scale via the scales link right here — which rules out purchases that dodge competition.',
      do: async (p, l, h) => {
        await h.holdUntil(0.25);
        await h.hover('a:has-text("⚖️")', 1800);
        await h.holdUntil(0.6);
        await h.scrollTo('table');
        await h.holdUntil(0.92);
      } },
  ]},
  'buyer-events': { role: 'buyer', path: '/buyer/events', scenes: [
    { ru: 'Раздел «Тендеры». Все процедуры со статусами — наведите на статус, и он объяснит себя — и количество поданных ставок по каждой.',
      az: 'Tenderlər bölməsi. Bütün prosedurlar statuslarla — statusun üzərinə gətirin, o özünü izah edəcək — və hər biri üzrə verilmiş təkliflərin sayı.',
      en: 'The Tenders section. All procedures with their statuses — hover a status and it explains itself — and the number of bids on each.',
      do: async (p, l, h) => { await h.holdUntil(0.35); await h.hover('.badge', 1600); await h.holdUntil(0.92); } },
    { ru: 'Откроем завершённый тендер серверного оборудования.',
      az: 'Server avadanlığının başa çatmış tenderini açaq.',
      en: 'Let’s open the completed server-hardware tender.',
      do: async (p, lang, h) => { await h.click(`a:has-text("${NAV.serverTender[lang]}")`, 1400); await p.waitForSelector('h1', { timeout: 15000 }); await h.holdUntil(0.92); } },
    { ru: 'Позиции тендера — неизменяемый снимок из заявки. При необходимости их делят на лоты, и каждый лот можно наградить своему поставщику.',
      az: 'Tenderin mövqeləri — sifarişdən dəyişməz görüntüdür. Lazım olarsa, lotlara bölünür və hər lot öz təchizatçısına verilə bilər.',
      en: 'The tender items are an immutable snapshot of the request. They can be split into lots, and each lot awarded to its own supplier.',
      do: async (p, l, h) => { await h.holdUntil(0.3); await h.wheel(160); await h.holdUntil(0.55); await h.wheel(160); await h.holdUntil(0.8); await h.wheel(120); await h.holdUntil(0.92); } },
    { ru: 'Ставки. До вскрытия закупщик видит только факт участия — суммы зашифрованы. После вскрытия появляются цены, сроки, взвешенная оценка и награждение. Здесь победил поставщик со ставкой ниже оценки — экономия видна сразу.',
      az: 'Təkliflər. Açılışa qədər alıcı yalnız iştirak faktını görür — məbləğlər şifrələnib. Açılışdan sonra qiymətlər, müddətlər, çəkili qiymətləndirmə və qalib seçimi görünür. Burada təxmindən aşağı təkliflə təchizatçı qalib gəldi — qənaət dərhal görünür.',
      en: 'The bids. Before opening, the buyer sees only that a supplier took part — the amounts are encrypted. After opening come the prices, lead times, the weighted score and the award. Here the winner bid below the estimate — the saving is visible at once.',
      do: async (p, lang, h) => { await h.scrollTo(`h3:has-text("${BTN.bids[lang]}")`); await h.holdUntil(0.4); await h.wheel(180); await h.holdUntil(0.7); await h.wheel(140); await h.holdUntil(0.92); } },
    { ru: 'А теперь тендер, который идёт прямо сейчас — офисная мебель. Здесь работает новая функция: автоматические напоминания поставщикам.',
      az: 'İndi isə hazırda gedən tender — ofis mebeli. Burada yeni funksiya işləyir: təchizatçılara avtomatik xatırlatmalar.',
      en: 'And now a tender that is running right now — office furniture. This is where a new feature works: automatic supplier reminders.',
      do: async (p, lang, h) => {
        await p.goto(`${BASE}/buyer/events`);
        await p.waitForSelector('h1', { timeout: 15000 });
        await injectCursor(p);
        await h.holdUntil(0.35);
        await h.click(`a:has-text("${NAV.furnitureTender[lang]}")`, 1400);
        await p.waitForSelector('h1', { timeout: 15000 });
        await injectCursor(p);
        await h.holdUntil(0.92);
      } },
    { ru: 'Карточка «Авто-напоминания». План виден заранее: письмо через сутки, ещё одно через двое, затем ватсап. Приглашённые без ставки получают напоминания сами — вам не нужно никого дёргать. Как только поставщик подаёт ставку, его цепочка мгновенно останавливается.',
      az: 'Avtomatik xatırlatmalar kartı. Plan əvvəlcədən görünür: bir gündən sonra məktub, iki gündən sonra daha biri, sonra vatsap. Təklif verməyən dəvətlilər xatırlatmaları özləri alır — heç kimi narahat etməyə ehtiyac yoxdur. Təchizatçı təklif verən kimi onun zənciri dərhal dayanır.',
      en: 'The auto follow-ups card. The plan is visible up front: an email after a day, another after two, then WhatsApp. Invited suppliers who haven’t bid get reminded automatically — you chase no one. The moment a supplier bids, their chain stops instantly.',
      do: async (p, l, h) => {
        await h.scrollTo('h3:has-text("⏰")');
        await h.holdUntil(0.3);
        const chips = p.locator('.chip');
        const n = Math.min(await chips.count(), 3);
        const beats = [0.5, 0.7, 0.92];
        for (let i = 0; i < n; i++) { await moveToLoc(p, chips.nth(i), 700); await h.holdUntil(beats[i] ?? 0.92); }
      } },
    { ru: 'Покажем в деле: приглашаем второго поставщика и включаем ему цепочку одной кнопкой. Статус сразу «активна», рядом — когда уйдёт первое письмо. Кнопка «стоп» в любой момент останавливает напоминания вручную.',
      az: 'Gəlin əməldə göstərək: ikinci təchizatçını dəvət edib bir düymə ilə zəncirini aktivləşdiririk. Status dərhal «aktiv», yanında ilk məktubun nə vaxt gedəcəyi görünür. «Dayandır» düyməsi xatırlatmaları istənilən an əl ilə dayandırır.',
      en: 'Let’s see it live: we invite the second supplier and enable their chain with one button. The status turns active at once, with the time of the first email next to it. The stop button halts the reminders manually at any moment.',
      do: async (p, lang, h) => {
        // invite Baku Metal if the dropdown offers it, then enable their chain
        const sel = p.locator('select').first();
        if (await sel.count()) {
          const opt = sel.locator('option', { hasText: 'Baku Metal' });
          if (await opt.count()) {
            await moveToLoc(p, sel, 500);
            await sel.selectOption({ label: (await opt.first().textContent()) ?? 'Baku Metal ASC' }).catch(() => {});
            await h.holdUntil(0.18);
            await h.click(`button:has-text("${BTN.invite[lang]}")`, 1200);
          }
        }
        await h.holdUntil(0.38);
        const enable = p.locator('button:has-text("▶")').first();
        if (await enable.count()) await h.click(enable, 1400);
        await h.holdUntil(0.62);
        const badge = p.locator('h3:has-text("⏰")').locator('..').locator('.badge').first();
        if (await badge.count()) await moveToLoc(p, badge, 900);
        await h.holdUntil(0.8);
        const stop = p.locator('button:has-text("⏹")').first();
        if (await stop.count()) await moveToLoc(p, stop, 1100); // show it — never click
        await h.holdUntil(0.94);
      } },
  ]},
  'buyer-contracts': { role: 'buyer', path: '/buyer/contracts', scenes: [
    { ru: 'Контракты и заказы. Контракт создаётся из награждённого тендера одним нажатием и фиксирует цены победителя.',
      az: 'Müqavilələr və sifarişlər. Müqavilə qalib tenderdən bir kliklə yaradılır və qalibin qiymətlərini sabitləyir.',
      en: 'Contracts and orders. A contract is created from the awarded tender in one click and locks in the winner’s prices.' },
    { ru: 'По контракту выпускаются заказы. Каждый идёт по конвейеру: выпущен, подтверждён, упакован, отгружен, доставлен, принят. Свои шаги двигает каждая сторона.',
      az: 'Müqavilə üzrə sifarişlər verilir. Hər biri konveyerlə gedir: verilib, təsdiqlənib, qablaşdırılıb, göndərilib, çatdırılıb, qəbul edilib. Öz addımlarını hər tərəf atır.',
      en: 'Orders are issued against the contract. Each moves along the pipeline: issued, confirmed, packed, shipped, delivered, accepted. Each side moves its own steps.',
      do: (p) => scrollTo(p, '.card:nth-of-type(2)') },
    { ru: 'Нужно изменить выпущенный заказ? Кнопка «изменить» рядом со статусом: новое количество или цена, причина — и поправка уходит поставщику. Суммы обновятся только после его согласия, а история сохранится навсегда.',
      az: 'Verilmiş sifarişi dəyişmək lazımdır? Statusun yanındakı «Dəyiş» düyməsi: yeni miqdar və ya qiymət, səbəb — və düzəliş təchizatçıya gedir. Məbləğlər yalnız onun razılığından sonra yenilənir, tarixçə isə həmişəlik saxlanılır.',
      en: 'Need to change an issued order? The amend button next to the status: a new quantity or price, a reason — and the amendment goes to the supplier. Amounts update only after they agree, and the history is kept forever.',
      do: (p) => slowScroll(p, 3) },
  ]},
  'buyer-invoices': { role: 'buyer', path: '/buyer/invoices', scenes: [
    { ru: 'Счета. Поставщик выставляет счёт по заказу, и система автоматически проводит трёхстороннюю сверку: что заказано, что принято по факту и что в счёте.',
      az: 'Qaimələr. Təchizatçı sifariş üzrə qaimə verir və sistem avtomatik üçtərəfli yoxlama aparır: nə sifariş olunub, faktiki nə qəbul edilib və qaimədə nə var.',
      en: 'Invoices. The supplier issues an invoice against the order, and the system runs an automatic three-way match: what was ordered, what was actually received and what’s on the invoice.' },
    { ru: 'Совпало — счёт помечается «сошёлся»: его можно утвердить и оплатить. Расхождение — «спорный», с деталями по каждой строке. Наведите на статус — подсказка объяснит, что именно не сошлось.',
      az: 'Uyğun gəldi — qaimə «uyğundur» kimi işarələnir: onu təsdiqləyib ödəmək olar. Uyğunsuzluq — «mübahisəli», hər sətir üzrə təfərrüatla. Statusun üzərinə gətirin — ipucu nəyin uyğun gəlmədiyini izah edəcək.',
      en: 'A match marks the invoice as matched: it can be approved and paid. A discrepancy makes it disputed, with per-line details. Hover the status — the tooltip explains exactly what didn’t add up.',
      do: async (p, l, h) => { await h.holdUntil(0.3); await h.hover('.badge[data-tip]', 1800); await h.holdUntil(0.7); await h.wheel(160); await h.holdUntil(0.92); } },
    { ru: 'Важно: сверка живая. Если поставщик выставил счёт раньше, чем товар доехал, счёт временно спорный — но как только вы оформите приёмку, система пересчитает сверку сама и счёт станет «сошёлся» без единого клика. Ручное утверждение с обоснованием остаётся только для настоящих исключений. Кнопка UBL выгружает счёт в международном формате.',
      az: 'Vacib: yoxlama canlıdır. Təchizatçı qaiməni mal çatmamışdan əvvəl veribsə, qaimə müvəqqəti mübahisəlidir — amma qəbulu rəsmiləşdirən kimi sistem yoxlamanı özü yenidən hesablayır və qaimə bir klik olmadan «uyğundur» olur. Əsaslandırma ilə əl təsdiqi yalnız əsl istisnalar üçün qalır. UBL düyməsi qaiməni beynəlxalq formatda ixrac edir.',
      en: 'Importantly, the match is live. If the supplier invoices before the goods arrive, the invoice is disputed only temporarily — the moment you record the receipt, the system re-runs the match by itself and the invoice turns matched without a single click. Manual approval with a justification remains for genuine exceptions only. The UBL button exports the invoice in the international format.',
      do: async (p, l, h) => { await h.holdUntil(0.35); await h.wheel(160); await h.holdUntil(0.6); await h.hover('.badge[data-tip]', 1500); await h.holdUntil(0.92); } },
  ]},
  'buyer-catalogs': { role: 'buyer', path: '/buyer/catalogs', scenes: [
    { ru: 'Каталоги — согласованные прайс-листы поставщиков, обычно созданные из выигранного тендера.',
      az: 'Kataloqlar — təchizatçıların razılaşdırılmış qiymət siyahıları, adətən udulmuş tenderdən yaradılır.',
      en: 'Catalogs — agreed supplier price lists, usually created from a won tender.' },
    { ru: 'Заказ по каталожной цене создаётся мгновенно, без новой процедуры. Минимальная партия и цены контролируются автоматически.',
      az: 'Kataloq qiyməti ilə sifariş dərhal yaradılır, yeni prosedur olmadan. Minimal partiya və qiymətlər avtomatik yoxlanılır.',
      en: 'An order at the catalog price is created instantly, with no new procedure. The minimum order quantity and prices are enforced automatically.',
      do: (p) => slowScroll(p, 4) },
  ]},
  // Budgets: the section finance actually runs the company from. Every scene performs the
  // thing it is talking about — the beats are fractions of the narration (holdUntil), so
  // the cursor never runs ahead of the voice or freezes waiting for it.
  'buyer-budgets': { role: 'buyer', path: '/buyer/budgets', scenes: [
    { az: 'Büdcələr bölməsi. Burada şirkətin xərc planı yaşayır: hansı şöbənin nə qədər pulu var, nə qədəri artıq öhdəliyə gedib və nə qədəri real olaraq xərclənib. Gəlin yuxarıdan başlayaq — şöbələr üzrə yekun cədvəlindən.',
      do: async (p, l, h) => { await h.scrollTo('h3:text-is("Şöbələr üzrə yekun")'); await h.holdUntil(0.45); await h.moveTo('.card:has(h3:text-is("Şöbələr üzrə yekun")) table'); await h.holdUntil(0.9); } },
    { az: 'Hər sətir bir məsrəf mərkəzidir. «Bütün təşkilat» sətri ümumi tavandır, aşağıdakılar isə ayrı-ayrı şöbələr. Məbləğ sütunu plandır — ilin və ya rübün əvvəlində razılaşdırılmış rəqəm.',
      do: async (p, l, h) => { const rows = p.locator('.card:has(h3:text-is("Şöbələr üzrə yekun")) tbody tr'); await h.moveTo(rows.nth(0)); await h.holdUntil(0.4); await h.moveTo(rows.nth(1)); await h.holdUntil(0.72); await h.moveTo(rows.nth(2)); await h.holdUntil(0.92); } },
    { az: 'İndi ən vacib fərq. Öhdəlik — təsdiqlənmiş, amma hələ sifariş verilməmiş sorğulardır: pul ayrılıb, hələ xərclənməyib. Faktiki isə artıq verilmiş sifarişlərdir. Sistem eyni xərci heç vaxt iki dəfə saymır: sifariş veriləndə məbləğ öhdəlikdən faktikiyə keçir.',
      do: async (p, l, h) => { const r = p.locator('.card:has(h3:text-is("Şöbələr üzrə yekun")) tbody tr').nth(1); await h.moveTo(r.locator('td').nth(2)); await h.holdUntil(0.5); await h.moveTo(r.locator('td').nth(3)); await h.holdUntil(0.95); } },
    { az: 'Ödənilib sütunu ayrıca dayanır — bu, ödənişi tamamlanmış qaimələrdir. Diqqət edin: o, istifadəyə əlavə olunmur. Qaimə artıq faktiki kimi sayılmış sifarişin ödənişidir, toplasaq xərc iki dəfə görünərdi.',
      do: async (p, l, h) => { const r = p.locator('.card:has(h3:text-is("Şöbələr üzrə yekun")) tbody tr').nth(0); await h.moveTo(r.locator('td').nth(4)); await h.holdUntil(0.55); await h.moveTo(r.locator('td').nth(6)); await h.holdUntil(0.92); } },
    { az: 'Yeni büdcə yaratmaq üçün yuxarıdakı formadan istifadə edirik. Əvvəlcə ad veririk — məsələn, marketinq üçün illik büdcə.',
      do: async (p, l, h) => { await h.scrollTo('form input'); await h.holdUntil(0.3); await h.fill(p.locator('form input').nth(0), 'Marketinq 2026'); await h.holdUntil(0.9); } },
    { az: 'Sonra şöbəni seçirik. Boş buraxsanız, büdcə bütün təşkilata aid olur. Konkret şöbə seçəndə isə yalnız həmin şöbənin xərcləri ora yazılır — və şöbə büdcəsi həmişə ümumi büdcədən üstündür.',
      do: async (p, l, h) => { await h.moveTo(p.locator('form select').nth(0)); await h.holdUntil(0.4); await p.locator('form select').nth(0).selectOption({ label: 'IT' }).catch(() => {}); await h.holdUntil(0.95); } },
    { az: 'Dövr — illik, rüblük və ya aylıq. Maliyyəçi çox vaxt rübləri izləyir, ona görə rüblük seçirik: sistem dərhal rüb nömrəsini soruşur və büdcənin tarix aralığını özü hesablayır.',
      do: async (p, l, h) => { await h.moveTo(p.locator('form select').nth(1)); await h.holdUntil(0.35); await p.locator('form select').nth(1).selectOption('QUARTER').catch(() => {}); await h.holdUntil(0.7); await h.moveTo(p.locator('form select').nth(2)); await h.holdUntil(0.95); } },
    { az: 'Məbləği yazırıq və səbəb sahəsini doldururuq. Səbəb təsadüfi deyil: hər məbləğ dəyişikliyi tarixçəyə düşür, ona görə sonradan «plan niyə artıb» sualına cavab həmişə qalır. Formanı təsdiq etmirik — bu, sadəcə nümayişdir.',
      do: async (p, l, h) => { await h.fill(p.locator('form input').nth(2), '12000'); await h.holdUntil(0.55); await h.fill(p.locator('form input').nth(3), 'rüblük plan'); await h.holdUntil(0.95); } },
    { az: 'Aşağıda büdcə hədləri var. Xəbərdarlıq həddi keçiləndə şöbənin məsul şəxsinə bildiriş gedir. Blok həddi isə boşdur — yəni təsdiq heç vaxt dayandırılmır. Doldursanız, həddi aşan sorğunu yalnız administrator yazılı əsaslandırma ilə keçirə bilər.',
      do: async (p, l, h) => { await h.scrollTo('h3:text-is("Büdcə hədləri")'); await h.holdUntil(0.35); await h.moveTo('.card:has(h3:text-is("Büdcə hədləri")) input'); await h.holdUntil(0.65); await h.moveTo('.card:has(h3:text-is("Büdcə hədləri")) select'); await h.holdUntil(0.95); } },
    { az: 'Cədvəldə isə hər büdcə ayrıca sətirdir. Saat düyməsi dəyişikliklər tarixçəsini açır: ilkin plan, sonrakı düzəlişlər, kim və nə üçün etdi. Bu, maliyyəçinin ən çox soruşduğu şeydir.',
      do: async (p, l, h) => { await h.scrollTo('button[data-tip]:has-text("🕘")'); await h.holdUntil(0.3); await h.click('button[data-tip]:has-text("🕘")'); await h.holdUntil(0.75); await h.wheel(150); await h.holdUntil(0.95); } },
    { az: 'Ən aşağıda filtrlər və ixrac var: dövr növü, il və şöbə üzrə süzgəc, sonra isə CSV düyməsi. İxrac ekranda gördüyünüz seçimi olduğu kimi fayla yazır — plan, öhdəlik, faktiki və qalıq sütunları ilə birlikdə.',
      do: async (p, l, h) => { await h.scrollTo('button:has-text("CSV")'); await h.holdUntil(0.35); await h.moveTo(p.locator('select').last()); await h.holdUntil(0.7); await h.moveTo('button:has-text("CSV")'); await h.holdUntil(0.95); } },
  ]},
  'buyer-analytics': { role: 'buyer', path: '/buyer/analytics', scenes: [
    { az: 'Analitika bölməsi. Burada pulun hara getdiyi görünür: aylar üzrə xərc, şöbələr üzrə bölgü, kateqoriyalar, təchizatçılar və büdcənin mənimsənilmə tempi. Yuxarıdakı dörd yekundan başlayaq.',
      do: async (p, l, h) => { await p.waitForSelector('.chart-bar', { timeout: 15000 }); await h.moveTo(p.locator('.card').nth(0)); await h.holdUntil(0.55); await h.moveTo(p.locator('.card').nth(1)); await h.holdUntil(0.92); } },
    { az: 'Diqqət edin: xərc ƏDV-siz, qaimələr isə ƏDV daxil göstərilir. Ona görə ödənilmiş məbləğ bəzən xərcdən böyük görünə bilər — bu, səhv deyil, sadəcə fərqli baza.',
      do: async (p, l, h) => { await h.moveTo(p.locator('.card').nth(2)); await h.holdUntil(0.5); await h.moveTo(p.locator('.card').nth(3)); await h.holdUntil(0.92); } },
    { az: 'Aylıq qrafik son on iki ayı göstərir. Boş aylar sıfırdır, buraxılmış deyil — ona görə trend həqiqətən oxunur. Xərc kimi yalnız qəbul edilmiş sifariş sayılır.',
      do: async (p, l, h) => { await h.scrollTo('.chart'); await h.holdUntil(0.35); await h.moveTo(p.locator('.chart-bar').nth(6)); await h.holdUntil(0.65); await h.moveTo(p.locator('.chart-bar').nth(11)); await h.holdUntil(0.93); } },
    { az: 'İndi ən vacib cədvəl — büdcənin mənimsənilmə tempi. Sual sadədir: şöbə planını çox tez xərcləyirmi?',
      do: async (p, l, h) => { await h.scrollTo('h3:text-is("Büdcənin mənimsənilmə tempi")'); await h.holdUntil(0.45); await h.moveTo('.card:has(h3:text-is("Büdcənin mənimsənilmə tempi")) table'); await h.holdUntil(0.9); } },
    { az: 'Sol tərəfdə şöbə və plan, sonra mənimsənilən faiz. Bunun yanında isə dövrün nə qədərinin keçdiyi. Səksən faiz mayda və səksən faiz noyabrda tamam fərqli hekayələrdir — quru faiz bunu heç vaxt deməz.',
      do: async (p, l, h) => { const t = p.locator('.card:has(h3:text-is("Büdcənin mənimsənilmə tempi")) tbody tr').nth(1); await h.moveTo(t.locator('td').nth(2)); await h.holdUntil(0.5); await h.moveTo(t.locator('td').nth(3)); await h.holdUntil(0.93); } },
    { az: 'Sonuncu sütun — temp: mənimsənilən faizdən keçən vaxtın faizi çıxılır. Müsbət rəqəm o deməkdir ki, şöbə təqvimdən qabaqda xərcləyir. On faizdən çox fərq qırmızı ilə işarələnir — bu, söhbət üçün siqnaldır.',
      do: async (p, l, h) => { const rows = p.locator('.card:has(h3:text-is("Büdcənin mənimsənilmə tempi")) tbody tr'); await h.moveTo(rows.nth(1).locator('td').last()); await h.holdUntil(0.5); await h.moveTo(rows.nth(2).locator('td').last()); await h.holdUntil(0.93); } },
    { az: 'Aşağıda şöbələr üzrə xərc var. Burada bir texniki incəlik gizlənir: bölgü sifarişin öz şöbə sahəsindən oxunur, sorğu zəncirindən yox. Ona görə birbaşa alışlar və kataloq sifarişləri də düzgün şöbəyə düşür.',
      do: async (p, l, h) => { await h.scrollTo('h3:text-is("Şöbələr üzrə xərc")'); await h.holdUntil(0.4); await h.moveTo('.card:has(h3:text-is("Şöbələr üzrə xərc")) .budget-bar'); await h.holdUntil(0.9); } },
    { az: 'Yanında kateqoriyalar üzrə bölgü. Bu, «nə alırıq» sualına cavabdır, şöbə isə «kim xərcləyir» sualına. İki fərqli ölçü, hər ikisi lazımdır.',
      do: async (p, l, h) => { await h.moveTo('.card:has(h3:text-is("Kateqoriyalar üzrə"))'); await h.holdUntil(0.5); await h.moveTo(p.locator('.card:has(h3:text-is("Kateqoriyalar üzrə")) .budget-bar').first()); await h.holdUntil(0.92); } },
    { az: 'Ən aşağıda əsas təchizatçılar: qəbul edilmiş sifarişlərin həcminə görə ilk beşlik və hər biri üzrə sifariş sayı. Bu siyahı danışıqlar üçün faydalıdır — həcm arqumentdir.',
      do: async (p, l, h) => { await h.scrollTo('h3:text-is("Əsas təchizatçılar")'); await h.holdUntil(0.4); await h.moveTo('.card:has(h3:text-is("Əsas təchizatçılar")) tbody tr'); await h.holdUntil(0.9); } },
    { az: 'Bütün rəqəmlər real vaxtda hesablanır və yalnız sizin təşkilatınızın məlumatlarını əhatə edir. Heç bir əl ilə hesabat yığmaq lazım deyil — bölməni açmaq kifayətdir.',
      do: async (p, l, h) => { await h.wheel(-400); await h.holdUntil(0.5); await h.moveTo('.chart'); await h.holdUntil(0.92); } },
  ]},
  'buyer-logistics': { role: 'buyer', path: '/buyer/logistics', scenes: [
    { ru: 'Логистика. Все отгрузки по вашим заказам: перевозчик, трек-номер и события в пути — от передачи перевозчику до доставки. События отмечает поставщик, вы видите картину в реальном времени.',
      az: 'Logistika. Sifarişləriniz üzrə bütün göndərişlər: daşıyıcı, izləmə nömrəsi və yol hadisələri — daşıyıcıya verilmədən çatdırılmayadək. Hadisələri təchizatçı qeyd edir, siz real vaxtda görürsünüz.',
      en: 'Logistics. Every shipment against your orders: carrier, tracking number and in-transit events — from hand-off to the carrier through to delivery. The supplier marks the events; you watch it in real time.',
      do: (p) => slowScroll(p, 3) },
  ]},
  'buyer-suppliers': { role: 'buyer', path: '/buyer/suppliers', scenes: [
    { ru: 'Реестр поставщиков. Приглашение, одобрение или блокировка — только одобренные поставщики получают прямые заказы и каталоги.',
      az: 'Təchizatçı reyestri. Dəvət, təsdiq və ya bloklama — yalnız təsdiqlənmiş təchizatçılar birbaşa sifariş və kataloq alır.',
      en: 'The supplier registry. Invite, approve or block — only approved suppliers get direct orders and catalogs.' },
    { ru: 'По каждому накапливается рейтинг: своевременность поставок, качество и коммуникации. Оценки ставятся по итогам реальных заказов.',
      az: 'Hər biri üçün reytinq toplanır: çatdırılmanın vaxtında olması, keyfiyyət və ünsiyyət. Qiymətlər real sifarişlərin nəticələrinə görə verilir.',
      en: 'Each builds up a scorecard: on-time delivery, quality and communication. Ratings come from the outcomes of real orders.',
      do: (p) => slowScroll(p, 4) },
  ]},
  'buyer-verification': { role: 'buyer', path: '/buyer/verification', scenes: [
    { ru: 'Верификация — проверка поставщика перед допуском к закупкам. Вы открываете кейс, поставщик загружает документы: налоговый номер, лицензии, реквизиты.',
      az: 'Yoxlama — təchizatçının satınalmaya buraxılışdan əvvəl yoxlanması. Siz iş açırsınız, təchizatçı sənədləri yükləyir: vergi nömrəsi, lisenziyalar, rekvizitlər.',
      en: 'Verification — checking a supplier before admitting them to sourcing. You open a case, the supplier uploads documents: tax number, licences, bank details.' },
    { ru: 'Вы проверяете каждый документ и выносите решение. Одобрение автоматически повышает статус поставщика в реестре.',
      az: 'Siz hər sənədi yoxlayıb qərar verirsiniz. Təsdiq təchizatçının reyestrdəki statusunu avtomatik yüksəldir.',
      en: 'You review each document and make a decision. Approval automatically raises the supplier’s status in the registry.',
      do: (p) => slowScroll(p, 3) },
  ]},
  'buyer-settings': { role: 'buyer', path: '/buyer/settings', scenes: [
    { ru: 'Настройки — центр управления организацией. Начнём с пользователей: администратор управляет всем, согласующий утверждает заявки, обычный пользователь их создаёт. Роль меняется прямо в таблице, а новый сотрудник добавляется формой ниже.',
      az: 'Parametrlər — təşkilatın idarəetmə mərkəzi. İstifadəçilərdən başlayaq: administrator hər şeyi idarə edir, təsdiqləyən sifarişləri təsdiqləyir, adi istifadəçi onları yaradır. Rol cədvəldə dəyişdirilir, yeni əməkdaş isə aşağıdakı forma ilə əlavə olunur.',
      en: 'Settings — the organisation’s control centre. Starting with users: the admin manages everything, the approver clears requests, a regular user creates them. Roles change right in the table, and a new colleague is added with the form below.',
      do: async (p, l, h) => { await h.holdUntil(0.3); await h.moveTo('table select, table .badge', 900); await h.holdUntil(0.65); await h.wheel(180); await h.holdUntil(0.92); } },
    { ru: 'Справочник категорий. Единый список нужен, чтобы «АйТи» и «IT» не жили раздельно: по категории срабатывает политика метода, считаются бюджеты и строится аналитика.',
      az: 'Kateqoriya sorğu kitabçası. Vahid siyahı ona görə lazımdır ki, «AyTi» və «IT» ayrı yaşamasın: kateqoriyaya görə metod siyasəti işə düşür, büdcələr hesablanır və analitika qurulur.',
      en: 'The category directory. One list keeps “IT” and “I.T.” from living apart: the category drives the method policy, the budgets and the analytics.',
      do: async (p, l, h) => { await h.scrollTo('.card:nth-of-type(2)'); await h.holdUntil(0.45); await h.moveTo('.card:nth-of-type(2) .badge', 900); await h.holdUntil(0.92); } },
    { ru: 'Политика метода закупки — та самая шкала, по которой система сама решает судьбу утверждённой заявки. Зелёная зона — мелкие суммы, прямой заказ без тендера. Дальше — закрытый тендер с запечатанными ценами. Автор заявки метод не выбирает — это защита от закупок в обход конкуренции.',
      az: 'Satınalma metodu siyasəti — sistemin təsdiqlənmiş sifarişin taleyini özü həll etdiyi həmin şkala. Yaşıl zona — kiçik məbləğlər, tendersiz birbaşa sifariş. Sonra — möhürlü qiymətlərlə qapalı tender. Sifarişin müəllifi metodu seçmir — bu, rəqabətdən yan keçən satınalmalardan qorunmadır.',
      en: 'The procurement-method policy — the very scale by which the system decides an approved request’s fate on its own. The green zone is small amounts: a direct order, no tender. Beyond it — a sealed tender with encrypted prices. The requester never picks the method — that guards against dodging competition.',
      do: async (p, l, h) => {
        await h.scrollTo('h3:has-text("⚖️")');
        await h.holdUntil(0.3);
        const segs = p.locator('.card:nth-of-type(3) > div > div > div');
        const n = Math.min(await segs.count(), 2);
        const beats = [0.6, 0.92];
        for (let i = 0; i < n; i++) { await moveToLoc(p, segs.nth(i), 1100); await h.holdUntil(beats[i] ?? 0.92); }
      } },
    { ru: 'Шкала полностью редактируется: нажимаем «изменить» — и каждый диапазон открыт для правки. Категория, суммы в манатах, метод из списка; кнопкой «плюс диапазон» добавляются новые полосы — например, отдельное правило для строительства. Сейчас ничего не сохраняем — «отмена».',
      az: 'Şkala tam redaktə olunur: «dəyiş» düyməsini basırıq — və hər aralıq düzəlişə açıqdır. Kateqoriya, manatla məbləğlər, siyahıdan metod; «aralıq əlavə et» düyməsi ilə yeni zolaqlar əlavə olunur — məsələn, tikinti üçün ayrıca qayda. İndi heç nə saxlamırıq — «ləğv et».',
      en: 'The scale is fully editable: we click Edit — and every band opens up. Category, amounts in manats, the method from a list; the add-band button creates new bands — say, a separate rule for construction. We save nothing now — Cancel.',
      do: async (p, lang, h) => {
        await h.click('button:has-text("✎")', 1100);
        await h.holdUntil(0.3);
        const inp = p.locator('.card:nth-of-type(3) input[type=number]').first();
        if (await inp.count()) await moveToLoc(p, inp, 900);
        await h.holdUntil(0.5);
        const sel = p.locator('.card:nth-of-type(3) select').first();
        if (await sel.count()) await moveToLoc(p, sel, 900);
        await h.holdUntil(0.72);
        const add = p.locator('.card:nth-of-type(3) button:has-text("+")').last();
        if (await add.count()) await h.click(add, 700);
        await h.holdUntil(0.88);
        await h.click(`.card:nth-of-type(3) button:has-text("${BTN.cancel[lang]}")`, 800);
      } },
    { ru: 'И цепочка согласования: сколько подписей нужно заявке в зависимости от суммы. Готовые схемы показаны карточками, активная отмечена галочкой; переключение — один клик. Один человек не может закрыть два шага одной заявки, а автор — согласовать свою собственную: разделение полномочий встроено в саму систему.',
      az: 'Və təsdiq zənciri: məbləğdən asılı olaraq sifarişə neçə imza lazımdır. Hazır sxemlər kartlarla göstərilib, aktiv olanı işarələnib; keçid — bir klik. Bir nəfər eyni sifarişin iki addımını bağlaya bilməz, müəllif isə özününkünü təsdiqləyə bilməz: səlahiyyətlərin bölünməsi sistemin özünə hörülüb.',
      en: 'And the approval chain: how many sign-offs a request needs depending on its amount. The presets are cards, the active one is ticked; switching is one click. No single person can clear two steps of one request, and the author can never approve their own: segregation of duties is built into the system itself.',
      do: async (p, l, h) => {
        await h.scrollTo('h3:has-text("🖊")');
        await h.holdUntil(0.3);
        const cards = p.locator('[role=button]');
        const n = Math.min(await cards.count(), 3);
        const beats = [0.55, 0.75, 0.94];
        for (let i = 0; i < n; i++) { await moveToLoc(p, cards.nth(i), 950); await h.holdUntil(beats[i] ?? 0.94); }
      } },
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
