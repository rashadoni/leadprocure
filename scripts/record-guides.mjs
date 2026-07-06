#!/usr/bin/env node
// Records the per-section guide videos (webm + poster png) against a RUNNING stand with
// demo data (scripts/demo-fill.mjs). Output → apps/web/public/guides/.
//   node scripts/record-guides.mjs [BASE_URL]     (default http://localhost:8080)
//
// Pacing: unhurried. Each clip scrolls and opens things slowly, and MIN_MS keeps the
// footage at least as long as its narration (scripts/narrate-guides.mjs), so the voice
// plays over live UI — not a frozen last frame.
//
// One browser context PER ROLE (recordVideo makes one video per page; refresh-token
// rotation stays sequential inside a shared cookie jar — a static storageState reused
// across contexts would trip the token-reuse breach detection, by design).

import { createRequire } from 'module';
import { mkdirSync, copyFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { chromium } = require(join(dirname(fileURLToPath(import.meta.url)), '../apps/web/node_modules/@playwright/test'));

const BASE = process.argv[2] ?? 'http://localhost:8080';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '../apps/web/public/guides');
mkdirSync(OUT, { recursive: true });

// minimum clip length per key (ms) ≈ narration length + a breath
const MIN_MS = {
  'buyer-dashboard': 22000, 'buyer-requests': 28000, 'buyer-events': 24000,
  'buyer-contracts': 21000, 'buyer-invoices': 18000, 'buyer-catalogs': 15000,
  'buyer-budgets': 19000, 'buyer-analytics': 14000, 'buyer-logistics': 11000,
  'buyer-suppliers': 16000, 'buyer-verification': 14000,
  'sup-dashboard': 15000, 'sup-market': 18000, 'sup-orders': 23000,
};

const P = (ms) => new Promise((r) => setTimeout(r, ms));

// smooth incremental scrolling so the footage reads like a human browsing
async function slowScroll(page, steps = 6, dy = 120, pause = 450) {
  for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, dy); await P(pause); }
}
const scrollTo = async (page, sel, settle = 1800) => {
  const el = page.locator(sel).first();
  if (await el.count()) { await el.scrollIntoViewIfNeeded(); await P(settle); }
};
const type = async (page, sel, text, delay = 80) => {
  const el = page.locator(sel).first();
  await el.click(); await el.pressSequentially(text, { delay });
};

async function roleContext(browser, email) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', 'Passw0rd!');
  await page.click('form button.btn:not(.ghost):not([type=button])');
  await page.waitForURL(/\/(buyer|supplier)\//, { timeout: 20000 });
  await page.close(); // login clip discarded later (no key)
  return ctx;
}

const clips = []; // { key, video }

async function record(ctx, key, path, actions) {
  const started = Date.now();
  const page = await ctx.newPage();
  await page.goto(`${BASE}${path}`);
  await page.waitForSelector('h1', { timeout: 20000 });
  await P(1800);
  await page.screenshot({ path: join(OUT, `${key}.png`) });
  try { await actions?.(page); } catch (e) { console.log(`  (${key}: action skipped — ${e.message.split('\n')[0]})`); }
  // hold the shot until the clip is at least as long as its narration
  const remain = (MIN_MS[key] ?? 15000) - (Date.now() - started);
  if (remain > 0) await P(remain);
  await P(800);
  clips.push({ key, video: page.video() });
  await page.close();
  console.log(`✓ ${key}  (${Math.round((Date.now() - started) / 1000)}s)`);
}

