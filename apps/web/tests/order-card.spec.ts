import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const apiRequire = createRequire(new URL('../../api/package.json', import.meta.url));

// The way a reader actually reaches an order: a number in a table, clicked.
//
// This builds its own order through the API first, and that is the point rather than
// convenience — the dev seed creates no request, tender, contract or order at all, so a
// version of this walk inside `smoke.spec.ts` found no PO link and could only have been
// made green by skipping itself. A check that skips on the stand it runs on is the kind of
// gate this product has spent a day removing.
test('the order number leads to the order, and the order says what was ordered', async ({ page, request }) => {
  apiRequire('../../scripts/acceptance/assert-isolated.cjs')();
  const base = 'http://localhost:3000', tag = Date.now().toString(36), password = 'Audit-only-password123';
  const call = async (path: string, body?: any, token?: string, method = 'post', status = 201) => {
    const r = await request.fetch(base + path, { method, data: body, headers: token ? { Authorization: `Bearer ${token}` } : {} });
    expect(r.status(), await r.text()).toBe(status); return r.json();
  };
  const register = (kind: string, name: string) => call(`/auth/register/${kind}`,
    { legalName: `Order card ${name} ${tag}`, email: `${name}-${tag}@audit.invalid`, password, fullName: name });

  const buyer = await register('buyer', 'ocbuyer');
  const supplier = await register('supplier', 'ocsup');
  await call('/settings/users', { email: `ocappr-${tag}@audit.invalid`, fullName: 'Approver', password, role: 'BUYER_APPROVER' }, buyer.accessToken);
  const approver = await call('/auth/login', { email: `ocappr-${tag}@audit.invalid`, password });

  // A direct order: the shortest honest path to a PO with lines on it. The relationship has
  // to be approved and the amount has to land in a DIRECT band, or the API refuses — both
  // are the product's rules, not test scaffolding.
  await call(`/suppliers/${supplier.org.id}/invite`, {}, buyer.accessToken);
  const rels = await call('/suppliers', undefined, buyer.accessToken, 'get', 200);
  const rel = rels.find((r: any) => r.supplier_org_id === supplier.org.id);
  await call(`/suppliers/relationships/${rel.id}/status`, { status: 'APPROVED' }, buyer.accessToken);
  await call('/requests/method-policies', { policies: [{ category: '*', minAmountMinor: 0, maxAmountMinor: null, method: 'DIRECT' }] }, buyer.accessToken, 'put', 200);
  const req = await call('/requests', { title: `Order card ${tag}`, items: [
    { name: 'Office chair', qty: 4, estUnitPriceMinor: 90_000 },
    { name: 'Desk lamp', qty: 2, estUnitPriceMinor: 15_000 },
  ] }, buyer.accessToken);
  await call(`/requests/${req.id}/submit`, {}, buyer.accessToken);
  await call(`/requests/${req.id}/approve`, {}, approver.accessToken);
  const po = await call(`/orders/direct/from-request/${req.id}`, { supplierOrgId: supplier.org.id }, buyer.accessToken);
  // ISSUED, so the status history has a step in it and not only the row it was created on.
  await call(`/orders/${po.id}/status`, { status: 'ISSUED' }, buyer.accessToken);

  await page.addInitScript(() => localStorage.setItem('lp_lang', 'en'));
  await page.goto('/login');
  await page.fill('input[type=email]', `ocbuyer-${tag}@audit.invalid`);
  await page.fill('input[type=password]', password);
  await page.click('form button.btn:not(.ghost):not([type=button])');
  await page.waitForURL(/\/buyer\//, { timeout: 20_000 });

  // From here on nothing is addressed by a path written into the test: the number is found
  // in the table, and where it goes is whatever the table says.
  await page.goto('/buyer/contracts');
  const link = page.getByRole('link', { name: po.po_no, exact: true });
  await expect(link).toBeVisible({ timeout: 20_000 });
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/buyer/orders/${po.id}$`), { timeout: 20_000 });

  // The number the reader clicked is the heading of the page they land on; anything else
  // means the href was built from the wrong row.
  await expect(page.locator('h1')).toContainText(po.po_no);

  // What was ordered — invisible anywhere in the product before this page existed.
  const lines = page.getByTestId('order-lines');
  await expect(lines).toBeVisible();
  await expect(lines.locator('tbody tr')).toHaveCount(2);
  await expect(lines).toContainText('Office chair');
  await expect(lines).toContainText('Desk lamp');
  // Ordered, and received against it: nothing has arrived yet, so the comparison the page
  // exists for reads 4 against 0 rather than a blank.
  const chair = lines.locator('tbody tr').filter({ hasText: 'Office chair' });
  await expect(chair.locator('td.num').first()).toHaveText('4');

  // And how it got here, which lived only in the database until this page.
  const history = page.getByTestId('order-history');
  await expect(history.locator('tbody tr')).not.toHaveCount(0);
  // By the status CLASS, not by its words: every status label is localized (EN «Order
  // issued to supplier», RU «Заказ выпущен поставщику»), and asserting the text is how a
  // check stops matching the day someone edits the dictionary. AGENTS.md says exactly this
  // about badges, and I broke the rule on the first try.
  await expect(history.locator('.badge.ISSUED')).toBeVisible();

  // The buyer's own facts are on it, and the request it came from is one of them.
  await expect(page.locator('.fact-row')).toContainText(req.request_no);

  // The widest table in the product, measured where it is widest and where it is tightest.
  // `assertFitsEveryWidth` in smoke.spec.ts cannot reach this page — on the seeded stand
  // there is no order to open — so the measurement lives with the test that built one.
  for (const width of [1440, 1280, 1024, 768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    const over = await page.evaluate(() =>
      Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
    expect(over, `the order card scrolls sideways by ${over}px at ${width}px`).toBeLessThanOrEqual(1);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  // The supplier's side of the same document: same lines, and none of the buyer's internals
  // on screen. The API test pins the response; this pins what is rendered from it.
  // baseURL explicitly: a context made by hand does not inherit the config's `use`, and
  // without it `goto('/login')` resolves against nothing (see helpers/rfx.ts).
  const sup = await page.context().browser()!.newContext({
    baseURL: process.env.BASE_URL ?? 'http://localhost:5173', viewport: { width: 1280, height: 900 },
  });
  const supPage = await sup.newPage();
  try {
    await supPage.addInitScript(() => localStorage.setItem('lp_lang', 'en'));
    await supPage.goto('/login');
    await supPage.fill('input[type=email]', `ocsup-${tag}@audit.invalid`);
    await supPage.fill('input[type=password]', password);
    await supPage.click('form button.btn:not(.ghost):not([type=button])');
    await supPage.waitForURL(/\/supplier\//, { timeout: 20_000 });
    await supPage.goto(`/supplier/orders/${po.id}`);
    await expect(supPage.getByTestId('order-lines')).toContainText('Office chair');
    await expect(supPage.locator('body')).not.toContainText(req.request_no);
  } finally {
    await supPage.close(); await sup.close();
  }
});
