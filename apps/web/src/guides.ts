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

export interface Track { id: 'BUYER' | 'SUPPLIER'; titleKey: string; lessons: Lesson[] }

export const COURSE: Track[] = [
  {
    id: 'BUYER',
    titleKey: 'learn_track_buyer',
    lessons: [
      { key: 'buyer-settings', titleKey: 'learn_b_settings', to: '/buyer/settings', roles: FINANCE_READ, sec: 238 },
      { key: 'buyer-suppliers', titleKey: 'learn_b_suppliers', to: '/buyer/suppliers', roles: BUYER, sec: 148 },
      { key: 'buyer-verification', titleKey: 'learn_b_verification', to: '/buyer/verification', roles: BUYER, sec: 113 },
      { key: 'buyer-budgets', titleKey: 'learn_b_budgets', to: '/buyer/budgets', roles: FINANCE_READ, sec: 347 },
      { key: 'buyer-requests', titleKey: 'learn_b_requests', to: '/buyer/requests', roles: FINANCE_READ, sec: 109 },
      { key: 'buyer-events', titleKey: 'learn_b_events', to: '/buyer/events', roles: BUYER, sec: 88 },
      // Вскрытие живёт на /buyer/events/:id — у него нет своего маршрута, как и у
      // `sup-auction`, поэтому карта выше ведёт туда `buyer-events`, а эта глава
      // достаётся зрителю по имени, из курса. Переход — к списку тендеров: адреса
      // конкретного вскрытия без id события не существует.
      { key: 'buyer-opening', titleKey: 'learn_b_opening', to: '/buyer/events', roles: BUYER, sec: 105 },
      { key: 'buyer-contracts', titleKey: 'learn_b_contracts', to: '/buyer/contracts', roles: BUYER, sec: 198 },
      { key: 'buyer-logistics', titleKey: 'learn_b_logistics', to: '/buyer/logistics', roles: BUYER, sec: 111 },
      { key: 'buyer-invoices', titleKey: 'learn_b_invoices', to: '/buyer/invoices', roles: BUYER, sec: 204 },
      { key: 'buyer-catalogs', titleKey: 'learn_b_catalogs', to: '/buyer/catalogs', roles: BUYER, sec: 145 },
      { key: 'buyer-analytics', titleKey: 'learn_b_analytics', to: '/buyer/analytics', roles: FINANCE_READ, sec: 253 },
      // Last on purpose, though it is the first page in the rail: a dashboard is a list of
      // what needs attention, and «needs attention» means nothing until you know what the
      // things are. Shown first it reads as noise; shown last it reads as a summary.
      { key: 'buyer-dashboard', titleKey: 'learn_b_dashboard', to: '/buyer/dashboard', roles: FINANCE_READ, sec: 182 },
    ],
  },
  {
    id: 'SUPPLIER',
    titleKey: 'learn_track_supplier',
    lessons: [
      { key: 'sup-verification', titleKey: 'learn_s_verification', to: '/supplier/verification', roles: SUPPLIER, sec: 88 },
      { key: 'sup-market', titleKey: 'learn_s_market', to: '/supplier/market', roles: SUPPLIER, sec: 55 },
      { key: 'sup-bid', titleKey: 'learn_s_bid', to: '/supplier/market', roles: SUPPLIER, sec: 58 },
      // The one recording the product could not show until now. A reverse auction has no
      // route of its own — it lives on /supplier/events/:id, the same path as a sealed
      // tender — so the per-section bar on that page always played `sup-market` and this
      // file sat unreachable (see the note at the top). Played by name from a list, it
      // finally runs. The jump goes to the open tenders, which is where an auction is
      // found; there is no auction URL to send anyone to without an event id.
      { key: 'sup-auction', titleKey: 'learn_s_auction', to: '/supplier/market', roles: SUPPLIER, sec: 104 },
      // Winning is where the supplier's money starts, so the contract comes before the
      // deliveries it pays for — the same place `buyer-contracts` sits in the track above.
      { key: 'sup-contracts', titleKey: 'learn_s_contracts', to: '/supplier/contracts', roles: SUPPLIER, sec: 224 },
      { key: 'sup-orders', titleKey: 'learn_s_orders', to: '/supplier/orders', roles: SUPPLIER, sec: 171 },
      { key: 'sup-invoices', titleKey: 'learn_s_invoices', to: '/supplier/invoices', roles: SUPPLIER, sec: 126 },
      // And last before the panel, for the reason the buyer's catalogue lesson is late too:
      // it is the route AROUND the tender, and it only makes sense once the tender does.
      { key: 'sup-catalogs', titleKey: 'learn_s_catalogs', to: '/supplier/catalogs', roles: SUPPLIER, sec: 140 },
      { key: 'sup-dashboard', titleKey: 'learn_s_dashboard', to: '/supplier/dashboard', roles: SUPPLIER, sec: 119 },
    ],
  },
];

export const COURSE_LESSONS: Lesson[] = COURSE.flatMap((tr) => tr.lessons);