(async () => {
  console.log(`Recording guides from ${BASE} → ${OUT}`);
  const browser = await chromium.launch();

  const buyer = await roleContext(browser, 'admin@acme.test');

  await record(buyer, 'buyer-dashboard', '/buyer/dashboard', async (page) => {
    await P(2500);                                   // KPI cards
    await scrollTo(page, 'h3, table', 2200);         // tasks
    await slowScroll(page, 4);                       // notifications
    await P(1500);
  });

  await record(buyer, 'buyer-requests', '/buyer/requests', async (page) => {
    await type(page, 'form > input', 'Ноутбуки для отдела продаж');
    await type(page, '.row > div:nth-child(1) input', 'Ноутбук 15", 16 ГБ');
    await type(page, '.row > div:nth-child(2) input', '10');
    await type(page, '.row > div:nth-child(3) input', '1500');
    await P(1200);
    await page.click('form button.btn:not(.ghost):not([type=button])');
    await P(2000);
    await scrollTo(page, 'table', 1500);
    await slowScroll(page, 5);                       // walk the statuses + buttons
    await P(1500);
  });

  await record(buyer, 'buyer-events', '/buyer/events', async (page) => {
    await P(2200);                                   // list with statuses
    await page.click('a:has-text("серверное оборудование")');
    await page.waitForSelector('h1', { timeout: 15000 });
    await P(2500);                                   // header, type + status badges
    await slowScroll(page, 4);                       // items/lots
    await scrollTo(page, 'h3:has-text("Bids")', 2500);
    await slowScroll(page, 4);                       // opened bids, scores, award
    await P(1500);
  });

  await record(buyer, 'buyer-contracts', '/buyer/contracts', async (page) => {
    await P(2200);                                   // contracts table
    await scrollTo(page, '.card:nth-of-type(2)', 2200); // orders
    const amend = page.locator('button:has-text("✎")').first();
    if (await amend.count()) {
      await amend.click(); await P(1500);
      await scrollTo(page, 'h3:has-text("✎")', 1500);
      const q = page.locator('.card:has(h3:has-text("✎")) tbody input').first();
      if (await q.count()) await q.pressSequentially('75', { delay: 120 });
      await P(2500);                                 // linger on the amendment form
    }
  });

  await record(buyer, 'buyer-invoices', '/buyer/invoices', async (page) => {
    await P(2500);
    await scrollTo(page, 'table', 2000);
    await slowScroll(page, 4);                       // statuses: MATCHED / PAID
    await P(1500);
  });

  await record(buyer, 'buyer-catalogs', '/buyer/catalogs', async (page) => {
    await P(2500);
    await slowScroll(page, 5);                       // items, prices, MOQ
    await P(1500);
  });

  await record(buyer, 'buyer-budgets', '/buyer/budgets', async (page) => {
    await P(1500);
    await type(page, 'form input', 'Транспорт 2026');
    await P(1200);
    await scrollTo(page, '.budget-bar', 2500);       // utilization bars
    await slowScroll(page, 3);
    await P(1500);
  });

  await record(buyer, 'buyer-analytics', '/buyer/analytics', async (page) => {
    await page.waitForSelector('.chart-bar', { timeout: 15000 });
    await P(2500);                                   // KPI + monthly chart
    await slowScroll(page, 4);                       // categories + top suppliers
    await P(1500);
  });

  await record(buyer, 'buyer-logistics', '/buyer/logistics', async (page) => {
    await P(2500); await slowScroll(page, 4); await P(1200);
  });

  await record(buyer, 'buyer-suppliers', '/buyer/suppliers', async (page) => {
    await P(2500); await slowScroll(page, 5); await P(1500);
  });

  await record(buyer, 'buyer-verification', '/buyer/verification', async (page) => {
    await P(2500); await slowScroll(page, 4); await P(1200);
  });
  await buyer.close();

  const sup = await roleContext(browser, 'seller@supply-one.test');

  await record(sup, 'sup-dashboard', '/supplier/dashboard', async (page) => {
    await P(2500); await scrollTo(page, 'table', 2200); await slowScroll(page, 3); await P(1200);
  });

  await record(sup, 'sup-market', '/supplier/market', async (page) => {
    await P(2200);                                   // open tenders list
    await page.click('a:has-text("офисная мебель")');
    await page.waitForSelector('h1', { timeout: 15000 });
    await P(2200);
    const price = page.locator('table input[type=number]').first();
    if (await price.count()) { await price.click(); await price.pressSequentially('25.50', { delay: 120 }); }
    await P(1500);
    await scrollTo(page, '.hint', 1800);             // 🔒 amounts-sealed note
    await slowScroll(page, 3);                       // Q&A card
    await P(1500);
  });

  await record(sup, 'sup-orders', '/supplier/orders', async (page) => {
    await P(2200);                                   // pipeline with statuses
    const amBtn = page.locator('button:has-text("✎")').first();
    if (await amBtn.count()) { await amBtn.click(); await P(3000); } // amendment diff
    const ship = page.locator('button[title]:has-text("🚚")').first();
    if (await ship.count()) { await ship.click(); await P(2200); }   // logistics panel
    await slowScroll(page, 3);
    await P(1500);
  });
  await sup.close();

  await browser.close();
  for (const { key, video } of clips) {
    copyFileSync(await video.path(), join(OUT, `${key}.webm`));
  }
  console.log(`\n${clips.length} guides recorded → apps/web/public/guides/`);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
