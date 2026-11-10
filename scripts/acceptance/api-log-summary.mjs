#!/usr/bin/env node
// Сводка по логу api браузерного шага приёмки: сколько запросов, какой маршрут ближе всех к
// своему пределу частоты и каждый ответ не-2xx. Печатается в лог шага, чтобы разбор красного
// прогона начинался с цифр, а не со скачивания артефакта.
//
// ПОЧЕМУ СЧИТАЕТСЯ ПО МАРШРУТАМ, А НЕ ВСЁ ВМЕСТЕ. Предел 300 запросов в минуту
// (`app.module.ts`) выглядит общим, но ведро `@nestjs/throttler` ключуется ОБРАБОТЧИКОМ плюс
// адресом, то есть у каждого маршрута своё. Замерено 10 ноября 2026 на прогоне 42857447484:
// 1869 запросов за 98 секунд, пик 1381 в минуту — и ни одного 429. ВАЖНО про эти два числа:
// они сняты со стенда, который собирал web с `NODE_ENV: test`, то есть отдавал браузеру
// дев-сборку React, где `<React.StrictMode>` вызывает каждый эффект дважды. Починено 11
// ноября 2026 (PR #186), и те же мерки стали меньше: эффектные ручки ровно вдвое, общее число
// запросов на треть (1874 → 1273 на сравнимых прогонах). Довод ниже от этого только крепче —
// предела в 300 на всех нет и при 935 в минуту, — но сами числа читать как исторические.
// Общая цифра про предел не
// говорит ничего, и сводка, сравнивающая её с 300, посылает читателя по ложному следу (первая
// версия этого скрипта так и делала). Сравнивать с пределом можно только маршрут со своим
// ведром.
//
// Когда ведро всё же переполняется, 429 получает любой запрос к ЭТОМУ маршруту, в том числе
// `/auth/refresh` или `/auth/me` при холодной загрузке страницы, — а `AuthProvider` глотает
// любую ошибку начальной загрузки как «не вошёл» и уходит на форму входа без сообщения.
//
// Сводка НИКОГДА не роняет шаг: это свидетельство, а не проверка.

import { readFileSync } from 'node:fs';

// Предел у каждого маршрута свой, и он НЕ один на всех: три маршрута несут `@Throttle` и
// стоят куда ниже умолчания. Сводка, сравнивающая их с 300, врёт ровно там, где важнее всего:
// измерено на прогонах 42857447484 и 42862031424, `POST /auth/login` даёт пик 9 в минуту при
// своём пределе 10 — 90 % ведра, — а против 300 это 3 %, и в пятёрку по абсолютному пику он
// не попадал вовсе. То есть единственный маршрут, реально близкий к отказу, был не показан и
// оценён как спокойный. Замечание из второго разбора PR #182.
//
// Таблица обязана совпадать с `@Throttle` в коде, и это не на совести читателя:
// `throttle-limits.e2e-spec.ts` разбирает контроллеры и роняет проверку, если здесь чего-то
// не хватает или стоит другое число.
const DEFAULT_LIMIT = Number(process.env.THROTTLE_LIMIT ?? 300);
const ROUTE_LIMITS = {
  'POST /auth/login': 10,
  'POST /auth/forgot-password': 5,
  'POST /auth/reset-password': 10,
};
// Слэш на конце снимается: express 4 с `strict: false` отдаёт `/auth/login/` тому же
// обработчику и тому же ведру, а точное совпадение ключа увело бы такую строку на умолчание
// 300 — то есть снова назвало бы спокойным маршрут на пределе.
const limitOf = (handler) => ROUTE_LIMITS[handler.replace(/\/+$/, '')] ?? DEFAULT_LIMIT;
const file = process.argv[2];
if (!file) { console.log('api-log-summary: не передан файл лога'); process.exit(0); }

