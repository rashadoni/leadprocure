import { expect, test, type Locator, type Page, type Route } from '@playwright/test';

const renderFinished = (page: Page) => page.evaluate(() => new Promise<void>(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

// Hold an actual authorized API response, rather than manufacture an old status.
// The browser's requestfinished event and rendering frames drain the released read.
async function holdDetail({ page, id, status, run }: {
  page: Page; id: string; status: string;
  run: (held: () => number, release: () => Promise<void>) => Promise<void>;
}) {
  const path = `/invoices/${id}`, pattern = `**${path}`;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held = 0, finished = 0;
  const handlers: Promise<void>[] = [];
  const onFinished = (request: any) => {
    if (new URL(request.url()).pathname === path && request.method() === 'GET') finished++;
  };
  const barrier = (route: Route) => {
    const task = (async () => {
      expect(route.request().method()).toBe('GET');
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      expect((await response.json()).status).toBe(status);
      held++;
      await gate;
      await route.fulfill({ response });
    })();
    handlers.push(task); return task;
  };
  page.on('requestfinished', onFinished);
  await page.route(pattern, barrier);
  try {
    await run(() => held, async () => {
      release(); await Promise.all(handlers);
      await expect.poll(() => finished).toBe(handlers.length);
      await renderFinished(page);
    });
  } finally {
    release(); await Promise.allSettled(handlers);
    await page.unroute(pattern, barrier); page.off('requestfinished', onFinished);
  }
}

async function verifyInvoiceDetailAcrossMutation({ page, row, heading, id, from, to, mutate }: {
  page: Page; row: Locator; heading: Locator; id: string; from: string; to: string; mutate: () => Promise<any>;
}) {
  await test.step(`late ${from} invoice detail cannot undo confirmed ${to}`, async () => {
    const link = row.getByRole('link');
    await link.click(); await expect(heading).toHaveCount(0);
    await holdDetail({ page, id, status: from, run: async (held, release) => {
      await link.click(); await expect.poll(held).toBe(1);
      await mutate(); await expect(row.locator(`.badge.${to}`)).toBeVisible();
      await expect(heading).toHaveCount(0); // detail is still in flight
      await release();
      await expect(heading.locator(`.badge.${to}`)).toBeVisible();
      await expect(heading.locator(`.badge.${from}`)).toHaveCount(0);
    } });
  });
}

async function verifyInvoiceDetailCloseAndRetry({ page, row, heading, id, error }: {
  page: Page; row: Locator; heading: Locator; id: string; error: string;
}) {
  const link = row.getByRole('link');
  await test.step('closing a pending invoice detail prevents its late response reopening the card', async () => {
    await link.click(); await expect(heading).toHaveCount(0);
    await holdDetail({ page, id, status: 'PAID', run: async (held, release) => {
      await link.click(); await expect.poll(held).toBe(1);
      await link.click(); // cancel the pending open, without starting a second GET
      await release();
      expect(held()).toBe(1);
      await expect(heading).toHaveCount(0);
    } });
  });
  await test.step('failed invoice detail shows the selected language and permits a real retry', async () => {
    const path = `/invoices/${id}`, pattern = `**${path}`;
    const fail = (route: Route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    await page.route(pattern, fail);
    try {
      const alert = page.waitForEvent('dialog').then(async d => {
        try { expect(d.type()).toBe('alert'); expect(d.message()).toBe(error); } finally { await d.accept(); }
      });
      const failed = page.waitForResponse(r => new URL(r.url()).pathname === path && r.request().method() === 'GET');
      await Promise.all([link.click(), alert]); expect((await failed).status()).toBe(503);
      await expect(heading).toHaveCount(0);
    } finally { await page.unroute(pattern, fail); }
    await link.click(); await expect(heading.locator('.badge.PAID')).toBeVisible();
  });
}


type Call = (path: string, body: any, token?: string, method?: string, status?: number) => Promise<any>;
const controlName = (label: string) => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`);

// Separate real API fixture so every existing native RFP positive/negative chain
// remains unchanged. The partial-order setup already approved this supplier and
// configured DIRECT purchasing; no extra login or SPA session injection.
export async function verifyInvoiceDetailConcurrency({ page, supplierPage, call, buyerToken, approverToken, supplierToken, supplierOrgId, tag }: {
  page: Page; supplierPage: Page; call: Call; buyerToken: string; approverToken: string;
  supplierToken: string; supplierOrgId: string; tag: string;
}) {
  await test.step('invoice detail read races and load retry on a separate real fixture', async () => {
    const req = await call('/requests', {title:`Invoice detail race ${tag}`,items:[{name:'Race item',qty:1,estUnitPriceMinor:1200}]}, buyerToken);
    await call(`/requests/${req.id}/submit`,{},buyerToken);
    await call(`/requests/${req.id}/approve`,{},approverToken);
    const po=await call(`/orders/direct/from-request/${req.id}`,{supplierOrgId},buyerToken);
    await call(`/orders/${po.id}/status`,{status:'ISSUED'},buyerToken);
    for (const status of ['CONFIRMED','PACKED','SHIPPED','DELIVERED']) await call(`/orders/${po.id}/status`,{status},supplierToken);
    await call(`/orders/${po.id}/receipts`,{items:[{poItemId:po.items[0].id,qty:1}]},buyerToken);
    const invoice=await call(`/invoices/from-po/${po.id}`,{items:[{poItemId:po.items[0].id,qty:1,unitPriceMinor:1200}]},supplierToken);
    expect(invoice.status).toBe('MATCHED');
    expect([invoice.net_minor,invoice.vat_minor,invoice.gross_minor].map(Number)).toEqual([1200,216,1416]);
    await page.goto('/buyer/invoices');
    const row=page.locator('tr').filter({has:page.getByRole('link',{name:invoice.invoice_no,exact:true})})
      .filter({has:page.getByRole('cell',{name:po.po_no,exact:true})});
    await row.getByRole('link').click();
    const heading=page.getByRole('heading',{level:3}).filter({hasText:invoice.invoice_no});
    await expect(heading.locator('.badge.MATCHED')).toBeVisible();
    const mutate=async(action:string,label:string)=>{
      const pending=page.waitForResponse(r=>r.url().endsWith(`/invoices/${invoice.id}/${action}`)&&r.request().method()==='POST');
      const [response]=await Promise.all([pending,row.getByRole('button',{name:controlName(label)}).click()]);
      expect(response.status(),await response.text()).toBe(201);
    };
    await page.locator('.lang').getByRole('button',{name:'AZ',exact:true}).click();
    await verifyInvoiceDetailAcrossMutation({page,row,heading,id:invoice.id,from:'MATCHED',to:'APPROVED',mutate:()=>mutate('approve','Təsdiqlə')});
    await page.locator('.lang').getByRole('button',{name:'RU',exact:true}).click();
    await verifyInvoiceDetailAcrossMutation({page,row,heading,id:invoice.id,from:'APPROVED',to:'PAID',mutate:()=>mutate('pay','💳 Оплатить')});
    for (const [lang,error] of [
      ['AZ','Qaimənin təfərrüatlarını yükləmək mümkün olmadı. Yenidən yoxlayın.'],
      ['RU','Не удалось загрузить сведения счёта. Повторите попытку.'],
      ['EN','Could not load invoice details. Please try again.'],
    ]) {
      await page.locator('.lang').getByRole('button',{name:lang,exact:true}).click();
      await verifyInvoiceDetailCloseAndRetry({page,row,heading,id:invoice.id,error});
    }
    const settled=await call(`/invoices/${invoice.id}`,undefined,buyerToken,'get',200);
    expect(settled.status).toBe('PAID');
    expect([settled.net_minor,settled.vat_minor,settled.gross_minor].map(Number)).toEqual([1200,216,1416]);
    expect(settled.match.ok).toBe(true);
    await supplierPage.goto('/supplier/invoices');
    const supplied=supplierPage.locator('tr').filter({has:supplierPage.getByRole('link',{name:invoice.invoice_no,exact:true})})
      .filter({has:supplierPage.getByRole('cell',{name:po.po_no,exact:true})});
    await expect(supplied.locator('.badge.PAID')).toBeVisible();
  });
}
