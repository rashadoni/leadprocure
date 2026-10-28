import { expect, test, type Browser, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
const apiRequire = createRequire(new URL('../../../api/package.json', import.meta.url));

type Call = (path: string, body: any, token?: string, method?: string, status?: number) => Promise<any>;

// Reuse the buyer/approver from the actual procurement scenario. The supplier
// registers in its own browser context, retaining that context's real httpOnly cookie.
// No copied session/token injection or extra password-login requests.
export async function verifyRfiRfp({ browser, buyerPage, call, buyerToken, approverToken, foreignSupplierToken, tag }: {
  browser: Browser; buyerPage: Page; call: Call; buyerToken: string;
  approverToken: string; foreignSupplierToken: string; tag: string;
}) {
  apiRequire('../../scripts/acceptance/assert-isolated.cjs')();
  const context = await browser.newContext({ baseURL: process.env.BASE_URL ?? 'http://localhost:5173', viewport: { width: 1280, height: 900 } });
  try {
    const registration = await context.request.post('http://localhost:3000/auth/register/supplier', { data: {
      legalName: `Rfx browser supplier ${tag}`, fullName: 'Rfx supplier',
      email: `rfx-browser-${tag}@audit.invalid`, password: 'Rfx-fixture-password123',
    } });
    expect(registration.status(), await registration.text()).toBe(201);
    const supplierPage = await context.newPage();
    await supplierPage.goto('/supplier/dashboard');
    await expect(supplierPage.locator('h1')).toBeVisible();
    const cases = [
      { type: 'RFI', lang: 'az', label: 'Cavab (mətn)', submit: 'Göndər', received: 'Təklif qəbul edildi' },
      { type: 'RFP', lang: 'ru', label: 'Техническое предложение', submit: 'Подать ставку', received: 'Предложение принято' },
      { type: 'RFP', lang: 'en', label: 'Technical proposal', submit: 'Place bid', received: 'Submission received' },
    ];
    for (const scenario of cases) await test.step(`${scenario.type} supplier/buyer native flow in ${scenario.lang}`, async () => {
      const title = `Rfx ${scenario.type} ${scenario.lang} ${tag}`, itemName = `Rfx item ${scenario.lang}`;
      const req = await call('/requests', { title, items: [{ name: itemName, qty: 1, estUnitPriceMinor: 10000 }] }, buyerToken);
      await call(`/requests/${req.id}/submit`, {}, buyerToken);
      await call(`/requests/${req.id}/approve`, {}, approverToken);
      const event = await call(`/events/from-request/${req.id}`, { type: scenario.type, visibility: 'PUBLIC', closeAt: new Date(Date.now() + 3600000).toISOString() }, buyerToken);
      await call(`/events/${event.id}/publish`, {}, buyerToken);
      await supplierPage.evaluate(lang => localStorage.setItem('lp_lang', lang), scenario.lang);
      await supplierPage.goto(`/supplier/events/${event.id}`);
      const marker = `Confidential ${scenario.type} ${scenario.lang} ${tag}`;
      const text = `${marker}\nSecond paragraph ${scenario.lang}`;
      await supplierPage.getByRole('textbox', { name: scenario.label, exact: true }).fill(text);
      if (scenario.type === 'RFP') {
        await supplierPage.locator('tr').filter({ hasText: itemName }).getByRole('spinbutton').fill('12.00');
      } else {
        await expect(supplierPage.getByRole('spinbutton')).toHaveCount(0);
      }
      const sent = supplierPage.waitForResponse(r => r.url().endsWith(`/events/${event.id}/bid`) && r.request().method() === 'POST');
      await supplierPage.getByRole('button', { name: `🔒 ${scenario.submit}`, exact: true }).click();
      const result = await sent;
      expect(result.status(), await result.text()).toBe(201);
      await expect(supplierPage.getByText(new RegExp(`^${scenario.received} · sha256`))).toBeVisible();
      await supplierPage.reload();
      await expect(supplierPage.getByRole('note', { name: scenario.label, exact: true })).toHaveText(text);
      // Actual authorized responses, not just hidden UI elements: buyer and another
      // supplier cannot obtain sealed technical text before the opening ceremony.
      const sealed = await call(`/events/${event.id}`, undefined, buyerToken, 'get', 200);
      expect(JSON.stringify(sealed)).not.toContain(marker);
      expect(sealed.bids[0].total_minor).toBeNull();
      const other = await call(`/events/${event.id}`, undefined, foreignSupplierToken, 'get', 200);
      expect(other.my_bid).toBeNull(); expect(JSON.stringify(other)).not.toContain(marker);
      await buyerPage.goto(`/buyer/events/${event.id}`);
      await expect(buyerPage.getByRole('heading', { level: 1 })).toContainText(title);
      await expect(buyerPage.getByText(marker, { exact: false })).toHaveCount(0);
      const { Client } = apiRequire('pg'), clock = new Client({ connectionString: process.env.DATABASE_OWNER_URL });
      await clock.connect();
      try {
        await clock.query(`UPDATE sourcing_events SET close_at=now()-interval '1 second' WHERE id=$1`, [event.id]);
        await clock.query(`SELECT * FROM close_due_events()`);
      } finally { await clock.end(); }
      await buyerPage.reload();
      const openedResponse = buyerPage.waitForResponse(r => r.url().endsWith(`/events/${event.id}/open`) && r.request().method() === 'POST');
      await buyerPage.getByRole('button', { name: /^Open bids\b/ }).click();
      expect((await openedResponse).status()).toBe(201);
      await expect(buyerPage.getByText(`📝 ${text}`, { exact: true })).toBeVisible();
      const opened = await call(`/events/${event.id}`, undefined, buyerToken, 'get', 200);
      expect(opened.bids[0].proposal_text).toBe(text);
      if (scenario.type === 'RFI') {
        expect(opened.bids[0].total_minor).toBeNull();
        await expect(buyerPage.getByRole('button', { name: 'Score', exact: true })).toHaveCount(0);
        await expect(buyerPage.getByRole('button', { name: /^Award winner\b/ })).toHaveCount(0);
        await expect(buyerPage.getByRole('button', { name: /^Analyze\b/ })).toHaveCount(0);
        await call(`/events/${event.id}/award`, { lotId: event.lots[0].id, bidId: opened.bids[0].id }, buyerToken, 'post', 400);
      } else {
        expect(Number(opened.bids[0].total_minor)).toBe(1200);
        await expect(buyerPage.getByRole('button', { name: 'Score', exact: true })).toBeVisible();
      }
      await supplierPage.reload();
      await expect(supplierPage.getByRole('note', { name: scenario.label, exact: true })).toHaveText(text);
      const otherAfter = await call(`/events/${event.id}`, undefined, foreignSupplierToken, 'get', 200);
      expect(otherAfter.my_bid).toBeNull(); expect(JSON.stringify(otherAfter)).not.toContain(marker);
    });
  } finally { await context.close(); }
}
