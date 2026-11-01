import { test, expect } from '@playwright/test';

// The spend chart is hand-rolled CSS — no charting library anywhere in this app — so a
// compiler cannot tell whether it still has a scale, and the figures behind it depend on
// whatever the rest of the suite happened to create. The monthly series is therefore
// stubbed to a known shape (everything else in the response stays real), which makes the
// assertions exact and leaves a deterministic picture in test-results/ as evidence that
// the page was looked at and not merely built.
const MONTHS = [
  ['2026-01', 0, 400000, 0], ['2026-02', 180000, 400000, 120000],
  ['2026-03', 420000, 400000, 380000], ['2026-04', 260000, 400000, 300000],
  ['2026-05', 900000, 400000, 410000], ['2026-06', 310000, 400000, 520000],
  ['2026-07', 150000, 400000, 180000], ['2026-08', 640000, 400000, 600000],
  ['2026-09', 0, 400000, 220000], ['2026-10', 520000, 400000, 470000],
  ['2026-11', 90000, 400000, 0],
] as const;

test('the spend chart carries a scale, a grid and a legend that names every mark', async ({ page }) => {
  await page.route('**/dashboard/spend-analytics?**', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.monthly = MONTHS.map(([month, total, planned, prev]) => ({
      month, totalMinor: total, plannedMinor: planned, prevTotalMinor: prev,
    }));
    await route.fulfill({ response, json: data }).catch(() => {});
  });
  // The interface speaks ru unless told otherwise; the assertions below quote the English
  // dictionary, and so do the button names the rest of this suite looks for.
  await page.addInitScript(() => localStorage.setItem('lp_lang', 'en'));
  await page.goto('/login');
  await page.fill('input[type=email]', 'admin@acme.test');
  await page.fill('input[type=password]', 'Passw0rd!');
  await page.click('form button.btn:not(.ghost):not([type=button])');
  await page.waitForURL(/\/buyer\//);
  await page.goto('/buyer/analytics');

  // The window arrives filled in: while it started empty the screen could not say which
  // period its figures covered, and the two month fields drew themselves as "---- --".
  await expect(page.getByLabel('From month')).not.toHaveValue('');
  await expect(page.getByLabel('To month')).not.toHaveValue('');
  // The selected preset is marked by fill, never by its label — these buttons are found by
  // name elsewhere in this suite.
  await expect(page.getByRole('button', { name: '12 months', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Quarter', exact: true })).toHaveAttribute('aria-pressed', 'false');

  // Three ticks up the side, the top one carrying the currency, and a grid line per tick.
  // The bars used to be drawn against a maximum that appeared nowhere on the page.
  await expect(page.locator('.chart-tick')).toHaveCount(3);
  await expect(page.locator('.chart-tick').first()).toContainText('AZN');
  await expect(page.locator('.chart-rule')).toHaveCount(3);
  await expect(page.locator('.chart-col')).toHaveCount(MONTHS.length);

  // Fact, plan and last year each named beside their own mark. All three are drawn by the
  // stub above, so all three must be claimed.
  const key = page.locator('.chart-key span');
  await expect(key).toHaveCount(3);
  await expect(key.nth(0)).toHaveText('Actual');
  await expect(key.nth(1)).toHaveText('Plan');
  await expect(key.nth(2)).toHaveText('Last year');

  // A bar and a plan line of the same value must sit at the same height: the month labels
  // used to live inside the column and eat part of the height the percentages measured
  // against, so the two came out some 15px apart — the one comparison the chart exists for.
  const march = page.locator('.chart-col').nth(2);
  const bar = await march.locator('.chart-bar').boundingBox();
  const plan = await march.locator('.chart-plan').boundingBox();
  expect(bar && plan).toBeTruthy();
  // 420000 against a 400000 plan: the bar's top is just above the plan line, not a label's
  // height below it.
  expect(Math.abs(bar!.y - plan!.y)).toBeLessThan(8);

  await page.screenshot({ path: 'test-results/analytics-chart.png', fullPage: true });
});
