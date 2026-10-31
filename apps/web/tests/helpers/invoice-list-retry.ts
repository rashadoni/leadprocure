import { expect, test, type Page, type Route } from '@playwright/test';

// Reuse actual buyer/supplier browser authentication and the existing PAID
// fixture. Only the failed transport is controlled; retry reads the real API.
export async function verifyInvoiceListRetry({ page, supplierPage, invoiceNo, poNo }: {
  page: Page; supplierPage: Page; invoiceNo: string; poNo: string;
}) {
  for (const [actor, path] of [[page, '/buyer/invoices'], [supplierPage, '/supplier/invoices']] as const) {
    for (const [lang, error, retry, loading] of [
      ['AZ', 'Qaimələr siyahısını yükləmək mümkün olmadı.', 'Yenidən yoxla', 'Qaimələr yüklənir…'],
      ['RU', 'Не удалось загрузить список счетов.', 'Повторить', 'Загрузка счетов…'],
      ['EN', 'Could not load invoices.', 'Retry', 'Loading invoices…'],
    ]) {
      await test.step(`${path} list failure and real retry ${lang}`, async () => {
        await actor.locator('.lang').getByRole('button', { name: lang, exact: true }).click();
        const isList = (url: URL) => url.pathname === '/invoices';
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const pending: Promise<void>[] = [];
        const fail = (route: Route) => {
          const task = (async () => {
            expect(route.request().method()).toBe('GET');
            await gate;
            await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
          })();
          pending.push(task); return task;
        };
        const pageErrors: string[] = [];
        const onError = (error: Error) => pageErrors.push(error.message);
        actor.on('pageerror', onError);
        await actor.route(isList, fail);
        try {
          await actor.goto(path);
          await expect(actor.getByRole('status').filter({ hasText: loading })).toBeVisible();
          const failed = actor.waitForResponse(r => isList(new URL(r.url())) && r.request().method() === 'GET');
          release();
          expect((await failed).status()).toBe(503);
          const alert = actor.getByRole('alert').filter({ hasText: error });
          await expect(alert).toBeVisible();
          await expect(actor.locator('tbody tr')).toHaveCount(0);
          await expect(actor.getByRole('status').filter({ hasText: loading })).toHaveCount(0);
          await actor.unroute(isList, fail);
          const loaded = actor.waitForResponse(r => isList(new URL(r.url())) && r.request().method() === 'GET');
          await alert.getByRole('button', { name: retry, exact: true }).click();
          const response = await loaded;
          expect(response.status(), await response.text()).toBe(200);
          const data = await response.json();
          const actual = data.find((row: any) => row.invoice_no === invoiceNo && row.po_no === poNo);
          expect(actual.status).toBe('PAID');
          expect([actual.net_minor, actual.vat_minor, actual.gross_minor].map(Number)).toEqual([1200, 216, 1416]);
          const row = actor.locator('tr').filter({ has: actor.getByRole('link', { name: invoiceNo, exact: true }) })
            .filter({ has: actor.getByRole('cell', { name: poNo, exact: true }) });
          await expect(row.locator('.badge.PAID')).toBeVisible();
          await expect(alert).toHaveCount(0);
          expect(pageErrors).toEqual([]);
        } finally {
          release(); await Promise.allSettled(pending);
          await actor.unroute(isList, fail);
          actor.off('pageerror', onError);
        }
      });
    }
  }
}

