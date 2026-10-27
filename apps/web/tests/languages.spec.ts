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
