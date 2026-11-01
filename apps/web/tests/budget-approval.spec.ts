import { test, expect } from '@playwright/test';
import { answerDialog, expectToast } from './helpers/dialogs';
import { createRequire } from 'node:module';
const apiRequire = createRequire(new URL('../../api/package.json', import.meta.url));

test('approval dialogs respect current budget policy and show AZ/RU/EN reasons', async ({ page, request }) => {
  apiRequire('../../scripts/acceptance/assert-isolated.cjs')();
  const base = 'http://localhost:3000', tag = Date.now().toString(36), password = 'Fixture-password123';
  const call = async (path: string, body: any, token?: string, method = 'post') => {
    const r = await request.fetch(base + path, { method, data: body, headers: token ? { Authorization: `Bearer ${token}` } : {} });
    expect(r.ok(), await r.text()).toBe(true); return r.json();
  };
  const buyer = await call('/auth/register/buyer', { legalName: `Budget dialogs ${tag}`, fullName: 'Requester', email: `budget-requester-${tag}@audit.invalid`, password });
  const email = `budget-approver-${tag}@audit.invalid`;
  await call('/settings/users', { email, fullName: 'Approving admin', password, role: 'BUYER_ADMIN' }, buyer.accessToken);
  // Actual authentication in the selected browser context. Its own httpOnly cookie is
  // used by the SPA; no token injection or copied session, one login for all languages.
  const login = await page.request.post(base + '/auth/login', { data: { email, password } });
  expect(login.ok(), await login.text()).toBe(true);
  const admin = (await login.json()).accessToken;
  const budget = await call('/budgets', { name: `Zero plan ${tag}`, category: 'UI_BLOCK', periodYear: new Date().getUTCFullYear(), amountMinor: 0 }, buyer.accessToken);
  await call(`/budgets/${budget.id}/submit`, {}, buyer.accessToken);
  await call(`/budgets/${budget.id}/approve`, {}, admin);
  const policy = (allowOverride: boolean) => call('/budgets/policy', { warnPct: 80, blockPct: 100, allowOverride }, buyer.accessToken, 'put');
  const makeRequest = async (label: string, token = buyer.accessToken) => {
    const r = await call('/requests', { title: `${label} ${tag}`, category: 'UI_BLOCK', items: [{ name: 'Item', qty: 1, estUnitPriceMinor: 1000 }] }, token);
    await call(`/requests/${r.id}/submit`, {}, token); return r;
  };
  const locales = [
    { lang: 'az', approve: 'Təsdiqlə', confirm: 'Təsdiqi təsdiq et', blocked: 'Büdcə həddi aşılır. Sorğu təsdiqlənmədi.' },
    { lang: 'ru', approve: 'Утвердить', confirm: 'Подтвердить утверждение', blocked: 'Превышен лимит бюджета. Заявка не утверждена.' },
    { lang: 'en', approve: 'Approve', confirm: 'Confirm approval', blocked: 'The budget limit is exceeded. The request was not approved.' },
  ];
  await page.goto('/buyer/requests');
  for (const locale of locales) {
    await policy(false);
    const r = await makeRequest(locale.lang);
    await page.evaluate((lang) => localStorage.setItem('lp_lang', lang), locale.lang);
    await page.goto('/buyer/requests');
    const row = page.locator('tr').filter({ hasText: r.title });
    const impactResponse = page.waitForResponse((response) => response.url().endsWith(`/budgets/impact/${r.id}`));
    await row.getByRole('button', { name: locale.approve, exact: true }).click();
    expect((await (await impactResponse).json()).wouldBlock).toBe(true);
    // Wait for the real preview too: a stale wouldBlock must not authorize an override.
    await expect(row.getByRole('button', { name: locale.confirm, exact: true })).toBeVisible();
    await row.getByRole('button', { name: locale.confirm, exact: true }).click();
    await expectToast(page, locale.blocked);
    const persisted = await call(`/requests/${r.id}`, undefined, buyer.accessToken, 'get');
    expect(persisted.status).toBe('SUBMITTED');
  }
  // Policy changes after the preview are decided by the server, not cached UI data.
  await policy(true);
  const r = await makeRequest('Allowed override');
  await page.goto('/buyer/requests');
  const row = page.locator('tr').filter({ hasText: r.title });
  const enabledImpact = page.waitForResponse((response) => response.url().endsWith(`/budgets/impact/${r.id}`));
  await row.getByRole('button', { name: 'Approve', exact: true }).click();
  expect((await (await enabledImpact).json()).wouldBlock).toBe(true);
  await policy(false); // policy disabled after the preview
  await row.getByRole('button', { name: 'Confirm approval', exact: true }).click();
  await expectToast(page, locales[2].blocked);
  await policy(true);
  await row.getByRole('button', { name: 'Confirm approval', exact: true }).click();
  // A QUESTION, not a refusal: the override is offered, and answering it approves. If the
  // server refused instead there would be no field to fill and this would fail here.
  await answerDialog(page, 'Urgent purchase approved by CFO');
  await expect(row.locator('.badge')).toHaveClass(/APPROVED/);
  // Another 403 must never become a budget override, even when the preview blocks.
  const own = await makeRequest('Own request', admin);
  await page.goto('/buyer/requests');
  const ownRow = page.locator('tr').filter({ hasText: own.title });
  const ownImpact = page.waitForResponse((response) => response.url().endsWith(`/budgets/impact/${own.id}`));
  await ownRow.getByRole('button', { name: 'Approve', exact: true }).click();
  expect((await (await ownImpact).json()).wouldBlock).toBe(true);
  await ownRow.getByRole('button', { name: 'Confirm approval', exact: true }).click();
  // Any other 403 is a refusal, never an override offer: a message, with no field to fill.
  await expectToast(page, 'You cannot approve your own request. Another approver is required.');
  await expect(page.getByTestId('dialog-input')).toHaveCount(0);
  expect((await call(`/requests/${own.id}`, undefined, admin, 'get')).status).toBe('SUBMITTED');
});
