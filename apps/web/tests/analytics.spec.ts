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

// Everything except the monthly series stays as the stand served it.
const stub = (page: Page, patch: (data: any) => void) =>
  page.route('**/dashboard/spend-analytics?**', async route => {
    const response = await route.fetch();
    const data = await response.json();
    patch(data);
    // an aborted obsolete request may already have lost its browser connection
    await route.fulfill({ response, json: data }).catch(() => {});
  });
const months = (plan: boolean, prev: boolean) => MONTHS.map(([month, total, planned, previous]) => ({
  month, totalMinor: total, plannedMinor: plan ? planned : 0, prevTotalMinor: prev ? previous : 0,
}));

// Every analytics test shares ONE login. /auth/login is throttled to 10/min (brute force
// + argon2 DoS), and the suite as a whole already sits close to that ceiling: a spec file
// of its own for the chart tripped the limit, and a tripped limit fails as a login timeout
// in whichever test happens to run next.
test.describe('analytics', () => {
  test.describe.configure({ mode: 'serial' });
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await login(page);
  });
  test.afterEach(async () => { await page.unrouteAll({ behavior: 'wait' }); });
  test.afterAll(async () => { await page.close(); });

test('the spend chart carries a scale, a grid and a legend that names every mark', async () => {
  await stub(page, data => { data.monthly = months(true, true); });
  await page.goto('/buyer/analytics');

  // The window arrives filled in: while it started empty the screen could not say which
  // period its figures covered, and the two month fields drew themselves as "---- --".
  await expect(page.getByLabel('From month')).not.toHaveValue('');
  await expect(page.getByLabel('To month')).not.toHaveValue('');
  // The selected preset is marked by fill, never by its label — these buttons are found by
  // name in the test below.
  await expect(page.getByRole('button', { name: '12 months', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Quarter', exact: true })).toHaveAttribute('aria-pressed', 'false');

  // Three ticks up the side, the top one carrying the currency, and a grid line per tick.
  // The bars used to be drawn against a maximum that appeared nowhere on the page.
  //
  // The figures are asserted, not merely counted: the series peaks at 9 000.00, the ladder
  // rounds that up to 10 000.00, and every bar is measured against it. A test that only
  // looked for three ticks and the word AZN would stay green if the scale went ten times
  // too big and squashed the whole chart into a tenth of the plot.
  await expect(page.locator('.chart-tick')).toHaveCount(3);
  await expect(page.locator('.chart-tick').nth(0)).toHaveText('10K AZN');
  await expect(page.locator('.chart-tick').nth(1)).toHaveText('5K');
  await expect(page.locator('.chart-tick').nth(2)).toHaveText('0');
  await expect(page.locator('.chart-rule')).toHaveCount(3);
  await expect(page.locator('.chart-col')).toHaveCount(MONTHS.length);

  // May is 9 000.00 of a 10 000.00 scale, so its bar must fill 90% of the plot box.
  const plot = await page.locator('.chart').boundingBox();
  const may = await page.locator('.chart-col').nth(4).locator('.chart-bar').boundingBox();
  expect(may!.height / plot!.height).toBeGreaterThan(0.88);
  expect(may!.height / plot!.height).toBeLessThan(0.92);

  // The top label is centred on its own rule, so half of it hangs above the plot. The plot
  // has to start below the heading or the two collide — which they did.
  const head = await page.getByRole('heading', { name: 'Monthly spend', exact: true }).boundingBox();
  const tick = await page.locator('.chart-tick').nth(0).boundingBox();
  expect(tick!.y).toBeGreaterThan(head!.y + head!.height);

  // Fact, plan and last year each named beside their own mark. All three are drawn by the
  // stub above, so all three must be claimed.
  const key = page.locator('.chart-key span');
  await expect(key).toHaveCount(3);
  await expect(key.nth(0)).toHaveText('Actual');
  await expect(key.nth(1)).toHaveText('Plan');
  await expect(key.nth(2)).toHaveText('Last year');

  // A bar and a plan line of nearly the same value must sit at nearly the same height: the
  // month labels used to live inside the column and eat part of the height the percentages
  // were measured against, so the two came out some 15px apart — the one comparison the
  // chart exists for.
  const march = page.locator('.chart-col').nth(2);
  const bar = await march.locator('.chart-bar').boundingBox();
  const plan = await march.locator('.chart-plan').boundingBox();
  expect(bar && plan).toBeTruthy();
  expect(Math.abs(bar!.y - plan!.y)).toBeLessThan(8);

  await page.screenshot({ path: 'test-results/analytics-chart.png', fullPage: true });
});

// Both branches below replace the whole chart, and both are one click away on the live
// screen — a window before the first order, or any currency other than AZN.
test('an empty window says so instead of drawing twelve stubs against an invisible scale', async () => {
  await stub(page, data => {
    data.monthly = MONTHS.map(([month]) => ({ month, totalMinor: 0, plannedMinor: 0, prevTotalMinor: 0 }));
  });
  await page.goto('/buyer/analytics');
  await expect(page.getByText('No accepted orders in this window.', { exact: true })).toBeVisible();
  await expect(page.locator('.chart-frame')).toHaveCount(0);
});

test('a foreign currency explains the missing plan line and claims no mark it has not drawn', async () => {
  await stub(page, data => { data.currency = 'USD'; data.monthly = months(false, false); });
  await page.goto('/buyer/analytics');
  // Budgets are AZN-only by a database constraint, so the absence is by design, not a gap.
  await expect(page.getByText('Budgets are kept in AZN only, so there is no plan line in this currency.', { exact: true })).toBeVisible();
  await expect(page.locator('.chart-tick').nth(0)).toHaveText('10K USD');
  const key = page.locator('.chart-key span');
  await expect(key).toHaveCount(1);
  await expect(key.nth(0)).toHaveText('Actual');
  await expect(page.locator('.chart-plan')).toHaveCount(0);
  await expect(page.locator('.chart-prev')).toHaveCount(0);
});

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
