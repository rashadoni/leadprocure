import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { verifyBudgetReport } from './helpers/budget-report';
const apiRequire = createRequire(new URL('../../api/package.json', import.meta.url));

test('finance sees and completes its assigned approval step without procurement controls', async ({ page, request }) => {
  apiRequire('../../scripts/acceptance/assert-isolated.cjs')();
  const base = 'http://localhost:3000', tag = Date.now().toString(36), password = 'Fixture-password123';
  const call = async (path: string, body: any, token?: string, method = 'post') => {
    const r = await request.fetch(base + path, { method, data: body, headers: token ? { Authorization: `Bearer ${token}` } : {} });
    expect(r.ok(), await r.text()).toBe(true); return r.json();
  };
  const buyer = await call('/auth/register/buyer', { legalName: `Finance UI ${tag}`, fullName: 'Admin', email: `admin-${tag}@audit.invalid`, password });
  const email = `finance-${tag}@audit.invalid`;
  await call('/settings/users', { email, fullName: 'Finance', password, role: 'BUYER_FINANCE' }, buyer.accessToken);
  await call('/requests/approval-policies', { policies: [{ minAmountMinor: 0, maxAmountMinor: null, steps: [{ order: 1, role: 'BUYER_FINANCE' }] }] }, buyer.accessToken, 'put');
  const title = `Assigned finance ${tag}`;
  const req = await call('/requests', { title, items: [{ name: 'Item', qty: 1, estUnitPriceMinor: 1000 }] }, buyer.accessToken);
  await call(`/requests/${req.id}/submit`, {}, buyer.accessToken);
  // Sign in normally in this native browser context; no fixture token injection.
  await page.addInitScript(() => localStorage.setItem('lp_lang', 'en'));
  await page.goto('/login'); await page.fill('input[type=email]', email); await page.fill('input[type=password]', password);
  await page.click('form button.btn:not(.ghost):not([type=button])'); await page.waitForURL(/\/buyer\//);
  await page.goto('/buyer/requests');
  const row = page.locator('tr').filter({ hasText: title });
  await expect(row.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
  // Кнопку, а не поле: форма теперь за кнопкой, и поля нет ни у одной роли, пока её не
  // нажали, — проверка на поле стала зелёной при любом исходе. Запрет для финансиста
  // держится на том, что ему не достаётся даже кнопки.
  await expect(page.getByTestId('req-new')).toHaveCount(0);
  await row.getByRole('button', { name: 'Approve', exact: true }).click();
  await row.getByRole('button', { name: /Confirm approval/ }).click();
  await expect(row.locator('.badge')).toHaveClass(/APPROVED/);
  await expect(row.getByRole('button')).toHaveCount(0);
  await page.goto('/buyer/budgets');
  const planForm = page.locator('form');
  await expect(planForm).toBeVisible();
  await planForm.locator('input').first().fill(`Finance plan ${tag}`);
  await planForm.locator('input[step="0.01"]').fill('100.01');
  await planForm.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('tr').filter({ hasText: `Finance plan ${tag}` })).toBeVisible();
  await verifyBudgetReport({page,call,buyerToken:buyer.accessToken,tag});
});
