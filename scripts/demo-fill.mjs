#!/usr/bin/env node
// Fills a Leadprocure stand with a full demo story through the REAL API flows:
//   A. полный цикл: заявка → RFQ → 2 ставки → вскрытие → оценка → награждение
//      → контракт → заказ → доставка → приёмка → счёт → оплата
//   B. открытый тендер (идёт сейчас, есть ставка)
//   C. RFI (запрос информации, есть ответ)
//   D. реверс-аукцион (идёт сейчас)
//   E. заявки в статусах DRAFT и SUBMITTED
//   F. прямой заказ с ожидающей поправкой (change order)
//   + бюджеты, каталог с заказом, верификация, Q&A
//
// Usage:  node scripts/demo-fill.mjs [API_URL]
//   API_URL default http://localhost:3000
//   DEMO_PG_CONTAINER (default leadprocure-prod-postgres-1) — used only to nudge the
//   story-A deadline via `docker exec psql`; if unavailable, story A stays OPEN.

import { execSync } from 'child_process';

const API = process.argv[2] ?? 'http://localhost:3000';
const PG = process.env.DEMO_PG_CONTAINER ?? 'leadprocure-prod-postgres-1';
const PASS = 'Passw0rd!';
const DAY = 24 * 3600_000;
const LANG = process.env.DEMO_LANG ?? 'ru'; // seed the story content in this language

