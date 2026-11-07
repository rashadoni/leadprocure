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

// Every `goto` here is a COLD load: the access token lives in memory only, so each one
// bootstraps through `/auth/refresh`, which ROTATES the refresh cookie. Navigating again
// while that request is in flight aborts it — the browser then still holds the old cookie
// and presents it next time. A replay inside `JWT_REFRESH_REUSE_LEEWAY_MS` is tolerated by
// design; a stale one is treated as theft and the whole session family is revoked. That is
// the product behaving exactly as intended, and it is why this suite kept losing the
// supplier's session mid-walk and finishing on the login page: the supplier's pages are the
// lightest in the product, so its loads come fast enough to cut their own bootstrap off.
// Waiting for the network to settle after each navigation lets the rotation land before the
// next one starts. It costs about half a second per page and removes a failure that reads
// as a broken layout.
//
// THIS CURES THE RUN, NOT THE PRODUCT, and the difference is worth stating here rather than
// leaving the next reader to assume otherwise. The same race is available to a person:
// open a section, click a link before the bootstrap answers, come back a minute later — the
// cookie the browser still holds is now older than the leeway (`JWT_REFRESH_REUSE_LEEWAY_MS`,
// 15s by default in config.service.ts), so the product reads its own aborted request as
// theft and runs `UPDATE sessions SET revoked = true, revoked_at = NULL WHERE user_id = $1`
// (identity.service.ts) — every session that person has, on every device, hard-revoked.
// Whether that is the right answer to a race the product itself lost is the owner's call,
// not a test's: the options are not rotating twice inside the window, narrowing the response
// to the one chain instead of the whole user, or widening the window (which only hides it).
// Measured here, not argued: the suite lost the supplier's session this way three times
// today, and it is the lightest pages — the ones that answer fastest — that lose it.
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => { /* a page that never idles is the test's problem, not this helper's */ });
}

async function assertRenders(page: Page, path: string, headingHint: RegExp): Promise<void> {
  await page.goto(path);
  await settle(page);
  await expect(page.locator('h1').first()).toContainText(headingHint, { timeout: 20_000 });
  await expect(page.locator('text=Unexpected Application Error')).toHaveCount(0);
}

// ── narrow screens ────────────────────────────────────────────────────────────────────
// The widths the layout has to be right at: two desktops, a tablet on its side, a tablet
// held upright, a phone. 1440 and 1280 are the wide layout; the other three are below the
// 1100px breakpoint, where the rail is a drawer and a row is drawn as a card.
// Widest FIRST so that 375 — the width that matters and the one that fails first — is
// measured last, on the most settled page there is.
//
// 1280 was added on 2026-11-02 and is not a round number for its own sake: it is the width
// of the owner's own window, and it was the one width this list skipped. Requests scrolled
// sideways by 112px there and budgets by 107 — the rail plus eleven columns plus the page's
// own padding came to more than 1280 — while 1440 fit and 1024 had already folded into
// cards. A gap between the widest card layout and the narrowest table layout is exactly
// where a table overflows, so the list has to hold a width inside it.
const WIDTHS = [1440, 1280, 1024, 768, 375];

// Pages whose list cannot be empty on the seeded stack, so the measurement below is made
// WITH rows in it — and these four are the widest tables in the product (requests has ten
// columns, budgets eleven). An empty table is still worth measuring for its heading, form,
// filters and pager, but rows can only add width: a page that overflows once it has rows
// would pass on an empty one, so at least the wide tables have to be caught holding them.
// `/buyer/requests` has the draft this suite creates above; budgets has the seed's three
// plans; settings lists the organization's own users; suppliers has the seed's approved one.
const WITH_ROWS = ['/buyer/requests', '/buyer/budgets', '/buyer/settings', '/buyer/suppliers'];

