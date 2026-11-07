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
// Two gaps, both deliberate rather than forgotten:
//  · `sup-auction` is recorded (scripts/produce-guides.mjs has its scenario) but is NOT in
//    the map below and cannot be: a reverse auction lives on the same /supplier/events/:id
//    route as a sealed tender, and this map keys on the route alone, so that route plays
//    `sup-market`. Wiring it needs the bar to choose by the event's own format, not by path.
//  · `/supplier/catalogs` and `/supplier/contracts` are real routes with no entry here, so
//    they show no help line. They render the SAME components as the buyer's pages but
//    without the buyer's controls, so pointing them at `buyer-catalogs` / `buyer-contracts`
//    would hand a supplier a walkthrough of buttons they do not have; covering them properly
//    means two more recordings. Adding a key whose file does not exist gives the player a
//    404, so the entry must land together with the recording, never before it.

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
};

// ── The course behind /learn ────────────────────────────────────────────────────────────
//
// The same eighteen recordings, put in ONE order. The map above answers «what plays on
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
      { key: 'buyer-requests', titleKey: 'learn_b_requests', to: '/buyer/requests', roles: FINANCE_READ, sec: 298 },
      { key: 'buyer-events', titleKey: 'learn_b_events', to: '/buyer/events', roles: BUYER, sec: 328 },
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
      { key: 'sup-market', titleKey: 'learn_s_market', to: '/supplier/market', roles: SUPPLIER, sec: 190 },
      // The one recording the product could not show until now. A reverse auction has no
      // route of its own — it lives on /supplier/events/:id, the same path as a sealed
      // tender — so the per-section bar on that page always played `sup-market` and this
      // file sat unreachable (see the note at the top). Played by name from a list, it
      // finally runs. The jump goes to the open tenders, which is where an auction is
      // found; there is no auction URL to send anyone to without an event id.
      { key: 'sup-auction', titleKey: 'learn_s_auction', to: '/supplier/market', roles: SUPPLIER, sec: 104 },
      { key: 'sup-orders', titleKey: 'learn_s_orders', to: '/supplier/orders', roles: SUPPLIER, sec: 171 },
      { key: 'sup-invoices', titleKey: 'learn_s_invoices', to: '/supplier/invoices', roles: SUPPLIER, sec: 126 },
      { key: 'sup-dashboard', titleKey: 'learn_s_dashboard', to: '/supplier/dashboard', roles: SUPPLIER, sec: 119 },
    ],
  },
];

export const COURSE_LESSONS: Lesson[] = COURSE.flatMap((tr) => tr.lessons);