type Call = (path: string, body: any, token?: string, method?: string, status?: number) => Promise<any>;
const controlName = (label: string) => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`);

// The refresh that follows a confirmed mutation is a list read like any other: opening a
// card while it is still running must not cancel it. Before this case an opened detail
// invalidated that read, so its failure was swallowed — no error, no retry, stale rows.
// Only the list transport is controlled; the mutation, the detail read and the retry are
// real. API calls below only prepare the fixture.
export async function verifyRefreshFailureDuringDetail({ page, call, buyerToken, approverToken, supplierToken, supplierOrgId, tag }: {
  page: Page; call: Call; buyerToken: string; approverToken: string;
  supplierToken: string; supplierOrgId: string; tag: string;
}) {
  await test.step('an opened card cannot hide a failed post-mutation list refresh', async () => {
    const req = await call('/requests', { title: `Invoice refresh failure ${tag}`, items: [{ name: 'Refresh item', qty: 2, estUnitPriceMinor: 1200 }] }, buyerToken);
    await call(`/requests/${req.id}/submit`, {}, buyerToken);
    await call(`/requests/${req.id}/approve`, {}, approverToken);
    const po = await call(`/orders/direct/from-request/${req.id}`, { supplierOrgId }, buyerToken);
    await call(`/orders/${po.id}/status`, { status: 'ISSUED' }, buyerToken);
    for (const status of ['CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED']) await call(`/orders/${po.id}/status`, { status }, supplierToken);
    await call(`/orders/${po.id}/receipts`, { items: [{ poItemId: po.items[0].id, qty: 2 }] }, buyerToken);
    const invoice = await call(`/invoices/from-po/${po.id}`, { items: [{ poItemId: po.items[0].id, qty: 1, unitPriceMinor: 1200 }] }, supplierToken);
    expect(invoice.status).toBe('MATCHED');

    await page.goto('/buyer/invoices');
    await page.locator('.lang').getByRole('button', { name: 'EN', exact: true }).click();
    const row = page.locator('tr').filter({ has: page.getByRole('link', { name: invoice.invoice_no, exact: true }) })
      .filter({ has: page.getByRole('cell', { name: po.po_no, exact: true }) });
    await expect(row.locator('.badge.MATCHED')).toBeVisible();
    const heading = page.getByRole('heading', { level: 3 }).filter({ hasText: invoice.invoice_no });
    const loading = page.getByRole('status').filter({ hasText: 'Loading invoices…' });
    const alert = page.getByRole('alert').filter({ hasText: 'Could not load invoices.' });

    const isList = (url: URL) => url.pathname === '/invoices';
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const handlers: Promise<void>[] = [];
    let held = 0;
    const holdThenFail = (route: Route) => {
      const task = (async () => {
        expect(route.request().method()).toBe('GET');
        held++;
        await gate;
        await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      })();
      handlers.push(task); return task;
    };
    const pageErrors: string[] = [];
    const onError = (error: Error) => pageErrors.push(error.message);
    page.on('pageerror', onError);
    await page.route(isList, holdThenFail);
    try {
      const approved = page.waitForResponse(r => r.url().endsWith(`/invoices/${invoice.id}/approve`) && r.request().method() === 'POST');
      const [response] = await Promise.all([approved, row.getByRole('button', { name: controlName('Approve') }).click()]);
      expect(response.status(), await response.text()).toBe(201);
      await expect(row.locator('.badge.APPROVED')).toBeVisible();
      await expect.poll(() => held).toBe(1);
      await expect(loading).toBeVisible();
      // Open the card while the refresh is still in flight: the real detail read lands first.
      await row.getByRole('link').click();
      await expect(heading.locator('.badge.APPROVED')).toBeVisible();
      await expect(loading).toBeVisible(); // the refresh is still running, and still ours
      release(); await Promise.all(handlers);
      await expect(alert).toBeVisible();
      await expect(loading).toHaveCount(0);
      await expect(row.locator('.badge.APPROVED')).toBeVisible();
      await expect(heading.locator('.badge.APPROVED')).toBeVisible();
      await page.unroute(isList, holdThenFail);
      const reloaded = page.waitForResponse(r => isList(new URL(r.url())) && r.request().method() === 'GET');
      await alert.getByRole('button', { name: 'Retry', exact: true }).click();
      expect((await reloaded).status()).toBe(200);
      await expect(alert).toHaveCount(0);
      await expect(row.locator('.badge.APPROVED')).toBeVisible();
      expect((await call(`/invoices/${invoice.id}`, undefined, buyerToken, 'get', 200)).status).toBe('APPROVED');
      expect(pageErrors).toEqual([]);
    } finally {
      release(); await Promise.allSettled(handlers);
      await page.unroute(isList, holdThenFail);
      page.off('pageerror', onError);
    }
  });
}