// The measurement the whole narrow layout answers to. «Let the table scroll inside itself»
// is the option the owner refused, so sideways scrolling is not a blemish here — it is the
// failure. One pixel of tolerance and no more: `scrollWidth` is an integer rounded UP from
// a fractional layout width, so a page that fits exactly can report 1px over.
//
// `expect.soft`, so one run reports EVERY screen and width that breaks instead of only the
// first. The suite runs with `--max-failures=1` and takes eleven minutes, so a hard
// assertion here spends a whole cycle to learn about one page at one width.
async function assertNoSidewaysScroll(page: Page, where: string): Promise<void> {
  const { over, blame } = await page.evaluate(() => {
    const root = document.scrollingElement!;
    const limit = root.clientWidth;
    const over = root.scrollWidth - limit;
    if (over <= 1) return { over, blame: '' };
    // A failure has to NAME what sticks out. «Scrolls by 104px» sends the next reader
    // measuring nineteen screens by hand; this says which box, and answers first the one
    // question a box cannot answer — whether it is a box at all. A hint bubble is an
    // `::after`, which no query can enumerate and which does not grow its own element's
    // rectangle, so it is found by taking every bubble away and asking again.
    const style = document.createElement('style');
    style.textContent = '[data-tip]::after, [data-tip]::before { display: none !important }';
    document.head.appendChild(style);
    const withoutTips = root.scrollWidth - limit;
    style.remove();
    // Deepest elements only: a parent that sticks out because its child does is reported by
    // the child, and printing both buries the answer. Fixed boxes are skipped because they
    // are outside the page's scrollable width by construction.
    const out: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
      const r = el.getBoundingClientRect();
      if (!r.width || r.right <= limit + 1) continue;
      if (getComputedStyle(el).position === 'fixed') continue;
      if (Array.from(el.children).some((c) => c.getBoundingClientRect().right > limit + 1)) continue;
      const cls = String(el.className || '').trim().split(/\s+/).filter(Boolean).join('.');
      out.push(`${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}`
        + ` right=${Math.round(r.right)} w=${Math.round(r.width)} min=${el.scrollWidth}`);
      if (out.length === 6) break;
    }
    const blame = `without hint bubbles it would be ${withoutTips}px; `
      + (out.length ? `widest boxes past ${limit}px: ${out.join(' | ')}`
        : `no element past ${limit}px — a pseudo-element, a margin or a shadow`);
    return { over, blame };
  });
  expect.soft(over, `${where} scrolls sideways by ${over}px — ${blame}`).toBeLessThanOrEqual(1);
}

// Resized, not revisited: four visits per page would spend this test's whole budget on
// loading pages it has already loaded.
async function assertFitsEveryWidth(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await settle(page);
  await expect(page.locator('h1').first()).toBeVisible({ timeout: 20_000 });
  // Then wait for the LISTS to have answered, not just for the heading to be painted. The
  // access token lives in memory only, so every visit is a cold load — bundle,
  // `/auth/refresh`, mount — and the heading appears at about the moment the list request
  // goes out. Measuring on that frame measures an empty <tbody>, and since rows can only
  // add width, every overflow this test exists to catch would pass.
  // `ListState` is what every list on every page reports itself through, and its loading
  // line is the only `role="status"` on a page nobody has acted on yet — so this is one
  // signal for all nineteen screens, satisfied by rows, by «nothing here yet» and by a
  // failure alike.
  await expect(page.locator('[role=status]')).toHaveCount(0, { timeout: 20_000 });
  if (WITH_ROWS.includes(path)) {
    expect.soft(await page.locator('tbody tr').count(),
      `${path} is measured for its rows and had none`).toBeGreaterThan(0);
  }
  await assertOneTooltipPerElement(page, path);
  await assertTooltipsAreHints(page, path);
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await assertNoSidewaysScroll(page, `${path} at ${width}px`);
    if (width >= 1100) await assertActionsStayOnOneLine(page, `${path} at ${width}px`);
  }
}

// `data-tip` is drawn by `[data-tip]:hover::after`, and hovering a child hovers its parents
// too — so an element with a tip inside another element with a tip opens BOTH bubbles,
// stacked on the same spot. On the budget rollup the cell's «0.4%» landed on top of the
// pace line's sentence and ate its middle; the recording of that screen shows it. The rule
// is structural, not visual, so it is asserted structurally: no element carrying a tip may
// sit inside another one. There were zero such pairs once the rollup was fixed, which is
// what makes this worth asserting rather than tolerating.
// A tooltip is a hint of a few words. It is drawn in a 240px column, so 561 characters —
// which is what the budgets rollup carried — become a 273px black slab that opens on hover
// and lands on top of three rows of figures. The owner filmed exactly that and asked what
// it was. Documentation belongs on the page (components/Explain.tsx) or in the first
// sentence (`hintOf`), never in a bubble that covers the table it describes.
//
// 200 characters is four lines in the 360px bubble — long enough for any real hint, short
// enough that it never becomes a page of its own. Anything longer is documentation and
// belongs in an `Explain`, where it is said in the open and nothing is deleted to fit.
async function assertTooltipsAreHints(page: Page, where: string): Promise<void> {
  const essays = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[data-tip]'))
    .filter((el) => el.getBoundingClientRect().width > 0)
    .map((el) => el.getAttribute('data-tip') || '')
    .filter((tip) => tip.length > 200)
    .map((tip) => `${tip.length} chars: "${tip.slice(0, 50)}…"`));
  expect.soft(essays, `${where}: tooltips hold paragraphs — ${essays.join('; ')}`).toEqual([]);
}

async function assertOneTooltipPerElement(page: Page, where: string): Promise<void> {
  const nested = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[data-tip]'))
    .filter((el) => el.parentElement?.closest('[data-tip]'))
    .map((el) => `"${el.getAttribute('data-tip')}" inside "${el.parentElement!.closest('[data-tip]')!.getAttribute('data-tip')}"`));
  expect.soft(nested, `${where}: tooltips nest, so hovering the inner one draws both — ${nested.join('; ')}`).toEqual([]);
}

