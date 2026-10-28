import { test, expect, Page } from '@playwright/test';

async function login(page: Page, language = 'en') {
  await page.goto('/login');
  await page.evaluate(lang => localStorage.setItem('lp_lang', lang), language);
  await page.reload();
  await page.fill('input[type=email]', 'admin@acme.test');
  await page.fill('input[type=password]', 'Passw0rd!');
  await page.click('form button.btn:not(.ghost):not([type=button])');
  await page.waitForURL(/\/buyer\//);
}

test.describe('analytics filter integrity', () => {
  test.describe.configure({ mode: 'serial' });
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await login(page);
  });
  test.afterEach(async () => { await page.unrouteAll({ behavior: 'wait' }); });
  test.afterAll(async () => { await page.close(); });

test('analytics keeps the newest currency when an earlier response arrives late', async () => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pending = new Promise<void>(resolve => { started = resolve; });
  const settled = new Promise<void>(resolve => {
    const done = (req: { url(): string }) => { if (req.url().includes('currency=USD')) resolve(); };
    page.on('requestfinished', done);
    page.on('requestfailed', done);
  });
  await page.route('**/dashboard/spend-analytics?**', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.topSuppliers = [{ name: `${data.currency} selected response`, totalMinor: 100, poCount: 1 }];
    if (data.currency === 'USD') { started(); await gate; }
    // An aborted obsolete request may already have lost its browser connection.
    await route.fulfill({ response, json: data }).catch(() => {});
  });
  try {
    await page.goto('/buyer/analytics');
    await expect(page.getByText('AZN selected response', { exact: true })).toBeVisible();
    await page.getByTestId('analytics-currency').selectOption('USD');
    await pending;
    await page.getByTestId('analytics-currency').selectOption('EUR');
    await expect(page.getByText('EUR selected response', { exact: true })).toBeVisible();
    release();
    await settled;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByTestId('analytics-currency')).toHaveValue('EUR');
    await expect(page.getByText('EUR selected response', { exact: true })).toBeVisible();
    await expect(page.getByText('USD selected response', { exact: true })).toHaveCount(0);
  } finally { release(); }
});

test('analytics month presets do not overflow shorter months on day 31', async () => {
  await page.clock.setFixedTime(new Date('2026-08-31T12:00:00Z'));
  await page.goto('/buyer/analytics');
  await page.getByRole('button', { name: 'Quarter', exact: true }).click();
  await expect(page.getByLabel('From month')).toHaveValue('2026-06');
  await expect(page.getByLabel('To month')).toHaveValue('2026-08');
  await page.getByRole('button', { name: '12 months', exact: true }).click();
  await expect(page.getByLabel('From month')).toHaveValue('2025-09');
  await expect(page.getByLabel('To month')).toHaveValue('2026-08');
});

test('analytics shows a localized failure and retries without exporting stale data', async () => {
  await page.evaluate(() => localStorage.setItem('lp_lang', 'az'));
  let fail = true;
  await page.route('**/dashboard/spend-analytics?**', async route => {
    if (fail) { fail = false; await route.fulfill({ status: 503, json: { message: 'test failure' } }); }
    else await route.continue();
  });
  await page.goto('/buyer/analytics');
  await expect(page.getByRole('alert')).toContainText('Analitikanı yükləmək mümkün olmadı.');
  await expect(page.getByRole('button', { name: '⤓ CSV', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Yenidən yoxla', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '⤓ CSV', exact: true })).toBeEnabled();
});

});
