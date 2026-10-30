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