let raw = '';
try { raw = readFileSync(file, 'utf8'); } catch (e) {
  console.log(`api-log-summary: лог не прочитан (${e.code ?? e.message}) — нечего считать`);
  process.exit(0);
}
raw = raw.replace(/\u001b\[[0-9;]*m/g, '');

// Строка Nest: `[Nest] 123  - 11/10/2026, 12:42:59 PM     LOG [Http] GET /events 200 7ms`
const LINE = /\[Nest\]\s+\d+\s+-\s+\S+,?\s+(\d{1,2}):(\d{2}):(\d{2})\s*([AP]M)?\s+(?:LOG|WARN)\s+\[Http\]\s+(\S+)\s+(\S+)\s+(\d{3})\s+(\d+)ms/;
// Отказы обновить сессию называют причину сами (`identity.service.ts`) — это и есть тот след,
// которого не было. Вытаскиваем их отдельно: по ним отличают гонку ротации от всего прочего.
const WHY = /\[Identity\]\s+(refresh отказан:.*)$/;

const reqs = [];
const refusals = [];
let prev = -1, day = 0;
for (const line of raw.split('\n').map((l) => l.replace(/\r$/, ''))) {
  const w = WHY.exec(line);
  if (w) refusals.push(w[1].trim());
  const m = LINE.exec(line);
  if (!m) continue;
  let h = Number(m[1]);
  if (m[4] === 'PM' && h !== 12) h += 12;
  if (m[4] === 'AM' && h === 12) h = 0;
  const t = h * 3600 + Number(m[2]) * 60 + Number(m[3]);
  if (prev >= 0 && t < prev) day += 86400;  // прогон перешёл через полночь
  prev = t;
  reqs.push({ t: t + day, method: m[5], path: m[6], status: Number(m[7]) });
}

if (!reqs.length) {
  console.log('api-log-summary: ни одной строки запроса в логе.');
  console.log('  Либо HTTP_ACCESS_LOG не дошёл до процесса api, либо браузер до api не дошёл —');
  console.log('  и то и другое само по себе объясняет падение без следа. Разобраться стоит.');
  process.exit(0);
}

const clock = (s) => `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
// Ключ ведра — обработчик, поэтому id в пути схлопываются: иначе каждый тендер считался бы
// своим маршрутом и пик всегда выходил бы единицей.
const handlerOf = (r) => `${r.method} ${r.path
  .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '/:id')
  .replace(/\/\d+(?=\/|$)/g, '/:n')}`;
const peakOf = (times) => {
  let lo = 0, best = 0, at = times[0];
  for (let hi = 0; hi < times.length; hi++) {
    while (times[hi] - times[lo] >= 60) lo++;
    if (hi - lo + 1 > best) { best = hi - lo + 1; at = times[lo]; }
  }
  return { peak: best, at };
};

const byHandler = new Map();
for (const r of reqs) {
  const k = handlerOf(r);
  if (!byHandler.has(k)) byHandler.set(k, []);
  byHandler.get(k).push(r.t);
}
// Сортировка по ДОЛЕ своего ведра, а не по абсолютному пику: 9 входов из 10 важнее 214
// обращений к `/auth/me` из 300, а по абсолютной величине вход не виден вовсе.
// Та цифра про `/auth/me` с 11 ноября 2026 ровно вдвое меньше (100/мин вместо 206), и довод
// от этого только крепче. Она была замерена, когда шаг приёмки собирал web с `NODE_ENV: test`,
// то есть отдавал браузеру дев-сборку React, а в ней `<React.StrictMode>` вызывает каждый
// эффект дважды: на прогоне 42879226779 `/auth/me` шёл по два раза в 168 загрузках из 168.
// Удваивался не он один, а всё, что грузится в эффекте, — поэтому числа этой сводки до того
// дня надо делить по-разному: эффектные ручки ровно на два, общее число запросов на треть
// (1874 → 1273), а доли ручек входа не трогать вовсе — у них свой, низкий предел, и вход
// эффектом не зовётся. Сборку теперь сторожит `apps/web/vite.config.ts`.
const ranked = [...byHandler.entries()]
  .map(([k, ts]) => {
    const limit = limitOf(k);
    const { peak, at } = peakOf(ts);
    return { k, n: ts.length, peak, at, limit, share: peak / limit };
  })
  .sort((a, b) => b.share - a.share);

const refused = reqs.filter((r) => r.status === 429);
const bad = reqs.filter((r) => r.status >= 400 && r.status !== 429);

console.log('── лог api браузерного шага ──────────────────────────────────────────');
console.log(`запросов всего: ${reqs.length}, с ${clock(reqs[0].t)} по ${clock(reqs[reqs.length - 1].t)}`
  + ` (${peakOf(reqs.map((r) => r.t)).peak}/мин в пике — цифра справочная, общего предела нет)`);
console.log(`у каждого маршрута своё ведро (умолчание ${DEFAULT_LIMIT}/мин, у трёх ручек входа ниже);`
  + ' ближе всех к своему пределу:');
for (const h of ranked.slice(0, 5)) {
  const pct = Math.round(h.share * 100);
  const mark = h.peak >= h.limit ? ' ←← СВОЙ ПРЕДЕЛ ИСЧЕРПАН' : pct >= 80 ? ` ←← ${pct} % СВОЕГО ВЕДРА` : ` (${pct} %)`;
  console.log(`  ${String(h.peak).padStart(4)}/мин из ${String(h.limit).padEnd(3)} всего ${String(h.n).padStart(4)}  ${h.k}`
    + `  (окно с ${clock(h.at)})${mark}`);
}
// На проде ведро ключуется ещё и адресом клиента, а адреса в логе нарочно нет — значит доля
// там считается как если бы все запросы пришли с одного адреса, то есть сверху.
if (process.env.THROTTLE_SHARED_IP !== '0') {
  console.log('  (доля считана как с одного адреса: ведро ключуется адресом, а его в логе нет)');
}
console.log(`отказов 429: ${refused.length}${refused.length ? ' ← ограничитель частоты сказал «нет»' : ''}`);
for (const r of refused.slice(0, 20)) console.log(`  429 ${clock(r.t)} ${r.method} ${r.path}`);

console.log(`отказов обновить сессию с названной причиной: ${refusals.length}`);
const whyCount = new Map();
for (const w of refusals) {
  // Текст без идентификаторов — чтобы одинаковые причины сложились в одну строку.
  const k = w.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '…')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '…');
  whyCount.set(k, (whyCount.get(k) ?? 0) + 1);
}
for (const [k, n] of [...whyCount.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ×${n} ${k}`);
if (refusals.some((w) => w.includes('ПОВТОР ОТОЗВАННОГО ТОКЕНА'))) {
  console.log('  ↑ ЭТО гонка ротации refresh-cookie: цепочка отозвана жёстко, начальная загрузка');
  console.log('    получила 401 и ушла на молчащую форму входа. См. docs/prod-release-path.md.');
}

console.log(`прочих не-2xx: ${bad.length}`);
const byPath = new Map();
for (const r of bad) {
  const k = `${r.status} ${handlerOf(r)}`;
  byPath.set(k, (byPath.get(k) ?? 0) + 1);
}
for (const [k, n] of [...byPath.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ×${n} ${k}`);
}
console.log('─────────────────────────────────────────────────────────────────────');
