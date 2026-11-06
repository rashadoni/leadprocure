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

  // The buyer's own facts are on it, and the request it came from is one of them. By the
  // text and not by `.fact-row`: the page draws two of those blocks — the order's own facts
  // and the chain it came out of — so matching the class is a strict-mode violation, and
  // picking one of them by number would be the layout standing in for the claim.
  await expect(page.getByText(req.request_no, { exact: false }).first()).toBeVisible();

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

  // The supplier's rendered side is NOT checked here, and that is a resource decision
  // rather than an oversight. `/auth/login` is throttled to 10/min on purpose (brute force
  // and argon2), Playwright runs spec files in parallel, and a second browser login in this
  // one spec put it over the line in CI: the supplier's login came back 429 and the test
  // failed as a navigation timeout, which reads like a broken app. The claim it would have
  // made — that the supplier sees the lines and none of the buyer's internals — is pinned
  // where it costs no login at all, on the response itself:
  // `apps/api/test/order-card.e2e-spec.ts`, «shows the supplier the order, and none of the
  // buyer's internals», which also greps the whole body for the request number.
});
