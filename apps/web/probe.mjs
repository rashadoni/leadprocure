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
await p.fill('input[type=email]', 'admin@acme.test');
await p.fill('input[type=password]', 'Passw0rd!');
await p.click('form button.btn:not(.ghost):not([type=button])');
await p.waitForURL(/\/(buyer|supplier)\//, { timeout: 20000 });
await p.goto(`${BASE}${PATH}`);
await p.waitForTimeout(1800);

for (const sel of SELECTORS) {
  const loc = p.locator(sel);
  const n = await loc.count();
  let vis = false;
  try { vis = n > 0 && (await loc.first().isVisible()); } catch { /* noop */ }
  const text = n > 0 ? (await loc.first().innerText().catch(() => '')).slice(0, 42).replace(/\n/g, ' ') : '';
  console.log(`${vis ? '✓' : n ? '·' : '✗'}  ${String(n).padStart(2)}  ${sel}${text ? `   → ${text}` : ''}`);
}
await b.close();
