#!/usr/bin/env node
// Records the per-section guide videos (webm + poster png) against a RUNNING stand with
// demo data (scripts/demo-fill.mjs). Output → apps/web/public/guides/.
//   node scripts/record-guides.mjs [BASE_URL]     (default http://localhost:8080)
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

const P = (ms) => new Promise((r) => setTimeout(r, ms));
const scrollTo = (sel) => async (page) => {
  const el = page.locator(sel).first();
  if (await el.count()) { await el.scrollIntoViewIfNeeded(); await P(1500); }
};
const type = async (page, sel, text) => {
  const el = page.locator(sel).first();
  await el.click(); await el.pressSequentially(text, { delay: 55 });
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
  const page = await ctx.newPage();
  await page.goto(`${BASE}${path}`);
  await page.waitForSelector('h1', { timeout: 20000 });
  await P(1200);
  await page.screenshot({ path: join(OUT, `${key}.png`) });
  try { await actions?.(page); } catch (e) { console.log(`  (${key}: action skipped — ${e.message.split('\n')[0]})`); }
  await P(1500);
  clips.push({ key, video: page.video() });
  await page.close();
  console.log(`✓ ${key}`);
}

(async () => {
  console.log(`Recording guides from ${BASE} → ${OUT}`);
  const browser = await chromium.launch();

  const buyer = await roleContext(browser, 'admin@acme.test');

  await record(buyer, 'buyer-dashboard', '/buyer/dashboard', async (page) => {
    await P(1000); await scrollTo('table')(page); await P(800);
  });

  await record(buyer, 'buyer-requests', '/buyer/requests', async (page) => {
    await type(page, 'form > input', 'Ноутбуки для отдела продаж');
    await type(page, '.row > div:nth-child(1) input', 'Ноутбук 15", 16 ГБ');
    await type(page, '.row > div:nth-child(2) input', '10');
    await type(page, '.row > div:nth-child(3) input', '1500');
    await P(700);
    await page.click('form button.btn:not(.ghost):not([type=button])');
    await P(1200);
    await scrollTo('table')(page);
  });

  await record(buyer, 'buyer-events', '/buyer/events', async (page) => {
    await P(900);
    await page.click('a:has-text("серверное оборудование")');
    await page.waitForSelector('h1', { timeout: 15000 });
    await P(1400);
    await scrollTo('h3:has-text("Bids"), table')(page);
    await P(1200);
  });

  await record(buyer, 'buyer-contracts', '/buyer/contracts', async (page) => {
    await P(800);
    await scrollTo('.card:nth-of-type(2)')(page);
    const amend = page.locator('button:has-text("✎")').first();
    if (await amend.count()) {
      await amend.click(); await P(1200);
      await scrollTo('h3:has-text("✎")')(page);
      const q = page.locator('.card:has(h3:has-text("✎")) tbody input').first();
      if (await q.count()) await q.pressSequentially('75', { delay: 80 });
      await P(1000);
    }
  });

  await record(buyer, 'buyer-invoices', '/buyer/invoices', scrollTo('table'));
  await record(buyer, 'buyer-catalogs', '/buyer/catalogs', scrollTo('table'));

  await record(buyer, 'buyer-budgets', '/buyer/budgets', async (page) => {
    await P(700);
    await type(page, 'form input', 'Транспорт 2026');
    await P(400);
    await scrollTo('.budget-bar')(page);
  });

  await record(buyer, 'buyer-analytics', '/buyer/analytics', async (page) => {
    await page.waitForSelector('.chart-bar', { timeout: 15000 });
    await P(1200);
    await scrollTo('h3:has-text("Топ")')(page);
  });

  await record(buyer, 'buyer-logistics', '/buyer/logistics', scrollTo('table'));
  await record(buyer, 'buyer-suppliers', '/buyer/suppliers', scrollTo('table'));
  await record(buyer, 'buyer-verification', '/buyer/verification', scrollTo('table'));
  await buyer.close();

  const sup = await roleContext(browser, 'seller@supply-one.test');

  await record(sup, 'sup-dashboard', '/supplier/dashboard', scrollTo('table'));

  await record(sup, 'sup-market', '/supplier/market', async (page) => {
    await P(900);
    await page.click('a:has-text("офисная мебель")');
    await page.waitForSelector('h1', { timeout: 15000 });
    await P(1200);
    const price = page.locator('table input[type=number]').first();
    if (await price.count()) { await price.click(); await price.pressSequentially('25.50', { delay: 70 }); }
    await P(1000);
    await scrollTo('.hint')(page);
  });

  await record(sup, 'sup-orders', '/supplier/orders', async (page) => {
    await P(800);
    const amBtn = page.locator('button:has-text("✎")').first();
    if (await amBtn.count()) { await amBtn.click(); await P(1600); }
    await scrollTo('table')(page);
  });
  await sup.close();

  await browser.close();
  for (const { key, video } of clips) {
    copyFileSync(await video.path(), join(OUT, `${key}.webm`));
  }
  console.log(`\n${clips.length} guides recorded → apps/web/public/guides/`);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
