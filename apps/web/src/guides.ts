import { BUYER, FINANCE_READ, SUPPLIER } from './roles';

// Per-section help videos. One screen recording per section, produced by
// `node scripts/produce-guides.mjs` into /public/guides/<key>.az.webm (+ .png poster).
//
// Recordings are Azerbaijani only: the narration is cloud TTS on a metered quota, and one
// well-paced track that every user can follow beats three that drift apart as the UI moves.
// The bar in components/Guide.tsx therefore always loads the .az asset, whatever the
// interface language. Settled by the owner on 2026-11-01, with the two leftover
// buyer-settings .ru/.en files deleted — nothing had ever loaded them.
//
// One gap is left, and it is deliberate rather than forgotten:
//  · `sup-auction` is recorded (scripts/produce-guides.mjs has its scenario) but is NOT in
//    the map below and cannot be: a reverse auction lives on the same /supplier/events/:id
//    route as a sealed tender, and this map keys on the route alone, so that route plays
//    `sup-market`. Wiring it needs the bar to choose by the event's own format, not by path.
//    The course below reaches it by NAME, which is how it finally gets watched at all.
//
// `/supplier/catalogs` and `/supplier/contracts` were the other gap until 2026-11-07: real
// routes with no entry here, so no help line at all. They render the SAME components as the
// buyer's pages but without the buyer's controls, so pointing them at `buyer-catalogs` /
// `buyer-contracts` would have handed a supplier a walkthrough of buttons he does not have —
// covering them properly meant two more recordings, and `sup-catalogs` / `sup-contracts` are
// those two. The rule that kept them out still holds for anything new: adding a key whose
// file does not exist gives the player a 404, so the entry lands together with the
// recording, never before it.

export interface SectionGuide { key: string }

const g = (key: string): SectionGuide => ({ key });

export const GUIDES: Record<string, SectionGuide> = {
  '/buyer/dashboard': g('buyer-dashboard'),
  '/buyer/requests': g('buyer-requests'),
  '/buyer/events': g('buyer-events'),
  // the detail page reuses the section recording — the tender walkthrough covers both
  '/buyer/events/': g('buyer-events'),
  '/buyer/contracts': g('buyer-contracts'),
  '/buyer/invoices': g('buyer-invoices'),
  '/buyer/catalogs': g('buyer-catalogs'),
  '/buyer/budgets': g('buyer-budgets'),
  '/buyer/analytics': g('buyer-analytics'),
  '/buyer/logistics': g('buyer-logistics'),
  '/buyer/suppliers': g('buyer-suppliers'),
  '/buyer/verification': g('buyer-verification'),
  '/buyer/settings': g('buyer-settings'),
  '/supplier/dashboard': g('sup-dashboard'),
  '/supplier/market': g('sup-market'),
  '/supplier/events/': g('sup-market'),
  '/supplier/orders': g('sup-orders'),
  '/supplier/invoices': g('sup-invoices'),
  '/supplier/verification': g('sup-verification'),
  '/supplier/catalogs': g('sup-catalogs'),
  '/supplier/contracts': g('sup-contracts'),
};

// Route → the i18n key the sidebar already uses for that section, so the help card is
// headed by the section's own name in the active language without a second set of strings.
export const SECTION_TITLE_KEY: Record<string, string> = {
  '/buyer/dashboard': 'dashboard',
  '/buyer/requests': 'requests',
  '/buyer/events': 'events',
  '/buyer/events/': 'events',
  '/buyer/contracts': 'contracts',
  '/buyer/invoices': 'invoices',
  '/buyer/catalogs': 'catalogs',
  '/buyer/budgets': 'budgets',
  '/buyer/analytics': 'analytics',
  '/buyer/logistics': 'logistics',
  '/buyer/suppliers': 'suppliers',
  '/buyer/verification': 'verification',
  '/buyer/settings': 'settings',
  '/supplier/dashboard': 'dashboard',
  '/supplier/market': 'market',
  '/supplier/events/': 'events',
  '/supplier/orders': 'my_orders',
  '/supplier/invoices': 'invoices',
  '/supplier/verification': 'verification',
  '/supplier/catalogs': 'catalogs',
  '/supplier/contracts': 'contracts',
};

