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
