// Throwaway selector probe: log in against the stand, open a section and report which of
// the intended selectors actually exist and are clickable. Run BEFORE writing a scenario —
// a selector that silently misses turns into a frozen scene in the recording.
import { chromium } from '@playwright/test';

const BASE = process.argv[2] ?? 'http://78.47.51.200:8180';
const PATH = process.argv[3] ?? '/buyer/budgets';
const SELECTORS = process.argv.slice(4);

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
await ctx.addInitScript(() => localStorage.setItem('lp_lang', 'az'));
const p = await ctx.newPage();
await p.goto(`${BASE}/login`);
// Supplier sections need the supplier account: PROBE_USER=sup (or a full e-mail).
const USER = process.env.PROBE_USER === 'sup' ? 'seller@supply-one.test'
  : process.env.PROBE_USER || 'admin@acme.test';
await p.fill('input[type=email]', USER);
await p.fill('input[type=password]', 'Passw0rd!');
await p.click('form button.btn:not(.ghost):not([type=button])');
await p.waitForURL(/\/(buyer|supplier)\//, { timeout: 20000 });
await p.goto(`${BASE}${PATH}`);
await p.waitForTimeout(1800);

// A selector prefixed with "!" is clicked instead of reported — several sections only
// reveal what a scene points at after a row is expanded, and a probe that cannot open
// them proves nothing.
for (const raw of SELECTORS) {
  if (raw.startsWith('!')) {
    const sel = raw.slice(1);
    try {
      await p.locator(sel).first().click({ timeout: 5000 });
      await p.waitForTimeout(1200);
      console.log(`⇢  клик  ${sel}`);
    } catch (e) {
      console.log(`✗  клик не прошёл  ${sel}  (${String(e.message).split('\n')[0].slice(0, 60)})`);
    }
    continue;
  }
  const sel = raw;
  const loc = p.locator(sel);
  const n = await loc.count();
  let vis = false;
  try { vis = n > 0 && (await loc.first().isVisible()); } catch { /* noop */ }
  const text = n > 0 ? (await loc.first().innerText().catch(() => '')).slice(0, 42).replace(/\n/g, ' ') : '';
  console.log(`${vis ? '✓' : n ? '·' : '✗'}  ${String(n).padStart(2)}  ${sel}${text ? `   → ${text}` : ''}`);
}
await b.close();
