#!/usr/bin/env node
// Produces the narrated section-guide videos in THREE languages (az/ru/en), one file per
// language: apps/web/public/guides/<key>.<lang>.webm (+ <key>.<lang>.png poster).
// For each language the UI is rendered in that language (localStorage lp_lang) AND narrated
// by a matching Azure neural voice — the video is never time-boxed, each scene is held for
// exactly its narration length (TTS measured first, then adelay+amix over the recording).
//
// Usage: node scripts/produce-guides.mjs [BASE_URL] [langs=az,ru,en] [keys…]
//   Env: AZURE_SPEECH_KEY / AZURE_SPEECH_REGION (or Leadprocure/.env)
//
// Azerbaijani is why we stay on Azure: az-AZ-BanuNeural exists; Google/Gemini TTS has no
// Azerbaijani coverage.

import { createRequire } from 'module';
import { execSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
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
const LANGS = (rawArgs[0] && /^(az|ru|en)(,(az|ru|en))*$/.test(rawArgs[0])) ? rawArgs.shift().split(',') : ['az', 'ru', 'en'];
const ONLY = rawArgs;

if (!process.env.AZURE_SPEECH_KEY && existsSync(join(ROOT, '.env'))) {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^(AZURE_[A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}
const KEY = process.env.AZURE_SPEECH_KEY, REGION = process.env.AZURE_SPEECH_REGION;
if (!KEY || !REGION) { console.error('Set AZURE_SPEECH_KEY / AZURE_SPEECH_REGION'); process.exit(1); }

const VOICE = { ru: 'ru-RU-SvetlanaNeural', az: 'az-AZ-BanuNeural', en: 'en-US-JennyNeural' };
const XLANG = { ru: 'ru-RU', az: 'az-AZ', en: 'en-US' };

const P = (ms) => new Promise((r) => setTimeout(r, ms));
const dur = (f) => parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${f}"`).toString());
async function slowScroll(page, steps = 5, dy = 130, pause = 500) {
  for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, dy); await P(pause); }
}
const scrollTo = async (page, sel) => { const el = page.locator(sel).first(); if (await el.count()) { await el.scrollIntoViewIfNeeded(); await P(700); } };
const type = async (page, sel, text, delay = 85) => { const el = page.locator(sel).first(); await el.click(); await el.pressSequentially(text, { delay }); };

async function tts(text, lang, out) {
  const ssml = `<speak version='1.0' xml:lang='${XLANG[lang]}'><voice name='${VOICE[lang]}'><prosody rate='+4%'>${text}</prosody></voice></speak>`;
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
      if (attempt < 4) await P(1500 * attempt); // backoff on transient network errors
    }
  }
  throw lastErr;
}

