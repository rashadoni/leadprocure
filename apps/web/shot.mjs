import { chromium } from '@playwright/test';

const OUT = process.argv[2];
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => localStorage.setItem('lp_lang', 'az'));
const p = await ctx.newPage();
await p.goto('http://localhost:5173/login');
await p.fill('input[type=email]', 'admin@acme.test');
await p.fill('input[type=password]', 'Passw0rd!');
await p.click('form button.btn:not(.ghost):not([type=button])');
await p.waitForURL(/\/buyer\//, { timeout: 20000 });
await p.goto('http://localhost:5173/buyer/requests');
await p.waitForSelector('[data-help-video-widget]', { timeout: 15000 });
await p.waitForTimeout(1200);
await p.locator('[data-help-video-widget]').screenshot({ path: OUT });
await p.screenshot({ path: OUT.replace('.png', '-full.png') });
console.log('ok');
await b.close();
