#!/usr/bin/env node
// Produces the narrated section-guide videos in ONE synchronized pipeline:
//   1) Azure TTS per SCENE (ru-RU neural voice) — durations measured up front;
//   2) screen recording where each scene's action runs, then the camera HOLDS on that
//      block for exactly as long as its narration — the video is never time-boxed,
//      the story dictates the length;
//   3) ffmpeg mux: scene audios are delayed to their recorded offsets (adelay+amix),
//      video stream copied as-is.
//
// Usage: node scripts/produce-guides.mjs [BASE_URL] [keys…]
//   BASE_URL default http://localhost:8080 (stand filled by scripts/demo-fill.mjs)
//   Env: AZURE_SPEECH_KEY / AZURE_SPEECH_REGION (or Leadprocure/.env),
//        AZURE_SPEECH_VOICE (default ru-RU-SvetlanaNeural)

import { createRequire } from 'module';
import { execSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, existsSync, renameSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = require(join(ROOT, 'apps/web/node_modules/@playwright/test'));
const OUT = join(ROOT, 'apps/web/public/guides');
mkdirSync(OUT, { recursive: true });

const args = process.argv.slice(2);
const BASE = args[0]?.startsWith('http') ? args[0] : 'http://localhost:8080';
const ONLY = (args[0]?.startsWith('http') ? args.slice(1) : args);

if (!process.env.AZURE_SPEECH_KEY && existsSync(join(ROOT, '.env'))) {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^(AZURE_[A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}
const KEY = process.env.AZURE_SPEECH_KEY;
const REGION = process.env.AZURE_SPEECH_REGION;
const VOICE = process.env.AZURE_SPEECH_VOICE ?? 'ru-RU-SvetlanaNeural';
if (!KEY || !REGION) { console.error('Set AZURE_SPEECH_KEY / AZURE_SPEECH_REGION'); process.exit(1); }

const P = (ms) => new Promise((r) => setTimeout(r, ms));
const dur = (f) => parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${f}"`).toString());
async function slowScroll(page, steps = 5, dy = 130, pause = 500) {
  for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, dy); await P(pause); }
}
const scrollTo = async (page, sel) => {
  const el = page.locator(sel).first();
  if (await el.count()) { await el.scrollIntoViewIfNeeded(); await P(700); }
};
const type = async (page, sel, text, delay = 85) => {
  const el = page.locator(sel).first();
  await el.click(); await el.pressSequentially(text, { delay });
};

async function tts(text, out) {
  const ssml = `<speak version='1.0' xml:lang='ru-RU'><voice name='${VOICE}'><prosody rate='+4%'>${text}</prosody></voice></speak>`;
  const res = await fetch(`https://${REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': KEY, 'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-96kbitrate-mono-mp3', 'User-Agent': 'leadprocure-guides',
    },
    body: ssml,
  });
  if (!res.ok) throw new Error(`Azure TTS ${res.status}: ${(await res.text()).slice(0, 160)}`);
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
}

// ---------------- scenes: text + the action the camera performs before the line ----------------
const SECTIONS = {
  'buyer-dashboard': { role: 'buyer', path: '/buyer/dashboard', scenes: [
    { t: 'Рабочий стол закупщика — главная точка входа. Сверху ключевые показатели: объём закупок, экономия на тендерах, активные события, заявки на утверждении и заказы в работе. Все цифры считаются из реальных данных системы.' },
    { t: 'Ниже — задачи. Система сама собирает всё, что требует вашего решения: утвердить заявку, вскрыть ставки, наградить победителя или принять поставку. Стрелка справа ведёт прямо в нужный раздел.',
      do: (p) => scrollTo(p, 'h3, table') },
    { t: 'И уведомления: новые счета, смена статусов заказов, ответы поставщиков. Каждое событие дублируется письмом на электронную почту.',
      do: (p) => slowScroll(p, 4) },
  ]},
  'buyer-requests': { role: 'buyer', path: '/buyer/requests', scenes: [
    { t: 'Раздел «Заявки». Любая закупка начинается здесь — с внутренней потребности компании.' },
    { t: 'Создаём заявку: название, позиции, количество и ориентировочная цена за единицу. Итоговую сумму сервер пересчитает сам — цифрам клиента система не доверяет.',
      do: async (p) => {
        await type(p, 'form > input', 'Ноутбуки для отдела продаж');
        await type(p, '.row > div:nth-child(1) input', 'Ноутбук 15", 16 ГБ');
        await type(p, '.row > div:nth-child(2) input', '10');
        await type(p, '.row > div:nth-child(3) input', '1500');
      } },
    { t: 'Готово — заявка появилась в реестре со статусом «черновик». Отправляем её на утверждение, и у утверждающего появятся кнопки «утвердить» и «отклонить».',
      do: async (p) => { await p.click('form button.btn:not(.ghost):not([type=button])'); await P(900); await scrollTo(p, 'table'); } },
    { t: 'У утверждённой заявки — выбор процедуры. Закрытый тендер RFQ с запечатанными ценами. RFP — цена плюс техническое предложение. RFI — сбор информации без цен. И реверс-аукцион. Мелкие суммы политика компании отправляет напрямую в заказ, без тендера. Строка под поиском расшифровывает каждую кнопку, а при наведении появляется подсказка.',
      do: (p) => slowScroll(p, 5) },
  ]},
  'buyer-events': { role: 'buyer', path: '/buyer/events', scenes: [
    { t: 'Раздел «Тендеры». Здесь все процедуры со статусами: открытые, на оценке и завершённые — и количество поданных ставок по каждой.' },
    { t: 'Откроем завершённый тендер серверного оборудования.',
      do: async (p) => { await p.click('a:has-text("серверное оборудование")'); await p.waitForSelector('h1', { timeout: 15000 }); } },
    { t: 'Позиции тендера — неизменяемый снимок из заявки. При необходимости их делят на лоты, и каждый лот можно наградить своему поставщику.',
      do: (p) => slowScroll(p, 3) },
    { t: 'Ставки. До вскрытия закупщик видит только факт участия — суммы зашифрованы, это принципиально. После вскрытия появляются цены, сроки поставки, взвешенная оценка и награждение. Здесь победил поставщик со ставкой ниже оценки — экономия видна сразу.',
      do: async (p) => { await scrollTo(p, 'h3:has-text("Bids")'); await slowScroll(p, 3); } },
  ]},
  'buyer-contracts': { role: 'buyer', path: '/buyer/contracts', scenes: [
    { t: 'Контракты и заказы. Контракт создаётся из награждённого тендера одним нажатием и фиксирует цены победителя.' },
    { t: 'По контракту выпускаются заказы. Каждый идёт по конвейеру: выпущен, подтверждён, упакован, отгружен, доставлен, принят. Свои шаги двигает каждая из сторон.',
      do: (p) => scrollTo(p, '.card:nth-of-type(2)') },
    { t: 'Нужно изменить уже выпущенный заказ? Кнопка «изменить»: новое количество или цена, причина — и поправка уходит поставщику. Суммы обновятся только после его согласия, а история изменений сохранится навсегда.',
      do: async (p) => {
        const b = p.locator('button:has-text("✎")').first();
        if (await b.count()) {
          await b.click(); await P(700); await scrollTo(p, 'h3:has-text("✎")');
          const q = p.locator('.card:has(h3:has-text("✎")) tbody input').first();
          if (await q.count()) await q.pressSequentially('75', { delay: 110 });
        }
      } },
  ]},
  'buyer-invoices': { role: 'buyer', path: '/buyer/invoices', scenes: [
    { t: 'Счета. Поставщик выставляет счёт по заказу, и система автоматически проводит трёхстороннюю сверку: что заказано, что принято по факту и что выставлено в счёте.' },
    { t: 'Совпало — статус MATCHED: счёт можно утвердить и оплатить. Расхождение в цене или количестве — DISPUTED, с деталями по каждой строке. Кнопка UBL выгружает счёт в международном формате для электронного документооборота.',
      do: (p) => slowScroll(p, 4) },
  ]},
  'buyer-catalogs': { role: 'buyer', path: '/buyer/catalogs', scenes: [
    { t: 'Каталоги — согласованные прайс-листы поставщиков, обычно созданные из выигранного тендера.' },
    { t: 'Заказ по каталожной цене создаётся мгновенно, без новой процедуры. Минимальная партия и согласованные цены контролируются автоматически.',
      do: (p) => slowScroll(p, 4) },
  ]},
  'buyer-budgets': { role: 'buyer', path: '/buyer/budgets', scenes: [
    { t: 'Бюджеты. Задайте лимит расходов на категорию и год — звёздочка означает все категории сразу.' },
    { t: 'Например, отдельный бюджет на транспорт.',
      do: (p) => type(p, 'form input', 'Транспорт 2026') },
    { t: 'Каждая утверждённая заявка расходует свой бюджет. Полоса показывает использование и остаток. При превышении система предупредит прямо в момент утверждения, но окончательное решение оставит за вами.',
      do: async (p) => { await scrollTo(p, '.budget-bar'); await slowScroll(p, 2); } },
  ]},
  'buyer-analytics': { role: 'buyer', path: '/buyer/analytics', scenes: [
    { t: 'Аналитика расходов. Сверху итоги: объём закупок, экономия на тендерах, оплаченные и ожидающие счета.',
      do: (p) => p.waitForSelector('.chart-bar', { timeout: 15000 }) },
    { t: 'График показывает расходы по месяцам. Расходом считается только принятый заказ — не планы и не заявки.' },
    { t: 'Ниже — структура расходов по категориям и топ поставщиков по объёму принятых заказов.',
      do: (p) => slowScroll(p, 4) },
  ]},
  'buyer-logistics': { role: 'buyer', path: '/buyer/logistics', scenes: [
    { t: 'Логистика. Все отгрузки по вашим заказам: перевозчик, трек-номер и события в пути — от передачи перевозчику до доставки. События отмечает поставщик, вы видите картину в реальном времени.',
      do: (p) => slowScroll(p, 3) },
  ]},
  'buyer-suppliers': { role: 'buyer', path: '/buyer/suppliers', scenes: [
    { t: 'Реестр поставщиков. Приглашение, одобрение или блокировка — только одобренные поставщики получают прямые заказы и каталоги.' },
    { t: 'По каждому накапливается рейтинг: своевременность поставок, качество и коммуникации. Оценки ставятся по итогам реальных заказов.',
      do: (p) => slowScroll(p, 4) },
  ]},
  'buyer-verification': { role: 'buyer', path: '/buyer/verification', scenes: [
    { t: 'Верификация — проверка поставщика перед допуском к закупкам. Вы открываете кейс, поставщик загружает документы: налоговый номер, лицензии, банковские реквизиты.' },
    { t: 'Вы проверяете каждый документ и выносите решение. Одобрение автоматически повышает статус поставщика в реестре.',
      do: (p) => slowScroll(p, 3) },
  ]},
  'sup-dashboard': { role: 'sup', path: '/supplier/dashboard', scenes: [
    { t: 'Рабочий стол поставщика. Открытые тендеры, мои ставки, выигранные контракты, заказы в работе и счета — всё на одном экране.' },
    { t: 'В задачах — что требует действий прямо сейчас: подать ставку на новый тендер, продвинуть доставку или выставить счёт по принятому заказу.',
      do: async (p) => { await scrollTo(p, 'table'); await slowScroll(p, 3); } },
  ]},
  'sup-market': { role: 'sup', path: '/supplier/market', scenes: [
    { t: 'Открытые тендеры — те, куда вас пригласил закупщик, и публичные процедуры.' },
    { t: 'Заходим в тендер офисной мебели.',
      do: async (p) => { await p.click('a:has-text("офисная мебель")'); await p.waitForSelector('h1', { timeout: 15000 }); } },
    { t: 'Вводим цену за единицу по каждой позиции — итог считается автоматически. Ставка запечатывается: до вскрытия закупщик не увидит ваших цен. До дедлайна ставку можно отозвать и подать заново.',
      do: async (p) => {
        const price = p.locator('table input[type=number]').first();
        if (await price.count()) { await price.click(); await price.pressSequentially('25.50', { delay: 110 }); }
      } },
    { t: 'Вопросы по тендеру задавайте в разделе вопросов и ответов — ответ закупщика все участники увидят одинаково, это требование равного отношения.',
      do: (p) => slowScroll(p, 4) },
  ]},
  'sup-orders': { role: 'sup', path: '/supplier/orders', scenes: [
    { t: 'Заказы в работе — ваш конвейер поставки. Подтвердите заказ, упакуйте, отгрузите, доставьте: каждый шаг двигается одной кнопкой, а закупщик видит статус в реальном времени.' },
    { t: 'Если закупщик предложил изменение заказа, вы увидите точный расчёт: старое и новое количество, цена и итоговая сумма. Принять или отклонить — решаете только вы. При согласии суммы пересчитаются автоматически.',
      do: async (p) => { const b = p.locator('button:has-text("✎")').first(); if (await b.count()) { await b.click(); await P(600); } } },
    { t: 'Для доставки создайте отгрузку с перевозчиком и трек-номером и отмечайте события в пути.',
      do: async (p) => { const b = p.locator('button[title]:has-text("🚚")').first(); if (await b.count()) { await b.click(); await P(600); } } },
    { t: 'А после доставки выставляйте счёт одним нажатием — он автоматически уйдёт закупщику на трёхстороннюю сверку.' },
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
  console.log(`Voice ${VOICE} (${REGION}) · stand ${BASE} · ${keys.length} sections`);

  // 1) narrate every scene, measure durations
  for (const key of keys) {
    const sec = SECTIONS[key];
    for (let i = 0; i < sec.scenes.length; i++) {
      const f = join(tmp, `${key}-${i}.mp3`);
      await tts(sec.scenes[i].t, f);
      sec.scenes[i].audio = f;
      sec.scenes[i].sec = dur(f);
    }
    console.log(`♪ ${key}: ${sec.scenes.length} scenes, voice ${sec.scenes.reduce((s, x) => s + x.sec, 0).toFixed(1)}s`);
  }

  // 2) record with the camera holding each scene for its narration length
  const browser = await chromium.launch();
  const contexts = {};
  for (const role of ['buyer', 'sup']) {
    if (!keys.some((k) => SECTIONS[k].role === role)) continue;
    contexts[role] = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: tmp, size: { width: 1280, height: 720 } },
    });
    await login(contexts[role], role === 'buyer' ? 'admin@acme.test' : 'seller@supply-one.test');
  }

  const produced = [];
  for (const key of keys) {
    const sec = SECTIONS[key];
    const page = await contexts[sec.role].newPage();
    const t0 = Date.now();
    await page.goto(`${BASE}${sec.path}`);
    await page.waitForSelector('h1', { timeout: 20000 });
    await P(1000);
    await page.screenshot({ path: join(OUT, `${key}.png`) });
    const offsets = [];
    for (const scene of sec.scenes) {
      try { await scene.do?.(page); } catch (e) { console.log(`  (${key}: ${e.message.split('\n')[0]})`); }
      offsets.push(Date.now() - t0 + 250);           // voice starts once the camera is set
      await P(scene.sec * 1000 + 700);               // hold for the narration + a breath
    }
    await P(1200);
    produced.push({ key, video: page.video(), offsets, scenes: sec.scenes });
    await page.close();
    console.log(`✓ ${key} recorded (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
  for (const c of Object.values(contexts)) await c.close();
  await browser.close();

  // 3) mux: delay each scene's audio to its offset, mix, copy the video stream
  for (const { key, video, offsets, scenes } of produced) {
    const src = await video.path();
    const inputs = scenes.map((s) => `-i "${s.audio}"`).join(' ');
    const delays = scenes.map((_, i) => `[${i + 1}:a]adelay=${offsets[i]}:all=1[a${i}]`).join(';');
    const mix = scenes.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${scenes.length}:normalize=0[a]`;
    const out = join(tmp, `${key}.final.webm`);
    execSync(
      `ffmpeg -y -loglevel error -i "${src}" ${inputs} ` +
      `-filter_complex "${delays};${mix}" -map 0:v -map "[a]" -c:v copy -c:a libopus -b:a 64k "${out}"`,
    );
    renameSync(out, join(OUT, `${key}.webm`));
    console.log(`🎬 ${key}.webm (${dur(join(OUT, `${key}.webm`)).toFixed(1)}s)`);
  }
  console.log('\nDone. Rebuild the web container to ship.');
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
