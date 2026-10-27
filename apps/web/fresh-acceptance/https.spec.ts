import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';

const api = 'https://api.leadprocure.test:39443';
test('real HTTPS login, secure refresh across reloads, browser CORS and private upload', async ({ page, context }) => {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
    throw new Error('Fresh browser acceptance requires the disposable hosted fixture');
  }
  const account = JSON.parse(readFileSync(process.env.FRESH_BROWSER_ACCOUNT_FILE!, 'utf8'));
  await page.addInitScript(() => localStorage.setItem('lp_lang', 'en'));
  await page.goto('/login');
  expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
  await expect(page.locator('text=admin@acme.test')).toHaveCount(0);
  await page.locator('input[type=email]').fill(account.email);
  await page.locator('input[type=password]').fill(account.password);
  const loginResponse = page.waitForResponse(r => r.url() === `${api}/auth/login` && r.request().method() === 'POST');
  await page.locator('form button.btn:not(.ghost):not([type=button])').click();
  const loggedIn = await loginResponse;
  expect(loggedIn.status()).toBe(201);
  expect(loggedIn.headers()['access-control-allow-origin']).toBe('https://app.leadprocure.test:39443');
  expect(loggedIn.headers()['access-control-allow-credentials']).toBe('true');
  await page.waitForURL(/\/buyer\/requests$/);
  const cookie = (await context.cookies(api)).find(c => c.name === 'lp_refresh');
  expect(cookie).toBeDefined();
  expect(cookie!.secure).toBe(true); expect(cookie!.httpOnly).toBe(true);
  expect(cookie!.sameSite).toBe('Lax'); expect(cookie!.domain).toBe('api.leadprocure.test');
  expect(await page.evaluate(() => document.cookie)).not.toContain('lp_refresh');
  expect(await page.evaluate(() => Object.keys(localStorage).some(k => /token|session/i.test(k)))).toBe(false);
  for (let round = 0; round < 3; round++) {
    const refresh = page.waitForResponse(r => r.url() === `${api}/auth/refresh` && r.request().method() === 'POST');
    await page.reload();
    expect((await refresh).status()).toBe(201);
    await expect(page.locator('h1').first()).toContainText('Requests');
  }
  await page.goto('/buyer/budgets');
  await expect(page.locator('h1').first()).toContainText('Budgets');
  await expect(page.getByText(account.budgetName, { exact: true })).toBeVisible();

  // Obtain an access token through the real cookie refresh endpoint, in-browser.
  // No saved state, forged tokens or cookies copied from another provider.
  const privateUpload = await page.evaluate(async ({ api }) => {
    const refresh = await fetch(`${api}/auth/refresh`, { method: 'POST', credentials: 'include' });
    const { accessToken } = await refresh.json();
    const pre = await fetch(`${api}/documents/presign`, { method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ filename: 'browser-cors.txt', mime: 'text/plain' }) });
    const { uploadUrl } = await pre.json();
    const put = await fetch(uploadUrl, { method: 'PUT', body: 'HTTPS browser attachment',
      headers: { 'Content-Type': 'text/plain' } });
    return { refresh: refresh.status, presign: pre.status, put: put.status, origin: new URL(uploadUrl).origin };
  }, { api });
  expect(privateUpload).toEqual({ refresh: 201, presign: 201, put: 200, origin: 'https://s3.leadprocure.test:39443' });

  const blockedPage = await context.newPage();
  // A real HTTPS page on a different origin, without application bootstrap.
  await blockedPage.goto('https://blocked.leadprocure.test:39443');
  const blocked = await blockedPage.evaluate(async ({ api }) => {
    try {
      await fetch(`${api}/auth/refresh`, { method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: '{}' });
      return false;
    } catch { return true; }
  }, { api });
  expect(blocked).toBe(true);
  await blockedPage.close();
  await page.getByRole('link', { name: 'Log out', exact: true }).click();
  await page.waitForURL(/\/login$/);
  expect((await context.cookies(api)).some(c => c.name === 'lp_refresh')).toBe(false);
  await page.goto('/buyer/budgets'); await page.waitForURL(/\/login$/);
  writeFileSync(process.env.FRESH_BROWSER_EVIDENCE_FILE!, JSON.stringify({
    status: 'PASS', trustedTestCA: true, productionBuild: true, actualUILogin: true,
    secureHttpOnlyCookie: true, reloadRefreshes: 3, allowedCors: true,
    deniedForeignOrigin: true, httpsStorageBrowserPut: true, logoutRevokesSession: true,
    publicCertificateOrClientDeployment: false,
  }, null, 2));
});
