#!/usr/bin/env node
// Adds Microsoft Azure TTS voice-over (ru-RU neural voice) to the section guide videos.
// Requires ffmpeg/ffprobe and Azure Speech credentials in env (or Leadprocure/.env):
//   AZURE_SPEECH_KEY=...        (Cognitive Services Speech key)
//   AZURE_SPEECH_REGION=...     (e.g. westeurope, eastus)
//   AZURE_SPEECH_VOICE=ru-RU-SvetlanaNeural   (optional override, e.g. ru-RU-DmitryNeural)
//
// Usage: node scripts/narrate-guides.mjs [keys…]   (default: all guides)
// The video is padded with its last frame when the narration runs longer; audio is
// padded with silence when shorter. Output replaces apps/web/public/guides/<key>.webm.

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, renameSync, mkdtempSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUIDES = join(ROOT, 'apps/web/public/guides');

// load .env for AZURE_* if not already in the environment
if (!process.env.AZURE_SPEECH_KEY && existsSync(join(ROOT, '.env'))) {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^(AZURE_[A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}
const KEY = process.env.AZURE_SPEECH_KEY;
const REGION = process.env.AZURE_SPEECH_REGION;
const VOICE = process.env.AZURE_SPEECH_VOICE ?? 'ru-RU-SvetlanaNeural';
if (!KEY || !REGION) {
  console.error('Set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION (env or Leadprocure/.env).');
  process.exit(1);
}

// Narration per section — written to roughly match each clip's on-screen action.
const NARRATION = {
  'buyer-dashboard':
    'Рабочий стол закупщика. Сверху — ключевые показатели: объём закупок, экономия на тендерах и активные события. ' +
    'Ниже — задачи, которые ждут вашего решения: утвердить заявку, вскрыть ставки или принять поставку. Стрелка ведёт сразу в нужный раздел.',
  'buyer-requests':
    'Раздел Заявки. Здесь начинается любая закупка. Заполняем название и позиции — количество и ориентировочную цену — и создаём заявку. ' +
    'Черновик отправляется на утверждение, а у утверждённой заявки появляются кнопки запуска тендера, аукциона или прямого заказа. ' +
    'Мелкие суммы политика компании отправляет в прямой заказ автоматически.',
  'buyer-events':
    'Раздел Тендеры. В списке — все процедуры и их статусы. Открываем завершённый тендер: видны позиции, участники и вскрытые ставки. ' +
    'До вскрытия суммы зашифрованы — закупщик видит только факт участия. После — оценка по критериям и награждение победителя.',
  'buyer-contracts':
    'Контракты и заказы. Контракт создаётся из награждённого тендера, по нему выпускаются заказы. ' +
    'Заказ проходит путь от выпуска до приёмки. Кнопка «изменить» открывает поправку: новое количество или цена вступят в силу только после согласия поставщика.',
  'buyer-invoices':
    'Счета поставщиков. Каждый счёт автоматически сверяется с заказом и приёмкой — это трёхсторонняя сверка. ' +
    'Совпало — статус MATCHED, дальше утверждение и оплата. Расхождение — DISPUTED с деталями.',
  'buyer-catalogs':
    'Каталоги — согласованные прайс-листы поставщиков. Заказ по каталожной цене создаётся мгновенно, без нового тендера. Минимальная партия контролируется автоматически.',
  'buyer-budgets':
    'Бюджеты. Задаём лимит на категорию и год. Утверждённые заявки расходуют бюджет, полоса показывает использование. ' +
    'При превышении система предупредит, но не заблокирует — решение остаётся за вами.',
  'buyer-analytics':
    'Аналитика расходов: динамика по месяцам, распределение по категориям и топ поставщиков. ' +
    'Экономия считается как разница между оценкой заявки и выигравшей ставкой.',
  'buyer-logistics':
    'Логистика. Отгрузки по заказам: перевозчик, трек-номер и события в пути, которые отмечает поставщик.',
  'buyer-suppliers':
    'Реестр поставщиков. Приглашение, одобрение, блокировка — и рейтинг по своевременности, качеству и коммуникациям. Только одобренные поставщики получают прямые заказы.',
  'buyer-verification':
    'Верификация поставщика. Он загружает документы — вы проверяете и решаете. Одобрение автоматически открывает поставщику прямые заказы и каталоги.',
  'sup-dashboard':
    'Рабочий стол поставщика: открытые тендеры, мои ставки, заказы в работе и счета. В задачах — всё, что ждёт действий: подать ставку, продвинуть доставку, выставить счёт.',
  'sup-market':
    'Открытые тендеры. Заходим в тендер, вводим цену за единицу — итог считается сам. ' +
    'Ставка запечатывается: закупщик не увидит сумм до вскрытия. До дедлайна её можно отозвать и подать заново.',
  'sup-orders':
    'Заказы в работе — конвейер поставки: подтвердить, упаковать, отгрузить, доставить. Создайте отгрузку с трек-номером. ' +
    'Если закупщик предложил изменение заказа, примите или отклоните его — суммы пересчитаются автоматически. После доставки выставляйте счёт в один клик.',
};

const ffprobeDur = (f) =>
  parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${f}"`).toString());

async function tts(text, out) {
  const ssml = `<speak version='1.0' xml:lang='ru-RU'><voice name='${VOICE}'><prosody rate='+6%'>${text}</prosody></voice></speak>`;
  const res = await fetch(`https://${REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': KEY,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-96kbitrate-mono-mp3',
      'User-Agent': 'leadprocure-guides',
    },
    body: ssml,
  });
  if (!res.ok) throw new Error(`Azure TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
}

(async () => {
  const keys = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(NARRATION);
  const tmp = mkdtempSync(join(tmpdir(), 'narrate-'));
  console.log(`Voice: ${VOICE} (${REGION}) → ${keys.length} clips`);
  for (const key of keys) {
    const video = join(GUIDES, `${key}.webm`);
    if (!existsSync(video) || !NARRATION[key]) { console.log(`- ${key}: skipped`); continue; }
    const audio = join(tmp, `${key}.mp3`);
    await tts(NARRATION[key], audio);
    const dv = ffprobeDur(video);
    const da = ffprobeDur(audio);
    const pad = Math.max(0, da - dv + 0.4);
    const outDur = (Math.max(dv, da) + 0.4).toFixed(2);
    const out = join(tmp, `${key}.out.webm`);
    execSync(
      `ffmpeg -y -loglevel error -i "${video}" -i "${audio}" ` +
      `-filter_complex "[0:v]tpad=stop_mode=clone:stop_duration=${pad.toFixed(2)}[v];[1:a]apad=pad_dur=2[a]" ` +
      `-map "[v]" -map "[a]" -t ${outDur} ` +
      `-c:v libvpx-vp9 -crf 36 -b:v 0 -cpu-used 5 -row-mt 1 -c:a libopus -b:a 64k "${out}"`,
    );
    renameSync(out, video);
    console.log(`✓ ${key}  (video ${dv.toFixed(1)}s, voice ${da.toFixed(1)}s → ${outDur}s)`);
  }
  console.log('\nDone. Rebuild the web container to ship the narrated videos.');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
