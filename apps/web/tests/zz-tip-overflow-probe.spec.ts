import { test, expect, Page } from '@playwright/test';

// TEMPORARY measurement, not a gate. It exists to answer one question the audit cannot
// answer by reading: WHICH tooltips push the page sideways when they open. The product has
// no stand on the development box, and this job already has one — so the measurement runs
// where the app is, and the branch carrying it is deleted once the list is read.
//
// Why a list and not a sum: 85px of overflow on Бюджетах can come from the actions column
// or from the pace hint at the right edge of the rollup, and a rule written for the wrong
// one leaves the defect and adds a second.
async function login(page: Page, email: string): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('lp_lang', 'en'));
  await page.goto('/login');
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', 'Passw0rd!');
  await page.click('form button.btn:not(.ghost):not([type=button])');
  await page.waitForURL(/\/(buyer|supplier)\//, { timeout: 15_000 });
}

test.describe('tip overflow probe', () => {
  test.describe.configure({ mode: 'serial' });
  let page: Page;
  test.beforeAll(async ({ browser }) => { page = await browser.newPage(); await login(page, 'admin@acme.test'); });
  test.afterAll(async () => { await page.close(); });

  test('which tooltips push the page sideways', async () => {
    test.setTimeout(300_000);
    const found: string[] = [];
    for (const path of ['/buyer/budgets', '/buyer/requests', '/buyer/contracts', '/buyer/invoices']) {
      for (const width of [1440, 1280, 1024]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(path);
        await expect(page.locator('[role=status]')).toHaveCount(0, { timeout: 20_000 });
        const tips = page.locator('[data-tip]');
        const n = await tips.count();
        for (let i = 0; i < n; i++) {
          const el = tips.nth(i);
          if (!(await el.isVisible())) continue;
          await el.hover({ timeout: 2000 }).catch(() => {});
          const m = await el.evaluate((node) => {
            const root = document.scrollingElement!;
            const over = root.scrollWidth - root.clientWidth;
            if (over <= 1) return null;
            const c = getComputedStyle(node as Element, '::after');
            const cell = (node as Element).closest('td, th');
            return {
              over,
              host: `${node.tagName.toLowerCase()}.${(node as HTMLElement).className || '—'}`,
              cell: cell ? `${cell.tagName.toLowerCase()}.${cell.className || '—'}` : '—',
              right: Math.round((node as Element).getBoundingClientRect().right),
              bubble: Math.round(parseFloat(c.width)),
              tip: ((node as Element).getAttribute('data-tip') || '').slice(0, 40),
            };
          });
          if (m) found.push(`OVERFLOW ${path} @${width}: +${m.over}px · host ${m.host} · cell ${m.cell} · right ${m.right} · bubble ${m.bubble} · "${m.tip}…"`);
          await page.mouse.move(2, 2);
        }
      }
    }
    console.log('=== TIP OVERFLOW REPORT ===');
    for (const line of found) console.log(line);
    console.log(`=== TIP OVERFLOW TOTAL: ${found.length} ===`);
    expect(true).toBe(true);
  });
});
