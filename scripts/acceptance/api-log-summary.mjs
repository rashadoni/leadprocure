#!/usr/bin/env node
// Сводка по логу api браузерного шага приёмки: сколько запросов, какой пик частоты за минуту
// и каждый ответ не-2xx. Печатается в лог шага, чтобы разбор красного прогона начинался с
// цифр, а не со скачивания артефакта.
//
// ПОЧЕМУ ПИК ЗА МИНУТУ. Глобальный ограничитель частоты — 300 запросов в минуту на адрес
// (`app.module.ts`), и в приёмке весь браузер приходит с одного адреса. Пик рядом с этим
// числом значит, что гейт стоит на собственном пределе: когда ведро переполняется, 429
// получает ЛЮБОЙ запрос, в том числе `/auth/refresh` при холодной загрузке страницы, —
// а SPA читает это как «не вошёл» и уходит на форму входа без единого сообщения.
//
// Сводка НИКОГДА не роняет шаг: это свидетельство, а не проверка.

import { readFileSync } from 'node:fs';

const LIMIT = Number(process.env.THROTTLE_LIMIT ?? 300);
const file = process.argv[2];
if (!file) { console.log('api-log-summary: не передан файл лога'); process.exit(0); }

let raw = '';
try { raw = readFileSync(file, 'utf8'); } catch (e) {
  console.log(`api-log-summary: лог не прочитан (${e.code ?? e.message}) — нечего считать`);
  process.exit(0);
}

// Строка Nest: `[Nest] 123  - 11/10/2026, 12:42:59 PM     LOG [Http] GET /events 200 7ms`
const LINE = /\[Nest\]\s+\d+\s+-\s+\S+,?\s+(\d{1,2}):(\d{2}):(\d{2})\s*([AP]M)?\s+(?:LOG|WARN)\s+\[Http\]\s+(\S+)\s+(\S+)\s+(\d{3})\s+(\d+)ms/;
const reqs = [];
let prev = -1, day = 0;
for (const line of raw.replace(/\u001b\[[0-9;]*m/g, '').split('\n')) {
  const m = LINE.exec(line);
  if (!m) continue;
  let h = Number(m[1]);
  if (m[4] === 'PM' && h !== 12) h += 12;
  if (m[4] === 'AM' && h === 12) h = 0;
  let t = h * 3600 + Number(m[2]) * 60 + Number(m[3]);
  if (prev >= 0 && t < prev) day += 86400;  // прогон перешёл через полночь
  prev = t;
  reqs.push({ t: t + day, method: m[5], path: m[6], status: Number(m[7]), ms: Number(m[8]) });
}

if (!reqs.length) {
  console.log('api-log-summary: ни одной строки запроса в логе.');
  console.log('  Либо HTTP_ACCESS_LOG не дошёл до процесса api, либо браузер до api не дошёл —');
  console.log('  и то и другое само по себе объясняет падение без следа. Разобраться стоит.');
  process.exit(0);
}

// Пик за любое окно в 60 секунд (разрешение лога — секунда, этого довольно).
let peak = 0, peakAt = reqs[0].t, lo = 0;
for (let hi = 0; hi < reqs.length; hi++) {
  while (reqs[hi].t - reqs[lo].t >= 60) lo++;
  if (hi - lo + 1 > peak) { peak = hi - lo + 1; peakAt = reqs[lo].t; }
}
const clock = (s) => new Date((s % 86400) * 1000).toISOString().slice(11, 19);
const refused = reqs.filter((r) => r.status === 429);
const bad = reqs.filter((r) => r.status >= 400 && r.status !== 429);

console.log('── лог api браузерного шага ──────────────────────────────────────────');
console.log(`запросов всего: ${reqs.length}, с ${clock(reqs[0].t)} по ${clock(reqs[reqs.length - 1].t)}`);
console.log(`пик за минуту: ${peak} (окно с ${clock(peakAt)}) при пределе ${LIMIT} запросов/мин на адрес`);
if (peak >= LIMIT) {
  console.log(`  ВНИМАНИЕ: пик достиг предела. Переполненное ведро отвечает 429 на ЛЮБОЙ запрос,`);
  console.log(`  включая /auth/refresh при холодной загрузке, — и браузер уходит на форму входа.`);
} else if (peak >= LIMIT * 0.8) {
  console.log(`  Запас ${LIMIT - peak} запросов (${Math.round((peak / LIMIT) * 100)} % предела) — гейт близко к своему пределу.`);
}
console.log(`отказов 429: ${refused.length}${refused.length ? ' ← ограничитель частоты сказал «нет»' : ''}`);
for (const r of refused.slice(0, 20)) console.log(`  429 ${clock(r.t)} ${r.method} ${r.path}`);
console.log(`прочих не-2xx: ${bad.length}`);
const byPath = new Map();
for (const r of bad) {
  const k = `${r.status} ${r.method} ${r.path}`;
  byPath.set(k, (byPath.get(k) ?? 0) + 1);
}
for (const [k, n] of [...byPath.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ×${n} ${k}`);
}
console.log('─────────────────────────────────────────────────────────────────────');