// ── The course behind /learn ────────────────────────────────────────────────────────────
//
// Every one of those recordings, put in ONE order. The map above answers «what plays on
// this page»; this answers «in what order does a newcomer watch everything», and they are
// different questions — the order here follows the money, not the menu: who may spend,
// whom we buy from, how much is planned, the request, the tender, the contract, delivery,
// the invoice, and only then the reports that read it all back. The rail cannot express
// that, because a rail is a list of places, not a path.
//
// `sec` is each recording's real length, measured with ffprobe against the files in
// public/guides on 2026-11-07. It is shown so a reader can plan the hour, and the totals
// on screen are summed from here rather than written out, so one number cannot disagree
// with the other. Re-measure after re-recording:
//   for f in apps/web/public/guides/*.az.webm; do
//     ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$f"; done
// The recorder no longer trusts anyone to remember that: scripts/produce-guides.mjs probes
// every file it has just produced and REFUSES the run when the length here is more than a
// couple of seconds away from it. Nothing else would ever notice a truncated re-recording —
// the poster is still there, the video still answers 200, every suite stays green — and the
// only one who finds out that the promised minutes are not the ones that play is a viewer.
//
// `to` is the section the lesson is about, and `roles` is copied from NOTHING — it is the
// same array the router guards that path with (src/roles.ts), so the «go to the section»
// button cannot offer a door the route will shut. A lesson whose subject has no section of
// its own carries no `to` at all.
export interface Lesson {
  key: string;
  /** i18n key for the lesson's own title — the course needs shorter words than the rail. */
  titleKey: string;
  to?: string;
  roles?: string[];
  sec: number;
}

export interface Track { id: 'STORY' | 'BUYER' | 'SUPPLIER'; titleKey: string; lessons: Lesson[] }

