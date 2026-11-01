import { test, expect, Page } from '@playwright/test';

/**
 * Browser smoke of the whole SPA: every section of both panels renders without an
 * error boundary, and one real interaction per role works end-to-end.
 * Data comes from the dev seed (admin@acme.test / seller@supply-one.test).
 */

async function login(page: Page, email: string): Promise<void> {
  await page.addInitScript(()=>localStorage.setItem('lp_lang','en'));
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

// ONE login per panel, not one per test. /auth/login is throttled to 10/min as a
// brute-force guard, so a per-test login put the suite one test away from tripping its own
// security control — and two consecutive runs tripped it for sure. Tests share a page
// inside a single browser context (safe: reusing a storageState across CONTEXTS is what
// replays a rotated refresh token and trips the breach detection).
test.describe('buyer panel', () => {
  test.describe.configure({ mode: 'serial' });
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await login(page, 'admin@acme.test');
  });
  test.afterAll(async () => page.close());

  test('all buyer sections render', async () => {
    await assertRenders(page, '/buyer/dashboard', /Рабочий стол|Dashboard|İdarə paneli/);
    await assertRenders(page, '/buyer/requests', /Заявки|Requests|Sifariş/);
    await assertRenders(page, '/buyer/events', /Тендеры|Tenders|Tender/);
    await assertRenders(page, '/buyer/contracts', /Контракты|Contracts|Müqavil/);
    await assertRenders(page, '/buyer/invoices', /Счета|Invoices|Qaimə/);
    await assertRenders(page, '/buyer/catalogs', /Каталоги|Catalogs|Kataloq/);
    await assertRenders(page, '/buyer/budgets', /Бюджеты|Budgets|Büdcə/);
    await assertRenders(page, '/buyer/analytics', /Аналитика|Analytics|Analitika/);
    await assertRenders(page, '/buyer/logistics', /Логистика|Logistics|Logistika/);
    await assertRenders(page, '/buyer/suppliers', /Поставщики|Suppliers|Təchizatçı/);
    await assertRenders(page, '/buyer/verification', /Верификация|Verification|Yoxlama/);
    await assertRenders(page, '/buyer/settings', /Настройки|Settings|Parametr/);
  });

  test('dashboard shows real KPI money', async () => {
    await page.goto('/buyer/dashboard');
    await expect(page.locator('text=AZN').first()).toBeVisible({ timeout: 10_000 });
  });

  // A load that fails must SAY so. The KPI used to leave "…" on screen for ever — the page
  // never came back and never explained itself — because the only rejection handler was none.
  test('a failed dashboard load reports itself, and Retry really retries', async () => {
    // Fail every request until the failure is ON SCREEN, then let the retry through. A
    // handler that only failed the FIRST request would 503 the mount that React
    // StrictMode throws away in a dev server and let the surviving one succeed — the test
    // would then pass in CI (production build, StrictMode inert) and fail locally.
    let fail = true;
    await page.route('**/dashboard/buyer', async (route) => {
      if (!fail) return route.continue();
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"down"}' });
    });
    await page.goto('/buyer/dashboard');
    const alert = page.getByRole('alert').filter({ hasText: 'Could not load the data.' });
    await expect(alert).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('h1')).toContainText(/Dashboard|Рабочий стол|İdarə paneli/);
    fail = false;
    const retried = page.waitForResponse((r) => r.url().includes('/dashboard/buyer') && r.ok());
    await alert.getByRole('button', { name: 'Retry' }).click();
    await retried;
    await expect(alert).toHaveCount(0);
    await expect(page.locator('text=AZN').first()).toBeVisible({ timeout: 20_000 });
    await page.unroute('**/dashboard/buyer');
  });

  // The other half of the rule: a read a page can live without is swallowed ONLY when the
  // API says the org may not have it. 403 is that answer (FeatureGuard / the role guard);
  // everything else is a dead request, and "no overspend banner" is not the same statement
  // as "you are not over budget".
  test('a denied optional read stays silent, a broken one speaks up', async () => {
    let status = 403;
    // Match the pathname, not a glob: "**/budgets" also matches the SPA page URL
    // /buyer/budgets, and fulfilling THAT with JSON would stop the app loading at all.
    const isBudgets = (url: URL) => url.pathname === '/budgets';
    await page.route(isBudgets, async (route) => {
      await route.fulfill({ status, contentType: 'application/json', body: '{"message":"no"}' });
    });
    const denied = page.waitForResponse((r) => new URL(r.url()).pathname === '/budgets' && r.status() === 403);
    await page.goto('/buyer/dashboard');
    await denied;
    await expect(page.locator('text=AZN').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('alert')).toHaveCount(0);

    status = 503;
    const broken = page.waitForResponse((r) => new URL(r.url()).pathname === '/budgets' && r.status() === 503);
    await page.goto('/buyer/dashboard');
    await broken;
    await expect(page.getByRole('alert').filter({ hasText: 'Could not load the data.' }))
      .toBeVisible({ timeout: 20_000 });
    await page.unroute(isBudgets);
  });

  // Fields are addressed by data-testid, not by position: the old `form > input` /
  // `.row > div:nth-child(n)` selectors matched nothing once the form grew a field, and a
  // selector that silently stops matching is worse than no test.
  // This is the only test that writes. Against a deployed stand that means leaving a
  // department and a draft request behind in someone's demo data, so it runs only on a
  // local stack unless the caller opts in with SMOKE_ALLOW_WRITES=1.
  test('creating a draft request works through the UI, including its department', async () => {
    const remote = !!process.env.BASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.BASE_URL);
    test.skip(remote && !process.env.SMOKE_ALLOW_WRITES,
      'writes disabled against a remote stand — set SMOKE_ALLOW_WRITES=1 to allow');
    // Fixed code, created once: a per-run code would pile up departments in the dev stand.
    const code = 'PW-SMOKE';
    await page.goto('/buyer/settings');
    const dep = page.locator(`td:text-is("${code}")`);
    if (!(await dep.count())) {
      const depForm = page.locator('.card', { hasText: /Отделы|Departments|Şöbələr/ }).locator('form');
      await depForm.locator('input').first().fill(code);
      await depForm.locator('button.btn').click();
    }
    await expect(dep).toBeVisible({ timeout: 10_000 });

    await page.goto('/buyer/requests');
    const title = `PW smoke ${Date.now()}`;
    await page.fill('[data-testid=req-title]', title);
    await page.selectOption('[data-testid=req-department]', { label: code });
    await page.fill('[data-testid=item-name-0]', 'Playwright item');
    await page.fill('[data-testid=item-qty-0]', '2');
    await page.fill('[data-testid=item-price-0]', '10');
    // BEFORE the submit: the form clears itself on success, and the layout this picture
    // exists to answer for — field widths against what each field holds, labels level
    // across inputs and a select — cannot be read off empty fields.
    await page.screenshot({ path: 'test-results/request-form.png' });
    await page.click('form button.btn:not(.ghost):not([type=button])');

    const row = page.locator(`tr:has-text("${title}")`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    // the badge TEXT is localized ("Черновик"), so assert on the status class instead
    await expect(row.locator('.badge')).toHaveClass(/DRAFT/);
    await expect(row).toContainText(code); // the department round-tripped through the API
  });

  // The product's own dialogs replaced alert / prompt / confirm. What the native prompt
  // could NOT do is refuse an answer: «OTIF score 0-100» accepted any text at all and sent
  // Number('потом') — NaN — as a supplier's rating. The seed has one approved supplier,
  // so this row is always here.
  test('a dialog refuses an answer out of range and says why', async () => {
    // It ends by POSTing a real score, which lands in supplier_scorecard_entries for good
    // and feeds the reliability index behind the AI ranking. Same guard as the draft-request
    // test above: against a deployed stand it would quietly inflate a demo supplier's
    // rating once per run.
    const remote = !!process.env.BASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.BASE_URL);
    test.skip(remote && !process.env.SMOKE_ALLOW_WRITES,
      'writes disabled against a remote stand — set SMOKE_ALLOW_WRITES=1 to allow');
    await page.goto('/buyer/suppliers');
    // a prefix, not an exact name: [data-tip]::after lands in the accessible name
    await page.getByRole('button', { name: /^★ Scorecard\b/ }).first().click();
    const input = page.getByTestId('dialog-input');
    const confirm = page.getByTestId('dialog-confirm');
    await expect(input).toHaveValue('90');
    await expect(confirm).toBeEnabled();
    await input.fill('150');
    await expect(confirm).toBeDisabled();
    await expect(page.getByRole('dialog').locator('.error')).toContainText('100');
    // The refusal is the frame worth keeping: the question, the hint written from the
    // server's own rule, the dead button and the reason it is dead.
    await page.screenshot({ path: 'test-results/dialog.png' });
    await input.fill('');
    await expect(confirm).toBeDisabled();
    const posted = page.waitForResponse(
      (r) => /\/suppliers\/[^/]+\/scorecard$/.test(r.url()) && r.request().method() === 'POST');
    await input.fill('88');
    await confirm.click();
    expect((await posted).ok()).toBe(true);
    await expect(input).toHaveCount(0);
  });

  // The section guide used to be a 190px card above every heading, dismissed per section:
  // clearing it from sight took twelve closes. One line now, and one switch for all of it.
  test('the section guide is one line, and hiding it hides it everywhere', async () => {
    await page.goto('/buyer/requests');
    const bar = page.locator('.help-bar');
    await expect(bar).toBeVisible();
    const box = await bar.boundingBox();
    expect(box!.height).toBeLessThan(60);
    // The menu follows the page down instead of scrolling away from a long list. Measured,
    // not read off the declaration: `position: sticky` keeps reporting itself as sticky
    // after any ancestor grows an `overflow` that silently disables it.
    await page.setViewportSize({ width: 1280, height: 420 });
    await page.evaluate(() => window.scrollTo(0, 300));
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
    expect(await page.locator('.side').evaluate((el) => el.getBoundingClientRect().top)).toBeLessThan(2);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    // a prefix: [data-tip]::after lands in the accessible name
    await bar.getByRole('button', { name: /^✕/ }).click();
    await expect(bar).toHaveCount(0);
    await page.goto('/buyer/budgets');
    await expect(page.locator('.help-bar')).toHaveCount(0);
    // The way back lives in the sidebar, which a supplier has too — unlike Settings.
    await page.locator('.side-link').click();
    await expect(page.locator('.help-bar')).toBeVisible();
  });
});