// ---------------- scenes: {ru,az,en} narration + camera action ----------------
const SECTIONS = {
  'buyer-dashboard': { role: 'buyer', path: '/buyer/dashboard', scenes: [
    { ru: 'Рабочий стол закупщика — главная точка входа. Сверху ключевые показатели: объём закупок, экономия на тендерах, активные события и заказы в работе. Все цифры считаются из реальных данных.',
      az: 'Alıcının idarə paneli — əsas giriş nöqtəsi. Yuxarıda əsas göstəricilər: satınalma həcmi, tenderlərdə qənaət, aktiv hadisələr və işdə olan sifarişlər. Bütün rəqəmlər real məlumatlardan hesablanır.',
      en: 'The buyer dashboard — your main entry point. At the top, the key figures: total spend, tender savings, active events and orders in progress. Every number is computed from real data.' },
    { ru: 'Ниже — задачи. Система сама собирает всё, что требует вашего решения: утвердить заявку, вскрыть ставки, наградить победителя или принять поставку.',
      az: 'Aşağıda tapşırıqlar. Sistem qərar tələb edən hər şeyi özü toplayır: sifarişi təsdiqləmək, təklifləri açmaq, qalibi seçmək və ya çatdırılmanı qəbul etmək.',
      en: 'Below are your tasks. The system gathers everything that needs your decision: approve a request, open the bids, award a winner or accept a delivery.',
      do: (p) => scrollTo(p, 'h3, table') },
    { ru: 'И уведомления: новые счета, смена статусов заказов, ответы поставщиков. Каждое событие дублируется письмом на почту.',
      az: 'Və bildirişlər: yeni qaimələr, sifariş statuslarının dəyişməsi, təchizatçı cavabları. Hər hadisə e-poçtla da dublikat olunur.',
      en: 'And notifications: new invoices, order status changes, supplier replies. Every event is also mirrored by email.',
      do: (p) => slowScroll(p, 4) },
  ]},
  'buyer-requests': { role: 'buyer', path: '/buyer/requests', scenes: [
    { ru: 'Раздел «Заявки». Любая закупка начинается здесь — с внутренней потребности компании.',
      az: 'Sifarişlər bölməsi. İstənilən satınalma burada başlayır — şirkətin daxili tələbatından.',
      en: 'The Requests section. Every purchase starts here — with an internal need of the company.' },
    { ru: 'Создаём заявку: название, позиции, количество и ориентировочная цена. Итоговую сумму сервер пересчитает сам — цифрам клиента система не доверяет.',
      az: 'Sifariş yaradırıq: ad, mövqelər, miqdar və təxmini qiymət. Yekun məbləği server özü yenidən hesablayır — müştərinin rəqəmlərinə etibar edilmir.',
      en: 'We create a request: a title, line items, quantity and an estimated unit price. The server recomputes the total itself — it never trusts the client’s numbers.',
      do: async (p) => {
        await type(p, 'form > input', 'Ноутбуки для отдела продаж');
        await type(p, '.row > div:nth-child(1) input', 'Ноутбук 15", 16 ГБ');
        await type(p, '.row > div:nth-child(2) input', '10');
        await type(p, '.row > div:nth-child(3) input', '1500');
      } },
    { ru: 'Готово — заявка в реестре со статусом «черновик». Отправляем на утверждение, и у утверждающего появятся кнопки «утвердить» и «отклонить».',
      az: 'Hazırdır — sifariş reyestrdə «qaralama» statusundadır. Təsdiqə göndəririk və təsdiqləyəndə «təsdiqlə» və «rədd et» düymələri görünəcək.',
      en: 'Done — the request is in the register as a draft. We send it for approval, and the approver gets the approve and reject buttons.',
      do: async (p) => { await p.click('form button.btn:not(.ghost):not([type=button])'); await P(900); await scrollTo(p, 'table'); } },
    { ru: 'У утверждённой заявки — выбор процедуры. Закрытый тендер с запечатанными ценами, RFP с техническим предложением, RFI без цен и реверс-аукцион. Мелкие суммы уходят напрямую в заказ. Строка под поиском расшифровывает каждую кнопку, а при наведении появляется подсказка.',
      az: 'Təsdiqlənmiş sifarişdə prosedur seçimi. Möhürlü qiymətlərlə qapalı tender, texniki təklifli RFP, qiymətsiz RFI və revers-auksion. Kiçik məbləğlər birbaşa sifarişə gedir. Axtarışın altındakı sətir hər düyməni izah edir, üzərinə gətirəndə isə ipucu çıxır.',
      en: 'An approved request offers a choice of procedure: a sealed tender, an RFP with a technical proposal, an RFI without prices, and a reverse auction. Small amounts go straight to a direct order. The line under the search decodes each button, and hovering shows a tooltip.',
      do: (p) => slowScroll(p, 5) },
  ]},
  'buyer-events': { role: 'buyer', path: '/buyer/events', scenes: [
    { ru: 'Раздел «Тендеры». Все процедуры со статусами — наведите на статус, и он объяснит себя — и количество поданных ставок по каждой.',
      az: 'Tenderlər bölməsi. Bütün prosedurlar statuslarla — statusun üzərinə gətirin, o özünü izah edəcək — və hər biri üzrə verilmiş təkliflərin sayı.',
      en: 'The Tenders section. All procedures with their statuses — hover a status and it explains itself — and the number of bids on each.' },
    { ru: 'Откроем завершённый тендер серверного оборудования.',
      az: 'Server avadanlığının başa çatmış tenderini açaq.',
      en: 'Let’s open the completed server-hardware tender.',
      do: async (p) => { await p.click('a:has-text("серверное оборудование")'); await p.waitForSelector('h1', { timeout: 15000 }); } },
    { ru: 'Позиции тендера — неизменяемый снимок из заявки. При необходимости их делят на лоты, и каждый лот можно наградить своему поставщику.',
      az: 'Tenderin mövqeləri — sifarişdən dəyişməz görüntüdür. Lazım olarsa, lotlara bölünür və hər lot öz təchizatçısına verilə bilər.',
      en: 'The tender items are an immutable snapshot of the request. They can be split into lots, and each lot awarded to its own supplier.',
      do: (p) => slowScroll(p, 3) },
    { ru: 'Ставки. До вскрытия закупщик видит только факт участия — суммы зашифрованы. После вскрытия появляются цены, сроки, взвешенная оценка и награждение. Здесь победил поставщик со ставкой ниже оценки — экономия видна сразу.',
      az: 'Təkliflər. Açılışa qədər alıcı yalnız iştirak faktını görür — məbləğlər şifrələnib. Açılışdan sonra qiymətlər, müddətlər, çəkili qiymətləndirmə və qalib seçimi görünür. Burada təxmindən aşağı təkliflə təchizatçı qalib gəldi — qənaət dərhal görünür.',
      en: 'The bids. Before opening, the buyer sees only that a supplier took part — the amounts are encrypted. After opening come the prices, lead times, the weighted score and the award. Here the winner bid below the estimate — the saving is visible at once.',
      do: async (p) => { await scrollTo(p, 'h3:has-text("Bids")'); await slowScroll(p, 3); } },
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
    { ru: 'Совпало — статус MATCHED: счёт можно утвердить и оплатить. Расхождение — DISPUTED, с деталями по каждой строке. Кнопка UBL выгружает счёт в международном формате.',
      az: 'Uyğun gəldi — MATCHED statusu: qaiməni təsdiqləyib ödəmək olar. Uyğunsuzluq — DISPUTED, hər sətir üzrə təfərrüatla. UBL düyməsi qaiməni beynəlxalq formatda ixrac edir.',
      en: 'A match gives the MATCHED status: the invoice can be approved and paid. A discrepancy is DISPUTED, with details per line. The UBL button exports the invoice in an international format.',
      do: (p) => slowScroll(p, 4) },
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
  'buyer-budgets': { role: 'buyer', path: '/buyer/budgets', scenes: [
    { ru: 'Бюджеты. Задайте лимит расходов на категорию и год — звёздочка означает все категории.',
      az: 'Büdcələr. Kateqoriya və il üzrə xərc limiti təyin edin — ulduz bütün kateqoriyaları bildirir.',
      en: 'Budgets. Set a spending limit per category and year — a star means all categories.' },
    { ru: 'Например, отдельный бюджет на транспорт.',
      az: 'Məsələn, nəqliyyat üçün ayrıca büdcə.',
      en: 'For example, a separate budget for transport.',
      do: (p) => type(p, 'form input', 'Транспорт 2026') },
    { ru: 'Каждая утверждённая заявка расходует свой бюджет. Полоса показывает использование и остаток. При превышении система предупредит в момент утверждения, но решение оставит за вами.',
      az: 'Hər təsdiqlənmiş sifariş öz büdcəsini xərcləyir. Zolaq istifadəni və qalığı göstərir. Aşarkən sistem təsdiq anında xəbərdarlıq edir, amma qərarı sizə buraxır.',
      en: 'Every approved request draws down its budget. The bar shows usage and what’s left. If it goes over, the system warns you at approval time, but leaves the decision to you.',
      do: async (p) => { await scrollTo(p, '.budget-bar'); await slowScroll(p, 2); } },
  ]},
  'buyer-analytics': { role: 'buyer', path: '/buyer/analytics', scenes: [
    { ru: 'Аналитика расходов. Сверху итоги: объём закупок, экономия на тендерах, оплаченные и ожидающие счета.',
      az: 'Xərc analitikası. Yuxarıda yekunlar: satınalma həcmi, tenderlərdə qənaət, ödənilmiş və gözləyən qaimələr.',
      en: 'Spend analytics. At the top, the totals: total spend, tender savings, paid and outstanding invoices.',
      do: (p) => p.waitForSelector('.chart-bar', { timeout: 15000 }) },
    { ru: 'График показывает расходы по месяцам. Расходом считается только принятый заказ — не планы и не заявки.',
      az: 'Qrafik xərcləri aylar üzrə göstərir. Xərc yalnız qəbul edilmiş sifariş sayılır — plan və ya sifariş yox.',
      en: 'The chart shows spend by month. Only an accepted order counts as spend — not plans, not requests.' },
    { ru: 'Ниже — структура расходов по категориям и топ поставщиков по объёму принятых заказов.',
      az: 'Aşağıda — kateqoriyalar üzrə xərc strukturu və qəbul edilmiş sifarişlər üzrə əsas təchizatçılar.',
      en: 'Below — the breakdown of spend by category and the top suppliers by accepted-order volume.',
      do: (p) => slowScroll(p, 4) },
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
    { ru: 'Открытые тендеры — те, куда вас пригласил закупщик, и публичные процедуры.',
      az: 'Açıq tenderlər — alıcının sizi dəvət etdiyi və açıq prosedurlar.',
      en: 'Open tenders — the ones the buyer invited you to, plus public procedures.' },
    { ru: 'Заходим в тендер офисной мебели.',
      az: 'Ofis mebeli tenderinə keçirik.',
      en: 'Let’s open the office-furniture tender.',
      do: async (p) => { await p.click('a:has-text("офисная мебель")'); await p.waitForSelector('h1', { timeout: 15000 }); } },
    { ru: 'Вводим цену за единицу по каждой позиции — итог считается сам. Ставка запечатывается: до вскрытия закупщик не увидит ваших цен. До дедлайна ставку можно отозвать и подать заново.',
      az: 'Hər mövqe üzrə vahid qiymət daxil edirik — yekun özü hesablanır. Təklif möhürlənir: açılışa qədər alıcı qiymətlərinizi görməyəcək. Son tarixədək təklifi geri götürüb yenidən vermək olar.',
      en: 'We enter a unit price for each item — the total adds up on its own. The bid is sealed: until opening the buyer won’t see your prices. Before the deadline you can withdraw and resubmit.',
      do: async (p) => { const price = p.locator('table input[type=number]').first(); if (await price.count()) { await price.click(); await price.pressSequentially('25.50', { delay: 110 }); } } },
    { ru: 'Вопросы по тендеру задавайте в разделе вопросов и ответов — ответ закупщика все участники увидят одинаково, это требование равного отношения.',
      az: 'Tenderlə bağlı sualları suallar və cavablar bölməsində verin — alıcının cavabını bütün iştirakçılar eyni cür görür, bu bərabər münasibət tələbidir.',
      en: 'Ask questions in the questions-and-answers area — the buyer’s reply is shown to every participant equally; that’s the equal-treatment rule.',
      do: (p) => slowScroll(p, 4) },
  ]},
  'sup-orders': { role: 'sup', path: '/supplier/orders', scenes: [
    { ru: 'Заказы в работе — ваш конвейер поставки. Подтвердите заказ, упакуйте, отгрузите, доставьте: каждый шаг двигается одной кнопкой, а закупщик видит статус в реальном времени.',
      az: 'İşdə olan sifarişlər — sizin çatdırılma konveyeriniz. Sifarişi təsdiqləyin, qablaşdırın, göndərin, çatdırın: hər addım bir düymə ilə, alıcı isə statusu real vaxtda görür.',
      en: 'Orders in progress — your delivery pipeline. Confirm the order, pack, ship, deliver: each step moves with one button, and the buyer sees the status in real time.' },
    { ru: 'Если закупщик предложил изменение заказа, вы увидите точный расчёт: старое и новое количество, цена и итоговая сумма. Принять или отклонить — решаете вы. При согласии суммы пересчитаются автоматически.',
      az: 'Əgər alıcı sifarişin dəyişməsini təklif edibsə, dəqiq hesablamanı görəcəksiniz: köhnə və yeni miqdar, qiymət və yekun məbləğ. Qəbul və ya rədd — siz qərar verirsiniz. Razılıqda məbləğlər avtomatik yenilənir.',
      en: 'If the buyer proposed a change to the order, you’ll see the exact figures: old and new quantity, price and the resulting total. Accept or reject — that’s your call. On acceptance the amounts recompute automatically.',
      do: async (p) => { const b = p.locator('button:has-text("✎")').first(); if (await b.count()) { await b.click(); await P(600); } } },
    { ru: 'Для доставки создайте отгрузку с перевозчиком и трек-номером и отмечайте события в пути.',
      az: 'Çatdırılma üçün daşıyıcı və izləmə nömrəsi ilə göndəriş yaradın və yol hadisələrini qeyd edin.',
      en: 'For delivery, create a shipment with a carrier and tracking number, and mark the events along the way.',
      do: async (p) => { const b = p.locator('button[title]:has-text("🚚")').first(); if (await b.count()) { await b.click(); await P(600); } } },
    { ru: 'А после доставки выставляйте счёт одним нажатием — он автоматически уйдёт закупщику на трёхстороннюю сверку.',
      az: 'Çatdırılmadan sonra isə qaiməni bir kliklə verin — o, avtomatik olaraq üçtərəfli yoxlama üçün alıcıya gedəcək.',
      en: 'And after delivery, raise the invoice in one click — it goes to the buyer automatically for the three-way match.' },
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
    console.log(`\n=== ${lang} (${VOICE[lang]}) · ${todo.length}/${keys.length} to do ===`);
    // 1) narrate every scene in this language, measure durations
    for (const key of todo) {
      for (let i = 0; i < SECTIONS[key].scenes.length; i++) {
        const f = join(tmp, `${key}-${lang}-${i}.mp3`);
        await tts(SECTIONS[key].scenes[i][lang], lang, f);
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
        await page.screenshot({ path: join(OUT, `${key}.${lang}.png`) });
        const offsets = [];
        for (const scene of sec.scenes) {
          try { await scene.do?.(page); } catch (e) { console.log(`  (${key}/${lang}: ${e.message.split('\n')[0]})`); }
          offsets.push(Date.now() - t0 + 250);
          await P(scene.sec * 1000 + 700);
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
