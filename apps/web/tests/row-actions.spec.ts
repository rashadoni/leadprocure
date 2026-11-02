import { test, expect, Page } from '@playwright/test';

/**
 * A table row is one line, and its actions are one line inside it.
 *
 * This is the rule a shipped `Actions` component already claimed to keep — "one row, one
 * flex line" — while the stylesheet beside it said `flex-wrap: wrap` with a 92px floor
 * under every button. In a 150px column each button took a line of its own: six actions on
 * a budget drew a 235px row, and the budgets page was 2535px of mostly buttons. Nothing
 * caught it, because every check read the markup and none measured the result.
 *
 * So this suite measures. It is deliberately about geometry and not about any one page: a
 * new table, or a sixth button added to an existing one, is covered the day it appears.
 */

const PAGES = [
  { path: '/buyer/requests', as: 'admin@acme.test' },
  { path: '/buyer/budgets', as: 'admin@acme.test' },
  { path: '/buyer/contracts', as: 'admin@acme.test' },
  { path: '/buyer/invoices', as: 'admin@acme.test' },
  { path: '/buyer/suppliers', as: 'admin@acme.test' },
  { path: '/supplier/orders', as: 'seller@supply-one.test' },
];

// One line of small buttons is 26px; 34 leaves room for a border and a rounding, and is
// far below the 52px a second line would cost.
const ONE_LINE = 34;

async function login(page: Page, email: string): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('lp_lang', 'en'));
  await page.goto('/login');
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', 'Passw0rd!');
  await page.click('form button.btn:not(.ghost):not([type=button])');
  await page.waitForURL(/\/(buyer|supplier)\//, { timeout: 15_000 });
}

test.describe.configure({ mode: 'serial' });

test.describe('a row of actions stays a row', () => {
  let page: Page;
  // One login per describe, shared page: /auth/login is throttled to 10 a minute, and a
  // login per test spends that budget on the suite's own security control.
  test.beforeAll(async ({ browser }) => { page = await browser.newPage(); });
  test.afterAll(async () => { await page.close(); });

  for (const { path, as } of PAGES) {
    test(`${path} — every action cell is one line and the table fits its card`, async () => {
      if (!page.url().includes(as === 'admin@acme.test' ? '/buyer/' : '/supplier/')) await login(page, as);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(path);
      await expect(page.locator('h1').first()).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('[role=status]')).toHaveCount(0, { timeout: 20_000 });

      const bad = await page.evaluate((oneLine) => {
        const out: string[] = [];
        for (const cell of Array.from(document.querySelectorAll<HTMLElement>('.actions'))) {
          const h = Math.round(cell.getBoundingClientRect().height);
          if (h > oneLine) {
            const labels = Array.from(cell.querySelectorAll('button, select'))
              .map((b) => (b.textContent || '').trim()).join(' / ');
            out.push(`action cell ${h}px tall (${labels})`);
          }
        }
        for (const table of Array.from(document.querySelectorAll('table'))) {
          if (!table.querySelector('.actions')) continue;
          const card = table.closest('.card');
          if (!card) continue;
          const t = Math.round(table.getBoundingClientRect().width);
          const c = Math.round(card.getBoundingClientRect().width);
          if (t > c) out.push(`table ${t}px wide in a ${c}px card`);
        }
        return out;
      }, ONE_LINE);

      expect(bad, `${path}: ${bad.join('; ')}`).toEqual([]);
    });
  }
});