test.describe('supplier panel', () => {
  test.describe.configure({ mode: 'serial' });
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await login(page, 'seller@supply-one.test');
  });
  test.afterAll(async () => page.close());

  test('all supplier sections render', async () => {
    await assertRenders(page, '/supplier/dashboard', /Рабочий стол|Dashboard|İdarə paneli/);
    await assertRenders(page, '/supplier/market', /Открытые тендеры|Open tenders|Açıq tender/);
    await assertRenders(page, '/supplier/orders', /Заказы в работе|Orders in progress|İşdə olan/);
    await assertRenders(page, '/supplier/contracts', /Контракты|Contracts|Müqavil/);
    await assertRenders(page, '/supplier/invoices', /Счета|Invoices|Qaimə/);
    await assertRenders(page, '/supplier/catalogs', /Каталоги|Catalogs|Kataloq/);
    await assertRenders(page, '/supplier/verification', /Верификация|Verification|Yoxlama/);
  });

  // An empty market and a market that failed to load used to look identical — the supplier
  // would conclude there is nothing to bid on. They must never read the same.
  test('a failed market load is not shown as an empty market', async () => {
    let fail = true;  // as above: every request, until the failure is on screen
    await page.route('**/events?**', async (route) => {
      if (!fail) return route.continue();
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"down"}' });
    });
    await page.goto('/supplier/market');
    const alert = page.getByRole('alert').filter({ hasText: 'Could not load the data.' });
    await expect(alert).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Nothing here yet')).toHaveCount(0);
    fail = false;
    const retried = page.waitForResponse((r) => r.url().includes('/events?') && r.ok());
    await alert.getByRole('button', { name: 'Retry' }).click();
    await retried;
    await expect(alert).toHaveCount(0);
    // Deliberately unfiltered, and it stays that way: a filter whose text stops matching
    // passes for ever. A toast cannot appear here (nothing on this page acts), and it
    // carries role="status" rather than role="alert" precisely to stay out of such checks.
    await expect(page.getByRole('status')).toHaveCount(0);
    await page.unroute('**/events?**');
  });

  test('role guard: supplier cannot open buyer pages', async () => {
    await page.goto('/buyer/dashboard');
    // Protected redirects a supplier away from buyer routes
    await page.waitForURL((url) => !url.pathname.startsWith('/buyer'), { timeout: 10_000 });
  });

  // Two page headings on one screen, and a column of buttons a supplier can never press.
  // Both tables on this page belong to the buyer's side of the contract; the supplier only
  // reads them, so the actions column is not drawn at all rather than taking its width on
  // every row. The check is not vacuous on an empty list: the heading row renders anyway.
  test('contracts page has one heading and no actions column for a supplier', async () => {
    await page.goto('/supplier/contracts');
    await expect(page.getByRole('heading', { name: 'Orders', exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.getByRole('columnheader', { name: 'Actions', exact: true })).toHaveCount(0);
  });
});
