import { test, expect, Page } from '@playwright/test';

/**
 * Browser smoke of the whole SPA: every section of both panels renders without an
 * error boundary, and one real interaction per role works end-to-end.
 * Data comes from the dev seed (admin@acme.test / seller@supply-one.test).
 */

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', 'Passw0rd!');
  // submit button only — the mode tabs are also .btn but carry type=button
  await page.click('form button.btn:not(.ghost):not([type=button])');
  await page.waitForURL(/\/(buyer|supplier)\//, { timeout: 15_000 });
}

async function assertRenders(page: Page, path: string, headingHint: RegExp): Promise<void> {
  await page.goto(path);
  await expect(page.locator('h1').first()).toContainText(headingHint, { timeout: 20_000 });
  await expect(page.locator('text=Unexpected Application Error')).toHaveCount(0);
}

test.describe('buyer panel', () => {
  test.beforeEach(async ({ page }) => login(page, 'admin@acme.test'));

  test('all buyer sections render', async ({ page }) => {
    await assertRenders(page, '/buyer/dashboard', /Рабочий стол|Dashboard|İdarə paneli/);
    await assertRenders(page, '/buyer/requests', /Заявки|Requests|Sifariş/);
    await assertRenders(page, '/buyer/events', /Тендеры|Tenders|Tender/);
    await assertRenders(page, '/buyer/contracts', /Контракты|Contracts|Müqavil/);
    await assertRenders(page, '/buyer/invoices', /Счета|Invoices|Qaimə/);
    await assertRenders(page, '/buyer/catalogs', /Каталоги|Catalogs|Kataloq/);
    await assertRenders(page, '/buyer/logistics', /Логистика|Logistics|Logistika/);
    await assertRenders(page, '/buyer/suppliers', /Поставщики|Suppliers|Təchizatçı/);
    await assertRenders(page, '/buyer/verification', /Верификация|Verification|Yoxlama/);
    await assertRenders(page, '/buyer/settings', /Настройки|Settings|Parametr/);
  });

  test('dashboard shows real KPI money', async ({ page }) => {
    await page.goto('/buyer/dashboard');
    await expect(page.locator('text=AZN').first()).toBeVisible({ timeout: 10_000 });
  });

  test('creating a draft request works through the UI', async ({ page }) => {
    await page.goto('/buyer/requests');
    const title = `PW smoke ${Date.now()}`;
    await page.fill('form > input', title);
    await page.fill('.row > div:nth-child(1) input', 'Playwright item');
    await page.fill('.row > div:nth-child(2) input', '2');
    await page.fill('.row > div:nth-child(3) input', '10');
    await page.click('form button.btn:not(.ghost):not([type=button])');
    await expect(page.locator(`tr:has-text("${title}")`)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(`tr:has-text("${title}")`).locator('.badge')).toContainText('DRAFT');
  });
});

test.describe('supplier panel', () => {
  test.beforeEach(async ({ page }) => login(page, 'seller@supply-one.test'));

  test('all supplier sections render', async ({ page }) => {
    await assertRenders(page, '/supplier/dashboard', /Рабочий стол|Dashboard|İdarə paneli/);
    await assertRenders(page, '/supplier/market', /Открытые тендеры|Open tenders|Açıq tender/);
    await assertRenders(page, '/supplier/orders', /Заказы в работе|Orders in progress|İşdə olan/);
    await assertRenders(page, '/supplier/contracts', /Контракты|Contracts|Müqavil/);
    await assertRenders(page, '/supplier/invoices', /Счета|Invoices|Qaimə/);
    await assertRenders(page, '/supplier/catalogs', /Каталоги|Catalogs|Kataloq/);
    await assertRenders(page, '/supplier/verification', /Верификация|Verification|Yoxlama/);
  });

  test('role guard: supplier cannot open buyer pages', async ({ page }) => {
    await page.goto('/buyer/dashboard');
    // Protected redirects a supplier away from buyer routes
    await page.waitForURL((url) => !url.pathname.startsWith('/buyer'), { timeout: 10_000 });
  });
});