// All visible story strings per language, so a re-seed produces az/ru/en demo data — the
// video guides then show lists in the same language as the narration.
const TXT = {
  ru: {
    srvReq: 'Серверное оборудование для ЦОД', srvEv: 'Тендер: серверное оборудование', srvItem1: 'Сервер 2U, 64 ГБ RAM', srvItem2: 'Коммутатор 48 портов',
    furnReq: 'Офисная мебель — 2 этаж', furnEv: 'Тендер: офисная мебель', furnItem1: 'Кресло офисное', furnItem2: 'Стол письменный',
    logiReq: 'Исследование: складская логистика', logiEv: 'RFI: складская логистика', logiItem: 'Складские услуги — возможности рынка',
    logiProposal: 'Склад 5000 м² в Хырдалане, WMS-система, 12 собственных фур, температурные зоны. Работаем по всему Азербайджану.',
    fuelReq: 'Дизельное топливо, опт', fuelEv: 'Аукцион: дизельное топливо', fuelItem: 'Дизельное топливо, л',
    wearDraft: 'Спецодежда для склада (черновик)', wearItem: 'Комплект спецодежды',
    roofReq: 'Ремонт кровли склада №2', roofItem: 'Ремонт кровли, м²',
    houseReq: 'Хозтовары для офиса', houseItem: 'Бумага А4, пачка',
    amendReason: 'Увеличиваем объём: открылся второй офис',
    budgetAll: 'Общий бюджет', budgetIT: 'IT-бюджет',
    catNames: { IT: 'ИТ и техника', OFFICE: 'Офис и хозтовары', CONSTRUCTION: 'Строительство и ремонт', FUEL: 'Топливо', LOGISTICS: 'Логистика и склад' },
    catTitle: 'Офисные расходники — Supply One', catItem1: 'Бумага А4 80г', catItem2: 'Тонер HP 26A', uomReam: 'пачка', uomPcs: 'шт',
    qnaQ: 'Допускается ли поставка кресел партиями по 10 штук?', qnaA: 'Да, партиями допускается, полный объём — до конца месяца.',
    justification: 'Лучшее соотношение цена/срок по взвешенной оценке',
  },
  az: {
    srvReq: 'Data mərkəzi üçün server avadanlığı', srvEv: 'Tender: server avadanlığı', srvItem1: 'Server 2U, 64 GB RAM', srvItem2: 'Kommutator 48 port',
    furnReq: 'Ofis mebeli — 2-ci mərtəbə', furnEv: 'Tender: ofis mebeli', furnItem1: 'Ofis kreslosu', furnItem2: 'Yazı masası',
    logiReq: 'Araşdırma: anbar logistikası', logiEv: 'RFI: anbar logistikası', logiItem: 'Anbar xidmətləri — bazar imkanları',
    logiProposal: 'Xırdalanda 5000 m² anbar, WMS sistemi, 12 öz yük maşını, temperatur zonaları. Bütün Azərbaycan üzrə işləyirik.',
    fuelReq: 'Dizel yanacağı, topdan', fuelEv: 'Auksion: dizel yanacağı', fuelItem: 'Dizel yanacağı, litr',
    wearDraft: 'Anbar üçün xüsusi geyim (qaralama)', wearItem: 'Xüsusi geyim dəsti',
    roofReq: 'Anbar №2 damının təmiri', roofItem: 'Dam təmiri, m²',
    houseReq: 'Ofis üçün təsərrüfat malları', houseItem: 'A4 kağız, top',
    amendReason: 'Həcmi artırırıq: ikinci ofis açıldı',
    budgetAll: 'Ümumi büdcə', budgetIT: 'IT büdcəsi',
    catNames: { IT: 'İT və texnika', OFFICE: 'Ofis və təsərrüfat', CONSTRUCTION: 'Tikinti və təmir', FUEL: 'Yanacaq', LOGISTICS: 'Logistika və anbar' },
    catTitle: 'Ofis sərfiyyatı — Supply One', catItem1: 'A4 kağız 80q', catItem2: 'Toner HP 26A', uomReam: 'top', uomPcs: 'ədəd',
    qnaQ: 'Kresloları 10 ədədlik partiyalarla çatdırmaq olarmı?', qnaA: 'Bəli, partiyalarla olar, tam həcm — ay sonuna qədər.',
    justification: 'Çəkili qiymətləndirmə üzrə ən yaxşı qiymət/müddət nisbəti',
  },
  en: {
    srvReq: 'Server hardware for the data center', srvEv: 'Tender: server hardware', srvItem1: 'Server 2U, 64 GB RAM', srvItem2: '48-port switch',
    furnReq: 'Office furniture — 2nd floor', furnEv: 'Tender: office furniture', furnItem1: 'Office chair', furnItem2: 'Writing desk',
    logiReq: 'Study: warehouse logistics', logiEv: 'RFI: warehouse logistics', logiItem: 'Warehousing services — market options',
    logiProposal: '5000 m² warehouse in Khirdalan, a WMS system, 12 owned trucks, temperature zones. We operate across Azerbaijan.',
    fuelReq: 'Diesel fuel, wholesale', fuelEv: 'Auction: diesel fuel', fuelItem: 'Diesel fuel, liter',
    wearDraft: 'Warehouse workwear (draft)', wearItem: 'Workwear set',
    roofReq: 'Warehouse #2 roof repair', roofItem: 'Roof repair, m²',
    houseReq: 'Office household supplies', houseItem: 'A4 paper, ream',
    amendReason: 'Increasing volume: a second office opened',
    budgetAll: 'Overall budget', budgetIT: 'IT budget',
    catNames: { IT: 'IT & hardware', OFFICE: 'Office & supplies', CONSTRUCTION: 'Construction & repair', FUEL: 'Fuel', LOGISTICS: 'Logistics & warehouse' },
    catTitle: 'Office consumables — Supply One', catItem1: 'A4 paper 80g', catItem2: 'Toner HP 26A', uomReam: 'ream', uomPcs: 'pcs',
    qnaQ: 'May the chairs be delivered in batches of 10?', qnaA: 'Yes, batches are allowed; the full volume by month-end.',
    justification: 'Best price / lead-time ratio by the weighted score',
  },
};
const T = TXT[LANG] ?? TXT.ru;