export const COURSE: Track[] = [
  // ПЕРВЫЙ трек — сквозная история: одна закупка от заявки до оплаты, тринадцать глав на
  // ОДНИХ данных. Каждая запись продолжает предыдущую: заявка, которую завёл сотрудник,
  // становится тендером, тендер — двумя запечатанными ставками, ставки — присуждением,
  // договором, заказом, отгрузкой, приёмкой, счётом и платежом. Поэтому порядок здесь не
  // «как удобнее объяснять», а «как это произошло», и обе стороны идут вперемешку: после
  // приглашения смотрят глазами поставщика, после ставок — снова глазами закупщика.
  //
  // Оба трека видны всем (см. Learn.tsx), и это ровно то, что история требует: закупщику
  // полезно знать, что видит поставщик, а поставщику — откуда у закупщика берётся тендер.
  {
    id: 'STORY',
    titleKey: 'learn_track_story',
    lessons: [
      // 108, а не измеренная длина последней записи: у этой главы длина ПЛАВАЕТ. Четвёртая
      // сцена набирает шесть полей формы, и набор идёт дольше своей озвучки — насколько
      // именно, решает загрузка машины в момент съёмки. Замеры: 106,0 с ночью 10.11 и
      // 109,6 с утром того же дня, одна и та же сцена и тот же текст. 108 держит оба конца
      // в допуске ±2 с, которым съёмщик проверяет это число. Если очередной прогон снова
      // выйдет за допуск — запись не обрезана, это та же сцена; лечится она не числом, а
      // тем, чтобы набор перестал обгонять озвучку.
      { key: 'buyer-requests', titleKey: 'learn_b_requests', to: '/buyer/requests', roles: FINANCE_READ, sec: 107 },
      { key: 'buyer-events', titleKey: 'learn_b_events', to: '/buyer/events', roles: BUYER, sec: 88 },
      { key: 'sup-market', titleKey: 'learn_s_market', to: '/supplier/market', roles: SUPPLIER, sec: 55 },
      { key: 'sup-bid', titleKey: 'learn_s_bid', to: '/supplier/market', roles: SUPPLIER, sec: 56 },
      // Вскрытие живёт на /buyer/events/:id — своего маршрута у него нет, как и у
      // `sup-auction`, поэтому карта маршрутов ведёт туда `buyer-events`, а эта глава
      // достаётся зрителю по имени, отсюда. Переход — к списку тендеров: адреса
      // конкретного вскрытия без id события не существует.
      { key: 'buyer-opening', titleKey: 'learn_b_opening', to: '/buyer/events', roles: BUYER, sec: 105 },
      { key: 'buyer-contracts', titleKey: 'learn_b_contracts', to: '/buyer/contracts', roles: BUYER, sec: 64 },
      { key: 'sup-orders', titleKey: 'learn_s_orders', to: '/supplier/orders', roles: SUPPLIER, sec: 57 },
      { key: 'buyer-logistics', titleKey: 'learn_b_logistics', to: '/buyer/logistics', roles: BUYER, sec: 52 },
      { key: 'sup-invoices', titleKey: 'learn_s_invoices', to: '/supplier/invoices', roles: SUPPLIER, sec: 44 },
      { key: 'buyer-invoices', titleKey: 'learn_b_invoices', to: '/buyer/invoices', roles: BUYER, sec: 57 },
      { key: 'buyer-budgets', titleKey: 'learn_b_budgets', to: '/buyer/budgets', roles: FINANCE_READ, sec: 96 },
      { key: 'buyer-analytics', titleKey: 'learn_b_analytics', to: '/buyer/analytics', roles: FINANCE_READ, sec: 85 },
      // Последней — и это та же причина, по которой она была последней раньше: панель
      // показывает, что требует внимания, а «требует внимания» ничего не значит, пока не
      // знаешь, что это за вещи. В истории она закрывает круг: тот же новый сотрудник
      // открывает её и видит, чем кончилась его заявка.
      { key: 'buyer-dashboard', titleKey: 'learn_b_dashboard', to: '/buyer/dashboard', roles: FINANCE_READ, sec: 82 },
    ],
  },
  // Разделы «про устройство»: они не на пути одной закупки, но на её данных. Реестр
  // поставщиков открывают, когда в нём уже кто-то есть; каталог делают из договора,
  // который история подписала; параметры объясняют, почему всё предыдущее произошло
  // именно так, — поэтому они идут ПОСЛЕ истории, а не перед ней.
  {
    id: 'BUYER',
    titleKey: 'learn_track_buyer',
    lessons: [
      { key: 'buyer-suppliers', titleKey: 'learn_b_suppliers', to: '/buyer/suppliers', roles: BUYER, sec: 87 },
      { key: 'buyer-verification', titleKey: 'learn_b_verification', to: '/buyer/verification', roles: BUYER, sec: 59 },
      { key: 'buyer-catalogs', titleKey: 'learn_b_catalogs', to: '/buyer/catalogs', roles: BUYER, sec: 69 },
      { key: 'buyer-settings', titleKey: 'learn_b_settings', to: '/buyer/settings', roles: FINANCE_READ, sec: 116 },
    ],
  },
  {
    id: 'SUPPLIER',
    titleKey: 'learn_track_supplier',
    lessons: [
      { key: 'sup-verification', titleKey: 'learn_s_verification', to: '/supplier/verification', roles: SUPPLIER, sec: 51 },
      { key: 'sup-catalogs', titleKey: 'learn_s_catalogs', to: '/supplier/catalogs', roles: SUPPLIER, sec: 36 },
      { key: 'sup-contracts', titleKey: 'learn_s_contracts', to: '/supplier/contracts', roles: SUPPLIER, sec: 45 },
      { key: 'sup-dashboard', titleKey: 'learn_s_dashboard', to: '/supplier/dashboard', roles: SUPPLIER, sec: 55 },
      // Живые торги — вторая, короткая история: своя заявка, своё утверждение, своя
      // процедура. Она стоит последней, потому что аукцион понятен только тому, кто уже
      // видел обычный тендер и знает, чем они отличаются.
      // 120 — измерено на выложенной записи. У этой главы длина ПЛАВАЕТ так же, как у
      // «Заявок», и по той же причине: её сцены делают переходы между страницами, а они
      // идут то быстрее, то медленнее. Замеры одного дня: 123,9 с и 120,1 с на одном и том
      // же сценарии. Допуск ±2 с обе крайности не держит, поэтому здесь стоит число
      // ПОСЛЕДНЕЙ съёмки — то есть того файла, который лежит рядом; если очередной прогон
      // снова выйдет за допуск, съёмщик об этом скажет, и число надо поправить, а не
      // искать поломку.
      { key: 'sup-auction', titleKey: 'learn_s_auction', to: '/supplier/market', roles: SUPPLIER, sec: 120 },
    ],
  },
];

export const COURSE_LESSONS: Lesson[] = COURSE.flatMap((tr) => tr.lessons);
