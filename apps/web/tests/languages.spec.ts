import {test,expect} from '@playwright/test';
for(const [language,title] of [['az','Analitika'],['ru','Аналитика'],['en','Analytics']] as const){
  test(`buyer analytics uses ${language} and separates currencies`,async({page})=>{
    await page.addInitScript(lang=>localStorage.setItem('lp_lang',lang),language);
    await page.goto('/login');await page.fill('input[type=email]','admin@acme.test');await page.fill('input[type=password]','Passw0rd!');
    await page.click('form button.btn:not(.ghost):not([type=button])');await page.waitForURL(/\/buyer\//);
    await page.goto('/buyer/analytics');await expect(page.locator('h1')).toHaveText(title);
    const request=page.waitForResponse(r=>r.url().includes('/dashboard/spend-analytics')&&r.url().includes('currency=USD'));
    await page.getByTestId('analytics-currency').selectOption('USD');
    expect((await (await request).json()).currency).toBe('USD');
    await expect(page.getByText('Unexpected Application Error')).toHaveCount(0);
  });
}

// The sign-in page was the one screen with no language switcher: everything after it has
// one in the sidebar, which is behind the sign-in. A supplier who reads only Azerbaijani
// met whatever language the last visitor left behind, and no way out of it. No login here,
// so this costs nothing against the 10/min limit on /auth/login.
test('the sign-in page offers all three languages and switches at once', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('lp_lang', 'en'));
  await page.goto('/login');
  const picker = page.locator('.auth .lang');
  await expect(picker.getByRole('button')).toHaveCount(3);
  // The label carries the password rule beside the word, so match the LABEL and not the
  // whole string: an exact match broke the moment the rule moved into it.
  const passwordLabel = page.locator('label[for="login-password"]');
  await expect(passwordLabel).toContainText('Password');
  await picker.getByRole('button', { name: 'RU', exact: true }).click();
  await expect(passwordLabel).toContainText('Пароль');
  await picker.getByRole('button', { name: 'AZ', exact: true }).click();
  await expect(passwordLabel).toContainText('Şifrə');
  // The card was a fixed 380px wide: on a 375px phone the very first screen of the product
  // scrolled sideways before anyone had typed anything. Measured here because this test
  // already has a browser on the sign-in page and makes no login request of its own.
  await page.setViewportSize({ width: 375, height: 720 });
  const over = await page.evaluate(() => {
    const el = document.scrollingElement!;
    return el.scrollWidth - el.clientWidth;
  });
  expect(over, `the sign-in page scrolls sideways by ${over}px`).toBeLessThanOrEqual(1);
});