// Wipe the story data (keeping orgs/users/policies) so each language re-seeds cleanly.
// Runs as the DB owner via the PG container — bypasses RLS; audit_events is left intact.
function resetStory() {
  try {
    execSync(
      `docker exec ${PG} psql -U leadprocure_owner -d leadprocure -c ` +
      `"TRUNCATE procurement_requests, budgets, catalogs, supplier_verification_cases, notifications, document_counters, procurement_categories RESTART IDENTITY CASCADE;"`,
      { stdio: 'pipe' },
    );
    console.log(`✓ story data reset (lang=${LANG})`);
  } catch (e) {
    console.log(`  ! reset failed (${e.message.split('\n')[0]})`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, path, token, body) {
  // Retry on 429: back-to-back reseeds (az/ru/en) can trip the login throttler.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (res.status === 429 && attempt < 6) { await sleep(2000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return text; }
  }
}
const get = (p, t) => call('GET', p, t);
const post = (p, t, b = {}) => call('POST', p, t, b);
const put = (p, t, b) => call('PUT', p, t, b);
// tolerate "already exists" so re-running the filler on a populated stand doesn't abort
const postIdempotent = async (p, t, b = {}) => {
  try { return await post(p, t, b); }
  catch (e) { if (/→ 409/.test(e.message)) return null; throw e; }
};

const login = async (email) => (await post('/auth/login', undefined, { email, password: PASS })).accessToken;

function nudgeClose(eventId) {
  try {
    execSync(
      `docker exec ${PG} psql -U leadprocure_owner -d leadprocure -c "UPDATE sourcing_events SET close_at = now() - interval '1 second' WHERE id='${eventId}'; SELECT * FROM close_due_events();"`,
      { stdio: 'pipe' },
    );
    return true;
  } catch (e) {
    console.log(`  ! deadline nudge failed (${e.message.split('\n')[0]}) — tender stays OPEN`);
    return false;
  }
}

const log = (s) => console.log(s);

(async () => {
  log(`Filling demo data via ${API}`);
  const buyer = await login('admin@acme.test');
  const approver = await login('approver@acme.test'); // SoD: approves what admin creates
  const sup1 = await login('seller@supply-one.test');
  const sup2 = await login('seller@baku-metal.test');
  if (process.env.DEMO_RESET) resetStory();

  // find the two seed suppliers in the global directory, invite if not yet related,
  // then approve both so direct orders/catalogs work
  const directory = await get('/suppliers/directory', buyer);
  const findOrg = (name) =>
    directory.find((o) => (o.legal_name ?? o.name ?? '').includes(name))?.id ??
    directory.find((o) => (o.legal_name ?? o.name ?? '').includes(name))?.org_id;
  const org1 = findOrg('Supply One');
  const org2 = findOrg('Baku Metal');
  if (!org1 || !org2) throw new Error('Seed suppliers not found — run `pnpm --filter api seed` first');

  for (const org of [org1, org2]) {
    const reg = await get('/suppliers', buyer);
    let rel = reg.find((r) => r.supplier_org_id === org);
    if (!rel) {
      await post(`/suppliers/${org}/invite`, buyer);
      rel = (await get('/suppliers', buyer)).find((r) => r.supplier_org_id === org);
    }
    if (rel.status !== 'APPROVED') await post(`/suppliers/relationships/${rel.id}/status`, buyer, { status: 'APPROVED' });
  }
  // method policy: до 500 AZN — прямой заказ, выше — тендер
  await put('/requests/method-policies', buyer, {
    policies: [
      { category: '*', minAmountMinor: 0, maxAmountMinor: 50_000, method: 'DIRECT' },
      { category: '*', minAmountMinor: 50_000, maxAmountMinor: null, method: 'RFQ' },
    ],
  });

  // Curated category directory (Settings) — the shared vocabulary the method policy,
  // budgets and analytics key off. Idempotent: 409 on an existing code is fine.
  for (const [code, name] of Object.entries(T.catNames)) {
    await postIdempotent('/categories', buyer, { code, name });
  }
  // Pin a deterministic single-step approval chain so the story's requests reach
  // APPROVED with one approver click, regardless of whatever multi-step chain the
  // stand happens to carry (otherwise submit→approve leaves them SUBMITTED and
  // /events/from-request 400s "Request must be APPROVED").
  await put('/requests/approval-policies', buyer, {
    policies: [{ minAmountMinor: 0, maxAmountMinor: null, steps: [{ order: 1, role: 'BUYER_APPROVER' }] }],
  });
  log('✓ suppliers approved, method + single-step approval policy set');

  const mkApprovedRequest = async (title, category, items) => {
    const r = await post('/requests', buyer, { title, category, items });
    await post(`/requests/${r.id}/submit`, buyer);
    await post(`/requests/${r.id}/approve`, approver);
    return r.id;
  };
  const mkEvent = async (reqId, title, type, closeAt, invite = [org1, org2]) => {
    const ev = await post(`/events/from-request/${reqId}`, buyer, { title, closeAt, visibility: 'INVITED', type });
    for (const org of invite) await post(`/events/${ev.id}/invite`, buyer, { supplierOrgId: org });
    await post(`/events/${ev.id}/publish`, buyer);
    return ev.id;
  };

  // ---------- A. Полный цикл до оплаты ----------
  const reqA = await mkApprovedRequest(T.srvReq, 'IT', [
    { name: T.srvItem1, qty: 4, estUnitPriceMinor: 1_200_000 },
    { name: T.srvItem2, qty: 2, estUnitPriceMinor: 450_000 },
  ]);
  const evA = await mkEvent(reqA, T.srvEv, 'RFQ', new Date(Date.now() + 3600_000).toISOString());
  const evAdet = await get(`/events/${evA}`, sup1);
  const itemsA = evAdet.items;
  await post(`/events/${evA}/bid`, sup1, {
    items: [
      { eventItemId: itemsA[0].id, unitPriceMinor: 1_080_000 },
      { eventItemId: itemsA[1].id, unitPriceMinor: 415_000 },
    ], deliveryDays: 21,
  });
  await post(`/events/${evA}/bid`, sup2, {
    items: [
      { eventItemId: itemsA[0].id, unitPriceMinor: 1_150_000 },
      { eventItemId: itemsA[1].id, unitPriceMinor: 430_000 },
    ], deliveryDays: 14,
  });
  log('✓ A: тендер опубликован, обе ставки поданы (запечатаны)');

  if (nudgeClose(evA)) {
    const opened = await post(`/events/${evA}/open`, buyer);
    const bids = opened.bids.filter((b) => b.state === 'OPENED');
    await post(`/events/${evA}/evaluate`, buyer, {
      scores: bids.flatMap((b) => [
        { bidId: b.id, key: 'price', score: b.supplier_name.includes('Supply One') ? 95 : 82 },
        { bidId: b.id, key: 'delivery', score: b.supplier_name.includes('Supply One') ? 75 : 90 },
      ]),
    });
    const best = bids.find((b) => b.supplier_name.includes('Supply One'));
    const lot = opened.lots[0];
    await post(`/events/${evA}/award`, buyer, { lotId: lot.id, bidId: best.id, justification: T.justification });
    const award = (await get(`/events/${evA}`, buyer)).awards[0];
    const contract = await post(`/contracts/from-award/${award.id}`, buyer);
    await post(`/contracts/${contract.id}/activate`, buyer);
    const po = await post(`/contracts/${contract.id}/orders`, buyer);
    await post(`/orders/${po.id}/status`, buyer, { status: 'ISSUED' });
    for (const s of ['CONFIRMED', 'PACKED', 'SHIPPED']) await post(`/orders/${po.id}/status`, sup1, { status: s });
    await post(`/logistics/po/${po.id}/shipment`, sup1, { carrier: 'AzərPost', trackingNo: 'AZ50012345', origin: 'Bakı', destination: 'Sumqayıt' });
    await post(`/logistics/po/${po.id}/events`, sup1, { status: 'IN_TRANSIT', location: 'Bakı' });
    await post(`/orders/${po.id}/status`, sup1, { status: 'DELIVERED' });
    const poDet = await get(`/orders/${po.id}`, buyer);
    await post(`/orders/${po.id}/receipts`, buyer, { items: poDet.items.map((i) => ({ poItemId: i.id, qty: Number(i.qty) })) });
    const inv = await post(`/invoices/from-po/${po.id}`, sup1, {
      items: poDet.items.map((i) => ({ poItemId: i.id, qty: Number(i.qty), unitPriceMinor: Number(i.unit_price_minor) })),
    });
    await post(`/invoices/${inv.id}/approve`, buyer);
    await post(`/invoices/${inv.id}/pay`, buyer);
    log('✓ A: вскрытие → оценка → награждение → контракт → заказ → доставка → приёмка → счёт ОПЛАЧЕН');
  }

  // ---------- B. Открытый тендер (идёт сейчас) ----------
  const reqB = await mkApprovedRequest(T.furnReq, 'OFFICE', [
    { name: T.furnItem1, qty: 25, estUnitPriceMinor: 28_000 },
    { name: T.furnItem2, qty: 25, estUnitPriceMinor: 35_000 },
  ]);
  const evB = await mkEvent(reqB, T.furnEv, 'RFQ', new Date(Date.now() + 7 * DAY).toISOString());
  const itemsB = (await get(`/events/${evB}`, sup1)).items;
  await post(`/events/${evB}/bid`, sup1, {
    items: itemsB.map((i) => ({ eventItemId: i.id, unitPriceMinor: Math.round(Number(i.est_unit_price_minor) * 0.93) })),
    deliveryDays: 10,
  });
  // Q&A на открытом тендере
  await post(`/events/${evB}/qna`, sup2, { question: T.qnaQ });
  const qna = await get(`/events/${evB}/qna`, buyer);
  await post(`/events/${evB}/qna/${qna[0].id}/answer`, buyer, { answer: T.qnaA });
  log('✓ B: открытый тендер с одной ставкой и Q&A');

  // ---------- C. RFI ----------
  const reqC = await mkApprovedRequest(T.logiReq, 'LOGISTICS', [
    { name: T.logiItem, qty: 1, estUnitPriceMinor: 10_000_000 },
  ]);
  const evC = await mkEvent(reqC, T.logiEv, 'RFI', new Date(Date.now() + 7 * DAY).toISOString());
  await post(`/events/${evC}/bid`, sup2, {
    proposalText: T.logiProposal,
  });
  log('✓ C: RFI опубликован, есть запечатанный ответ');

  // ---------- D. Реверс-аукцион ----------
  const reqD = await mkApprovedRequest(T.fuelReq, 'FUEL', [
    { name: T.fuelItem, qty: 20000, estUnitPriceMinor: 160 },
  ]);
  const evD = await post(`/events/reverse/from-request/${reqD}`, buyer, {
    title: T.fuelEv,
    closeAt: new Date(Date.now() + 7 * DAY).toISOString(),
    visibility: 'INVITED',
    startPriceMinor: 3_200_000,
    minDecrementMinor: 32_000,
  });
  for (const org of [org1, org2]) await post(`/events/${evD.id}/invite`, buyer, { supplierOrgId: org });
  await post(`/events/${evD.id}/publish`, buyer);
  const itemsD = (await get(`/events/${evD.id}`, sup1)).items;
  await post(`/events/${evD.id}/auction/bids`, sup1, { items: [{ eventItemId: itemsD[0].id, unitPriceMinor: 156 }] });
  log('✓ D: реверс-аукцион идёт, первая ставка сделана');

  // ---------- E. Заявки в работе ----------
  await post('/requests', buyer, {
    title: T.wearDraft, category: 'OFFICE',
    items: [{ name: T.wearItem, qty: 30, estUnitPriceMinor: 12_000 }],
  });
  const reqE = await post('/requests', buyer, {
    title: T.roofReq, category: 'CONSTRUCTION',
    items: [{ name: T.roofItem, qty: 800, estUnitPriceMinor: 4_500 }],
  });
  await post(`/requests/${reqE.id}/submit`, buyer);
  log('✓ E: заявки в статусах DRAFT и SUBMITTED (ждёт утверждения)');

  // ---------- F. Прямой заказ с ожидающей поправкой ----------
  const reqF = await mkApprovedRequest(T.houseReq, 'OFFICE', [
    { name: T.houseItem, qty: 40, estUnitPriceMinor: 700 },
  ]);
  const poF = await post(`/orders/direct/from-request/${reqF}`, buyer, { supplierOrgId: org1 });
  await post(`/orders/${poF.id}/status`, buyer, { status: 'ISSUED' });
  await post(`/orders/${poF.id}/amendments`, buyer, {
    reason: T.amendReason,
    items: [{ poItemId: poF.items[0].id, qty: 60 }],
  });
  log('✓ F: прямой заказ выпущен, поправка ждёт решения поставщика');

  // ---------- Бюджеты ----------
  const year = new Date().getFullYear();
  await postIdempotent('/budgets', buyer, { name: `${T.budgetAll} ${year}`, category: '*', periodYear: year, amountMinor: 20_000_000 });
  await postIdempotent('/budgets', buyer, { name: `${T.budgetIT} ${year}`, category: 'IT', periodYear: year, amountMinor: 8_000_000 });
  log('✓ бюджеты созданы (использование посчитается из утверждённых заявок)');

  // ---------- Каталог + мгновенный заказ ----------
  const cat = await post('/catalogs', buyer, { supplierOrgId: org1, title: T.catTitle });
  await post(`/catalogs/${cat.id}/items`, buyer, { name: T.catItem1, uom: T.uomReam, unitPriceMinor: 650, moq: 10 });
  await post(`/catalogs/${cat.id}/items`, buyer, { name: T.catItem2, uom: T.uomPcs, unitPriceMinor: 9_500, moq: 1 });
  await post(`/catalogs/${cat.id}/activate`, buyer);
  const catDet = await get(`/catalogs/${cat.id}`, buyer);
  await post(`/catalogs/${cat.id}/order`, buyer, { items: [{ catalogItemId: catDet.items[0].id, qty: 20 }] });
  log('✓ каталог активен, сделан мгновенный заказ по каталожной цене');

  // ---------- Верификация ----------
  await post('/verification/cases', buyer, { supplierOrgId: org2 });
  log('✓ открыт кейс верификации Baku Metal (ждёт документов поставщика)');

  log('\nDemo data ready 🎉  Открывайте портал и идите по туру из docs/DEMO.md');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