// A row's actions are a ROW. `Actions` promised exactly that in its own comment — "one row,
// one flex line" — while the stylesheet beside it said `flex-wrap: wrap` with a 92px floor
// under every button: in a 150px column each button took a line of its own, six actions on
// a budget drew a 235px row, and the budgets page came to 2535px of mostly buttons. It
// survived a review, and a UI/UX audit, because both read the markup; nobody measured the
// result. So this measures the result.
//
// Only above the breakpoint: below it a row is drawn as a card, where buttons SHOULD wrap
// — there is no row left for them to be a row of. One line of small buttons is 26px; 34
// leaves room for a border and a rounding and is far below the 52 a second line costs.
async function assertActionsStayOnOneLine(page: Page, where: string): Promise<void> {
  const tall = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.actions'))
    .map((cell) => ({ h: Math.round(cell.getBoundingClientRect().height),
      what: Array.from(cell.querySelectorAll('button, select')).map((b) => (b.textContent || '').trim()).join(' / ') }))
    .filter((x) => x.h > 34)
    .map((x) => `${x.h}px (${x.what})`));
  expect.soft(tall, `${where}: action cells wrapped onto more than one line — ${tall.join('; ')}`).toEqual([]);
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
    await assertRenders(page, '/learn', /Обучение|Learning|Təlim/);
  });

  // The course on /learn is the one screen a person meets before they know the product, so
  // the three things it promises are measured rather than reviewed: that it offers every
  // recording there is, that the file behind a lesson is really served, and that it leads
  // back into the section it just explained.
  //
  // The VIDEO's bytes are not asserted, deliberately: this job checks out the posters and
  // leaves the 164 MB of .webm as LFS pointers (see acceptance.yml), so a `readyState`
  // assertion here would fail for the recordings' absence and read as a broken player. The
  // poster is a real file in CI, and it shares a name and a directory with its video — so a
  // poster that answers with a real PNG is what proves the path, and the video is asserted
  // to answer at all.
  test('the course offers every lesson and leads into the section it explains', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/learn');
    const rows = page.getByTestId('learn-row');
    await expect(rows).toHaveCount(20);
    // A fresh context has watched nothing, so the count is the whole course and the first
    // lesson is the one offered to carry on with.
    await expect(page.getByTestId('learn-count')).toContainText('0 / 20');
    await expect(rows.first()).toHaveClass(/is-next/);

    await rows.first().getByTestId('learn-play').click();
    const video = page.getByTestId('learn-video');
    await expect(video).toHaveAttribute('src', '/guides/buyer-settings.az.webm');
    const poster = await page.request.get('/guides/buyer-settings.az.png');
    expect(poster.status(), 'the lesson poster is not served').toBe(200);
    expect((await poster.body()).length,
      'the poster is a 132-byte LFS pointer, not a picture — git lfs pull').toBeGreaterThan(1000);
    expect((await page.request.get('/guides/buyer-settings.az.webm')).status(),
      'the lesson recording is not served at all').toBe(200);

    // The way back into the product. The lesson is about Settings, the viewer is a buyer
    // admin, so the door is drawn and the route behind it opens.
    await page.getByTestId('learn-goto').click();
    await expect(page).toHaveURL(/\/buyer\/settings$/);
    await expect(page.getByTestId('learn-video')).toHaveCount(0);
  });

  // A tooltip must not be VISIBLE and COLLAPSED at the same time, and it must not leave the
  // page scrolling sideways behind it.
  //
  // The bubble is `max-width: 0` while idle so that it adds nothing to the page's own width.
  // The cap was never animated and the opacity was, so when the pointer left, the width
  // snapped to zero while the bubble went on fading for 140ms: a ~20px pill with its text
  // clipped to a character or two per line — a black vertical ribbon, in every section,
  // after every tooltip. The owner caught it on a screen recording; no test did, because
  // every assertion here had been about the bubble while it is SHOWN.
  //
  // The first repair held the width through the fade and bought a worse defect — 85px of
  // sideways scroll for the whole tail at 1440px, which is the thing `max-width: 0` exists
  // to prevent, and the owner has refused sideways scroll outright. So the bubble now leaves
  // in one frame, and both halves are asserted below: nothing visible-and-collapsed, and no
  // overflow left behind.
  test('a tooltip leaves without a ribbon and without sideways scroll', async () => {
    await page.goto('/buyer/budgets');
    await expect(page.locator('[role=status]')).toHaveCount(0, { timeout: 20_000 });
    const tip = page.locator('[data-tip]').first();
    await tip.hover();
    // The open state is asserted first for a reason: if the bubble never opened, every
    // sample below would be «0 wide, 0 opaque» and the test would pass having measured
    // nothing at all.
    await expect.poll(async () => tip.evaluate((el) =>
      Number(getComputedStyle(el, '::after').opacity))).toBeGreaterThan(0.9);
    const open = await tip.evaluate((el) => parseFloat(getComputedStyle(el, '::after').width));
    expect(open, 'the bubble never opened — the samples below would prove nothing').toBeGreaterThan(100);

    await page.mouse.move(5, 5);
    const ribbon: string[] = [];
    const overflow: number[] = [];
    for (let i = 0; i < 7; i++) {
      const s = await tip.evaluate((el) => {
        const c = getComputedStyle(el, '::after');
        const root = document.scrollingElement!;
        return { w: parseFloat(c.width), o: Number(c.opacity), over: root.scrollWidth - root.clientWidth };
      });
      if (s.o > 0.05 && s.w < 100) ribbon.push(`${Math.round(s.w)}px at opacity ${s.o.toFixed(2)}`);
      overflow.push(s.over);
      await page.waitForTimeout(18);
    }
    expect(ribbon, 'the bubble collapsed while still on screen').toEqual([]);
    expect(Math.max(...overflow),
      'the bubble is gone but the page still scrolls sideways after it').toBeLessThanOrEqual(1);
  });

  test('dashboard shows real KPI money', async () => {
    await page.goto('/buyer/dashboard');
    await expect(page.locator('text=AZN').first()).toBeVisible({ timeout: 10_000 });
  });

  // Two complaints from the audit, both about a number and the word over it.
  //
  // The rollup's first row is «Вся организация» — the org-wide BUDGET, the one that catches
  // what no department budget matches — and it stood above IT and OPS with a smaller plan
  // than either, reading like a total that did not add up. There was no total at all.
  //
  // And «Объём закупок» stood over two different figures: on the dashboard the sum of
  // winning bids over all time, in analytics the accepted orders of the window. Both
  // honest, one word. The tooltips always said which was which; the labels never did.
  test('the rollup adds itself up, and the two spend tiles no longer share a word', async () => {
    await page.goto('/buyer/budgets');
    await expect(page.locator('[role=status]')).toHaveCount(0, { timeout: 20_000 });
    const rollup = page.getByTestId('budget-rollup');
    const money = (text: string) => Number(text.replace(/[^\d.-]/g, '')) || 0;
    // Top-level rows only, read the way the component decides it: a parent's figures already
    // include its units (its first cell is indented, theirs are indented further).
    const planned = await rollup.locator('tbody tr').evaluateAll((rows) => rows
      .filter((r) => parseFloat(getComputedStyle(r.children[0] as Element).paddingLeft) <= 10.5)
      .map((r) => (r.children[1] as HTMLElement).innerText));
    const totalRow = rollup.getByTestId('rollup-total');
    if (planned.length > 1) {
      const total = money(await totalRow.locator('td').nth(1).innerText());
      expect(total, `the total is not the sum of its rows (${planned.join(' + ')})`)
        .toBeCloseTo(planned.reduce((n, cell) => n + money(cell), 0), 2);
    } else {
      // One row IS the organisation; a total under it would be the same figure twice. How
      // many rows this stand has depends on its seed, so the arithmetic is asked directly
      // in tests/rollup-total.spec.ts — including the nested case CI cannot build at all.
      await expect(totalRow).toHaveCount(0);
    }

    await page.goto('/buyer/dashboard');
    await expect(page.getByText('Awarded in tenders', { exact: true })).toBeVisible({ timeout: 10_000 });
    await page.goto('/buyer/analytics');
    await expect(page.getByText('Accepted orders', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
    // the word that used to stand over both is now over neither
    await expect(page.getByText('Total spend', { exact: true })).toHaveCount(0);
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
    // The form is behind a button now: the list of requests is what this screen opens on.
    await page.getByTestId('req-new').click();
    const title = `PW smoke ${Date.now()}`;
    await page.fill('[data-testid=req-title]', title);
    await page.selectOption('[data-testid=req-department]', { label: code });
    await page.fill('[data-testid=item-name-0]', 'Playwright item');
    await page.fill('[data-testid=item-qty-0]', '2');
    await page.fill('[data-testid=item-price-0]', '10');
    // 2 × 10.00 — on screen while it is being typed. The sum decides whether this becomes a
    // direct purchase or a tender, and which budget it charges; it used to appear only in
    // the list afterwards, so the one number that mattered was invisible while it was made.
    await expect(page.getByTestId('req-total')).toContainText('20.00');
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

  // Seven unrelated sections one under another, and an admin's new-user password typed in
  // the clear: the field had no `type`, so the browser gave it `text`.
  test('settings jumps to its sections and hides the password it asks for', async () => {
    await page.goto('/buyer/settings');
    const toApproval = page.getByRole('link', { name: 'Approval chain', exact: true });
    await expect(toApproval).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#new-user-password')).toHaveAttribute('type', 'password');
    // Wait for the lists FIRST, for two reasons: a hash scroll happens once, so a card
    // growing afterwards would stay below the fold; and a picture of a half-loaded page
    // answers nothing. The shot is still taken before the jump — the password field and
    // the section links are what this change is about, and the jump moves them off frame.
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    await page.screenshot({ path: 'test-results/settings.png' });
    await toApproval.click();
    await expect(page.locator('#set-approval')).toBeInViewport();
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
    // The poster is now the ONLY guide file the acceptance run downloads: the workflow pulls
    // `*.png` by name and leaves the 164 MB of video behind, because nothing here looks at a
    // video. So the poster is the one that has to be asked for. A Git LFS pointer served as
    // image/png decodes to nothing — `naturalWidth` stays 0, the widget's onError strips the
    // frame, and the bar quietly goes back to the wordy line nobody recognised as a video.
    // That is the failure `lfs: true` used to cover for without anyone checking.
    // Polled, not read once: the bar is visible while the image is still decoding.
    const poster = bar.locator('.help-thumb img');
    await expect(poster).toBeVisible();
    await expect.poll(() => poster.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
    // The menu follows the page down instead of scrolling away from a long list. Measured,
    // not read off the declaration: `position: sticky` keeps reporting itself as sticky
    // after any ancestor grows an `overflow` that silently disables it.
    //
    // The window is this short on purpose, and it got shorter when the request form moved
    // behind a button: this screen now FITS, which is the whole point of that change, so a
    // fixed 420px window left only 20–83px to scroll and the measurement stopped being a
    // measurement. The page is made to scroll by the window, not by how much the app
    // happens to draw — and we scroll as far as it goes rather than to a guessed offset.
    //
    // Asked of BOTH menus, each at a width where it IS the menu: 1280 is the wide layout,
    // where the menu is the rail down the left; below the 1100px breakpoint the rail is a
    // drawer and the thing that must not scroll away is the top bar holding the «Menu»
    // button. The rail stopped being the answer to this question on a narrow screen, so the
    // question is now put to each layout separately rather than to the rail at every width.
    const staysOnScreen = async (selector: string) => {
      const scrollable = await page.evaluate(() =>
        document.scrollingElement!.scrollHeight - document.scrollingElement!.clientHeight);
      // without this the assertions below pass on a page that cannot scroll at all
      expect(scrollable).toBeGreaterThan(100);
      await page.evaluate(() => window.scrollTo(0, document.scrollingElement!.scrollHeight));
      expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
      // |top|, не top: отлипшее меню уезжает ВВЕРХ и его `top` становится отрицательным,
      // то есть «< 2» проходило и когда меню приклеено (0), и когда его унесло (−176) —
      // ровно тот сбой, который этот замер и существует чтобы поймать.
      const top = await page.locator(selector).evaluate((el) => el.getBoundingClientRect().top);
      expect(Math.abs(top), `${selector} did not stay on screen`).toBeLessThan(2);
    };
    await page.setViewportSize({ width: 1280, height: 240 });
    await staysOnScreen('.side');
    await expect(page.locator('.topbar')).toBeHidden();
    await page.setViewportSize({ width: 375, height: 240 });
    await staysOnScreen('.topbar');
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

  // Narrow screens, down to a phone — the owner's decision of 1 November 2026 («И телефон
  // тоже»). Three statements, and the first one decides the other two: no screen may scroll
  // sideways at any width, because the way of getting out of that which was refused is a
  // table that scrolls inside itself.
  test('every buyer screen fits a phone, a tablet and a desktop, and the menu is reachable at each', async () => {
    // Thirteen cold loads, each waited out to its list, then measured at four widths. Well
    // inside this on a warm bundle, but the suite's own 90s default leaves no room on a
    // slow hosted runner, and a timeout here would read as an overflow.
    test.setTimeout(180_000);
    for (const path of ['/buyer/dashboard', '/buyer/requests', '/buyer/events', '/buyer/contracts',
      '/buyer/invoices', '/buyer/catalogs', '/buyer/budgets', '/buyer/analytics', '/buyer/logistics',
      '/buyer/suppliers', '/buyer/verification', '/buyer/settings', '/learn']) {
      await assertFitsEveryWidth(page, path);
    }
    // A tender's own page is the widest thing a buyer opens, and the only one that needs an
    // id — so it is taken from the list rather than written in here. The wait is the whole
    // point of the shape below: `count()` does NOT auto-wait, so asking it straight after a
    // `goto` answers 0 while the list is still in flight and this page would be skipped on
    // every run. The seed publishes no tender, so an empty list here is a fact about the
    // stand and not a failure — but it has to be the settled list that says so.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/buyer/events');
    await expect(page.locator('[role=status]')).toHaveCount(0, { timeout: 20_000 });
    const tender = page.locator('a[href^="/buyer/events/"]').first();
    if (await tender.count()) await assertFitsEveryWidth(page, (await tender.getAttribute('href'))!);

    // Below the breakpoint the page has the whole window and the way into the menu is a
    // button that says the word: an icon on its own is not read.
    await page.setViewportSize({ width: 375, height: 820 });
    await page.goto('/buyer/budgets');
    const rail = page.locator('.side');
    const menu = page.getByRole('button', { name: /^☰/ });
    await expect(rail).toBeHidden();
    await expect(menu).toContainText('Menu');
    await menu.click();
    await expect(rail).toBeVisible();
    // and it shuts itself the moment it is used — on a phone it covers the page it came from
    await rail.getByRole('link', { name: 'Requests', exact: true }).click();
    await page.waitForURL('**/buyer/requests');
    await expect(rail).toBeHidden();

    // A row is a card of «name: value» lines, and the name is the table's own column
    // heading: CSS cannot reach a header from the body, so components/narrow.ts puts it on
    // the cell. The settings page is where this is asked because its first table lists the
    // organization's users — it cannot be empty, whatever the other specs have left behind.
    await page.goto('/buyer/settings');
    // The FIRST table, pinned — the organization's own users, which cannot be empty. Not
    // «the first table that has a row»: that one re-resolves on every poll, and the users
    // and the departments below them are filled by two independent requests, so whichever
    // answered first would supply the heading and the other one the cell, failing later
    // with a message that reads as a stamping bug.
    const table = page.locator('table').first();
    const cell = table.locator('tbody td').first();
    await expect(cell).toBeVisible({ timeout: 20_000 });
    // Against the heading itself rather than a word typed in here: the contract is that the
    // label on a card IS the column it came from, in whatever language the panel is in.
    // Polled, because the stamping follows the rows into the DOM one frame behind them.
    const heading = (await table.locator('thead th').first().textContent())!.trim();
    expect(heading.length).toBeGreaterThan(0);
    await expect(cell).toHaveAttribute('data-label', heading);
    const card = await cell.evaluate((td) => ({
      display: getComputedStyle(td).display,
      printed: getComputedStyle(td, '::before').content,
      width: td.getBoundingClientRect().width,
      window: document.documentElement.clientWidth,
    }));
    expect(card.display).toBe('block');
    // and the stylesheet really prints it — a stamped attribute nothing draws is not a label
    expect(card.printed).not.toBe('none');
    // the table has the window now, not the strip that was left beside a 232px rail
    expect(card.width).toBeGreaterThan(card.window * 0.7);

    // And above the breakpoint none of it applies: the rail is back, the button is not
    // drawn, and a cell is a cell again.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(rail).toBeVisible();
    await expect(menu).toBeHidden();
    expect(await cell.evaluate((td) => getComputedStyle(td).display)).toBe('table-cell');
    await page.setViewportSize({ width: 1280, height: 900 });
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
    await assertRenders(page, '/learn', /Обучение|Learning|Təlim/);
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
    // By test id, not by the sentence: every list now says its own empty line (empty_market
    // here), so matching the generic «Nothing here yet» would find nothing whatever the page
    // did — vacuously green. The id holds for all three languages too.
    await expect(page.getByTestId('list-empty')).toHaveCount(0);
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

  // An empty list is an answer, and «Nothing here yet» was not one: on a new tenant it is
  // the first screen, and it left the reader guessing whether the section was broken,
  // forbidden or simply not started. Each list now names what fills it.
  test('an empty market says what fills it, not merely that it is empty', async () => {
    await page.route('**/events?**', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: '{"items":[],"total":0}',
    }));
    await page.goto('/supplier/market');
    const empty = page.getByTestId('list-empty');
    await expect(empty).toBeVisible({ timeout: 20_000 });
    // The sentence, not just the box: a generic line would satisfy the id alone.
    await expect(empty).toContainText('open announcements');
    await page.unroute('**/events?**');
  });

  // Only the text inputs answered focus; a button, a row action and a sidebar link kept
  // Chrome's blue ring, unreadable on the dark-green rail. Measured on the element the
  // browser actually focuses, because a declaration in the stylesheet proves nothing about
  // which element matched it.
  //
  // The assertions name OUR ring, not merely «a ring»: Chromium draws its own
  // `auto 1px rgb(16,16,16)` on a tabbed link, so `width > 0 && style !== 'none'` passed
  // on main too — a check that could not fail. `solid 2px` mint is only ours.
  test('keyboard focus draws a ring, a mouse click does not', async () => {
    await page.goto('/supplier/market');
    // Tab until focus is on a rail link, and say so in the assertions. One press is not
    // enough: straight after a goto the focus sits on the document, and the first Tab was
    // measured landing on BODY in CI. The loop is safe here only because what it stops on
    // is then checked — tag AND «inside .side» — so it cannot quietly measure something
    // else and call that a pass.
    // Clicking the heading is what gives the PAGE focus: without it the key presses land
    // nowhere at all — this describe shares one page across its tests in serial mode, and
    // after a test that only routed and reloaded there is nothing holding focus, so all
    // eight presses returned BODY (run 42282456679, on someone else's PR).
    //
    // It also fixes WHERE tabbing starts, which is the whole structure of this test: a click
    // on an unfocusable element sets the sequential focus starting point, so Tab goes forward
    // into the content and Shift+Tab backward into the rail, which precedes `.main` in the
    // DOM. Measuring forward first and then backward is how both colours get measured — and
    // they must both be measured, because one rule sets the ring and a second overrides its
    // colour on the dark fill, so a test that only ever saw one of them would let the other
    // be deleted in silence. Plain Tab from the top of the page was the earlier shape of
    // this, and it chose the element for us: it worked until the click moved the starting
    // point, then reported `inRail: false` and looked like a broken rule.
    const ring = async () => page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const s = getComputedStyle(el);
      return {
        tag: el.tagName, inRail: !!el.closest('.side'),
        width: parseFloat(s.outlineWidth) || 0, style: s.outlineStyle, color: s.outlineColor,
      };
    });
    const walk = async (key: 'Tab' | 'Shift+Tab', wanted: boolean) => {
      let r = await ring();
      for (let i = 0; i < 10; i++) {
        await page.keyboard.press(key);
        r = await ring();
        if (/^(A|BUTTON)$/.test(r.tag) && r.inRail === wanted) break;
      }
      return r;
    };

    await page.locator('h1').first().click();
    // Forward: into the content, where the ring is the accent green on a white card.
    const onCard = await walk('Tab', false);
    expect(onCard.tag).toMatch(/^(A|BUTTON)$/);
    expect(onCard.inRail).toBe(false);
    expect(onCard.style).toBe('solid');
    expect(onCard.width).toBe(2);
    expect(onCard.color).toBe('rgb(4, 120, 87)');

    await page.locator('h1').first().click();
    // Backward: into the rail, where the accent is invisible and the colour must be mint.
    const byKeyboard = await walk('Shift+Tab', true);
    expect(byKeyboard.tag).toMatch(/^(A|BUTTON)$/);
    expect(byKeyboard.inRail).toBe(true);
    expect(byKeyboard.style).toBe('solid');
    expect(byKeyboard.width).toBe(2);
    expect(byKeyboard.color).toBe('rgb(167, 243, 208)');
    // The other half, and the reason the rule is :focus-visible rather than :focus — the
    // guide recordings are driven by mouse, and a ring answering a click would sit in all
    // every one of them. A CLICK only: Chromium re-arms the heuristic on the next key press,
    // so a click followed by Escape does paint the ring (see styles.css).
    //
    // Deliberately a link OTHER than the one Tab stopped on, found by index rather than
    // assumed: the state is sticky, and clicking the very element that already carries the
    // keyboard ring does not take it away — measuring there would read 2px and say nothing
    // about the mouse.
    const links = page.locator('.side a');
    expect(await links.count()).toBeGreaterThan(1);
    const focused = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.side a')).indexOf(document.activeElement as HTMLAnchorElement));
    await links.nth(focused === 0 ? 1 : 0).click();
    const byMouse = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      return { tag: el.tagName, style: getComputedStyle(el).outlineStyle };
    });
    // The tag too: the reading could otherwise have come from <body>.
    expect(byMouse.tag).toBe('A');
    // A click paints NOTHING, and the measured state says so exactly: `outline-style: none`
    // with `outline-width: 3px`. The 3px is not a ring — width is a separate property from
    // style, nothing here sets it, so it sits at its CSS initial `medium`, which Chromium
    // computes as 3px; with the style `none` there is nothing to draw. Hence the first
    // version of this check, `width === 0`, could not pass in any case: 2px while the
    // keyboard ring was still on that element (the state is sticky, so clicking the element
    // Tab stopped on keeps it), 3px otherwise.
    //
    // So assert the style, which is the property that decides whether anything is drawn.
    // `solid` is what our rule produces, and a rule written `:focus` instead of
    // `:focus-visible` would make this line red — which is the whole point of it.
    //
    // `toBe('none')` on purpose, and deliberately stricter than the rule it guards: the rule
    // only promises that OUR ring stays away, this says nothing at all is drawn. Red here
    // therefore means the world moved — a UA ring arrived, or an outline came from elsewhere
    // — and that is worth reading, not relaxing back to `not.toBe('solid')`. The loose form
    // is how the colour check that stood here passed for ever: with `outline-style: none` the
    // colour is `currentColor`, measured `rgb(0, 0, 238)`, so «not mint» held whatever the
    // rule did. Guard the property that decides, not one that merely cannot disagree.
    expect(byMouse.style).toBe('none');
  });

  test('role guard: supplier cannot open buyer pages', async () => {
    await page.goto('/buyer/dashboard');
    // Protected redirects a supplier away from buyer routes
    await page.waitForURL((url) => !url.pathname.startsWith('/buyer'), { timeout: 10_000 });
  });

  // The course's own door, asked as BEHAVIOUR rather than as a declaration.
  //
  // learn-course.spec.ts already compares each lesson's `roles` with the array the router
  // guards that path with — but that compares two declarations, and would stay green if
  // `Protected` ever stopped deciding by `org.role`. The test above pins `Protected`
  // itself; this pins the button. The second half is what makes it a result: if a lesson
  // offered a door the route shuts, `Protected` would send this click to the home page,
  // and the URL assertion reds whatever the guard reads internally.
  //
  // The door is drawn inside the PLAYER, not on the row — one button for the lesson being
  // watched, not one per row on the list — so each half has to open its lesson first. Rows
  // carry `data-lesson`, so neither half is picked by position or by translated text.
  test('the course offers a supplier only the doors a supplier may open', async () => {
    await page.goto('/learn');
    await page.locator('[data-lesson="buyer-budgets"]').getByTestId('learn-play').click();
    await expect(page.getByTestId('learn-video')).toHaveAttribute('src', '/guides/buyer-budgets.az.webm');
    await expect(page.getByTestId('learn-goto'),
      'a supplier is offered the buyer budgets page, which the router will refuse').toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.locator('[data-lesson="sup-verification"]').getByTestId('learn-play').click();
    await page.getByTestId('learn-goto').click();
    await expect(page, 'the door the course offered did not open — Protected refused it')
      .toHaveURL(/\/supplier\/verification$/);
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

  // The market is the one list where the procedure decides whether to bid at all, and it
  // was the one tender list without the chip the buyer's list has carried since PR #71: a
  // closed tender, a live auction and a request for information looked identical until the
  // row was opened. Asserted on the heading, which renders even on an empty market — how
  // many rows are open depends on what the other specs left behind.
  test('the market names the procedure of every tender', async () => {
    await page.goto('/supplier/market');
    await expect(page.getByRole('columnheader', { name: 'Method', exact: true }))
      .toBeVisible({ timeout: 20_000 });
  });

  // Two halves of one finding: the buyer's panel got a hint under every figure in PR #68
  // and the supplier's got none, and verification sat in the row of numbers as a sixth
  // tile — a standing condition among counts, taller than the other five and breaking the
  // grid. Counting the tiles is what catches it coming back.
  test('supplier panel explains its figures and states verification beside them', async () => {
    await page.goto('/supplier/dashboard');
    const grid = page.getByTestId('sup-kpi');
    await expect(grid.locator('> div')).toHaveCount(5, { timeout: 20_000 });
    await expect(grid.locator('> div[data-tip]')).toHaveCount(5);
    await expect(page.getByTestId('sup-verification')).toBeVisible();
  });

  // The same narrow-screen contract on the supplier's side. These are different pages, and
  // of the two readers the supplier is the likelier one to be holding a phone.
  test('every supplier screen fits a phone and a tablet, and the menu is reachable there', async () => {
    test.setTimeout(180_000);
    // The card layout itself is proved on the buyer's side, on a table that cannot be empty;
    // it is one shared mechanism, so what is asked here is the widths and the menu.
    // `/learn` is NOT in this list, and that is a decision rather than an omission: it is
    // one component with one layout for both roles — the only role-dependent thing on it is
    // the door inside the player, which no width touches — and the buyer's walk above
    // measures it at all five widths. Measured here as well it bought nothing and cost this
    // chain a cold load: the supplier describe shares ONE page across its tests, every
    // `goto` is a cold load (the access token lives in memory), and /learn is the only page
    // in the product that waits for no list, so the next load starts while its own
    // `/auth/refresh` is still in flight. The run on 0576a38 ended with this test looking at
    // the LOGIN page — the session was gone before the menu was asked for — while the
    // buyer's thirteen-page walk with /learn in it passed in that same run, twice.
    for (const path of ['/supplier/dashboard', '/supplier/market', '/supplier/orders',
      '/supplier/contracts', '/supplier/invoices', '/supplier/catalogs', '/supplier/verification']) {
      await assertFitsEveryWidth(page, path);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/supplier/market');
    await expect(page.locator('[role=status]')).toHaveCount(0, { timeout: 20_000 });
    const tender = page.locator('a[href^="/supplier/events/"]').first();
    if (await tender.count()) await assertFitsEveryWidth(page, (await tender.getAttribute('href'))!);

    await page.setViewportSize({ width: 375, height: 820 });
    await page.goto('/supplier/orders');
    const rail = page.locator('.side');
    // The session first, and before the two checks below rather than after: on the login
    // page `.side` does not exist, so «the rail is hidden» passes vacuously and the failure
    // surfaces as a missing ☰ — which reads as a broken narrow layout. It is not one.
    await expect(page.getByRole('button', { name: /^☰/ }),
      'the supplier session is gone — this is not a layout failure').toBeVisible({ timeout: 20_000 });
    await expect(rail).toBeHidden();
    const menu = page.getByRole('button', { name: /^☰/ });
    await expect(menu).toContainText('Menu');
    await menu.click();
    // the supplier's own sections, not the buyer's, and the language switcher with them
    await expect(rail.getByRole('link', { name: 'Open tenders', exact: true })).toBeVisible();
    await expect(rail.locator('.lang')).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 900 });
  });
});
