import { expect, test, type Browser, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { verifyPartialInvoices } from './partial-invoice';
import { answerDialog } from './dialogs';
import { verifyInvoiceMutationFailure } from './invoice-negative';
import { verifyInvoiceDetailConcurrency } from './invoice-detail-race';
const apiRequire = createRequire(new URL('../../../api/package.json', import.meta.url));

type Call = (path: string, body: any, token?: string, method?: string, status?: number) => Promise<any>;

// Fixed acceptance copy, independent of the application's translation dictionary.
// Selecting localized controls verifies both authenticated sides use the chosen language.
const paymentCopy = {
  az: { open: 'Zərfləri aç', score: 'Qiymətləndir', award: 'Qalib seç', analyze: 'Təhlil et',
    contract: 'Müqavilə yarat', po: 'Sifariş yarat', issue: 'Sifarişi ver', receive: 'Qəbul et',
    supplierSteps: ['Təsdiqlə', 'Qablaşdırıldı', 'Göndər', 'Çatdırıldı'], invoice: 'Qaimə', approve: 'Təsdiqlə', pay: 'Ödə',
    match: 'Üçtərəfli uyğunlaşdırma', price: 'Qaimə qiyməti', reason: 'Yeganə RFP təklifi dərc olunmuş tələblərə cavab verir' },
  ru: { open: 'Вскрыть ставки', score: 'Оценить', award: 'Выбрать победителя', analyze: 'Проанализировать',
    contract: 'Создать контракт', po: 'Создать заказ', issue: 'Выпустить', receive: 'Приёмка',
    supplierSteps: ['Подтвердить', 'Упаковано', 'Отгрузить', 'Доставлено'], invoice: 'Счёт', approve: 'Утвердить', pay: 'Оплатить',
    match: 'Трёхсторонняя сверка', price: 'Цена в счёте', reason: 'Единственное предложение RFP соответствует опубликованным требованиям' },
  en: { open: 'Open bids', score: 'Score', award: 'Award winner', analyze: 'Analyze',
    contract: 'Create contract', po: 'Create order', issue: 'Issue', receive: 'Receive',
    supplierSteps: ['Confirm', 'Packed', 'Ship', 'Delivered'], invoice: 'Invoice', approve: 'Approve', pay: 'Pay',
    match: 'Three-way match', price: 'Invoice price', reason: 'Sole RFP proposal meets the published requirements' },
} as const;
type PaymentLanguage = keyof typeof paymentCopy;

// data-tip adds accessible help text after a control's visible action label.
// Require the complete leading label and a boundary while allowing that help.
const controlName = (label: string) => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`);

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
    const supplier = await registration.json();
    const supplierPage = await context.newPage();
    await supplierPage.goto('/supplier/dashboard');
    await expect(supplierPage.locator('h1')).toBeVisible();
    const cases = [
      { type: 'RFI', lang: 'az', label: 'Cavab (mətn)', submit: 'Göndər', received: 'Təklif qəbul edildi' },
      { type: 'RFP', lang: 'az', label: 'Texniki təklif', submit: 'Təklif ver', received: 'Təklif qəbul edildi' },
      { type: 'RFP', lang: 'ru', label: 'Техническое предложение', submit: 'Подать ставку', received: 'Предложение принято' },
      { type: 'RFP', lang: 'en', label: 'Technical proposal', submit: 'Place bid', received: 'Submission received' },
    ];
    for (const scenario of cases) await test.step(`${scenario.type} supplier/buyer native flow in ${scenario.lang}`, async () => {
      const lang = scenario.lang as PaymentLanguage, copy = paymentCopy[lang];
      const title = `Rfx ${scenario.type} ${scenario.lang} ${tag}`, itemName = `Rfx item ${scenario.lang}`;
      const req = await call('/requests', { title, items: [{ name: itemName, qty: 1, estUnitPriceMinor: 10000 }] }, buyerToken);
      await call(`/requests/${req.id}/submit`, {}, buyerToken);
      await call(`/requests/${req.id}/approve`, {}, approverToken);
      const event = await call(`/events/from-request/${req.id}`, { type: scenario.type, visibility: 'PUBLIC', closeAt: new Date(Date.now() + 3600000).toISOString() }, buyerToken);
      await call(`/events/${event.id}/publish`, {}, buyerToken);
      for (const page of [supplierPage, buyerPage]) {
        await page.locator('.lang').getByRole('button', { name: lang.toUpperCase(), exact: true }).click();
      }
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
      await buyerPage.getByRole('button', { name: controlName(copy.open) }).click();
      expect((await openedResponse).status()).toBe(201);
      await expect(buyerPage.getByText(`📝 ${text}`, { exact: true })).toBeVisible();
      const opened = await call(`/events/${event.id}`, undefined, buyerToken, 'get', 200);
      expect(opened.bids[0].proposal_text).toBe(text);
      if (scenario.type === 'RFI') {
        expect(opened.bids[0].total_minor).toBeNull();
        await expect(buyerPage.getByRole('button', { name: controlName(copy.score) })).toHaveCount(0);
        await expect(buyerPage.getByRole('button', { name: controlName(copy.award) })).toHaveCount(0);
        await expect(buyerPage.getByRole('button', { name: controlName(copy.analyze) })).toHaveCount(0);
        await call(`/events/${event.id}/award`, { lotId: event.lots[0].id, bidId: opened.bids[0].id }, buyerToken, 'post', 400);
      } else {
        expect(Number(opened.bids[0].total_minor)).toBe(1200);
        await expect(buyerPage.getByRole('button', { name: controlName(copy.score) })).toBeVisible();
      }
      if (scenario.type === 'RFP') {
        await verifyRfpPayment({buyerPage,supplierPage,call,buyerToken,event,opened,lang});
      }
      await supplierPage.reload();
      await expect(supplierPage.getByRole('note', { name: scenario.label, exact: true })).toHaveText(text);
      const otherAfter = await call(`/events/${event.id}`, undefined, foreignSupplierToken, 'get', 200);
      expect(otherAfter.my_bid).toBeNull(); expect(JSON.stringify(otherAfter)).not.toContain(marker);
    });
    await verifyPartialInvoices({supplierPage,buyerPage,call,buyerToken,approverToken,supplierToken:supplier.accessToken,supplierOrgId:supplier.org.id,tag});
    await verifyInvoiceDetailConcurrency({page:buyerPage,supplierPage,call,buyerToken,approverToken,
      supplierToken:supplier.accessToken,supplierOrgId:supplier.org.id,tag});
  } finally { await context.close(); }
}

// Every downstream write is made by an authenticated native browser click.
// API calls below only assert resulting state/price; clock adjustment remains
// confined to the isolated deadline fixture above. PAID is an application status.
async function verifyRfpPayment({buyerPage,supplierPage,call,buyerToken,event,opened,lang}: {
  buyerPage:Page; supplierPage:Page; call:Call; buyerToken:string; event:any; opened:any; lang:PaymentLanguage;
}) {
  const copy = paymentCopy[lang];
  await test.step(`RFP ${lang} native scoring → award → contract → PO → GRN → invoice → PAID`,async()=>{
    const clicked = async (page:Page,path:string,action:()=>Promise<void>) => {
      expect(await page.evaluate(() => localStorage.getItem('lp_lang'))).toBe(lang);
      const pending=page.waitForResponse(r=>r.url().endsWith(path)&&r.request().method()==='POST');
      const [response]=await Promise.all([pending,action()]);
      expect(response.status(),await response.text()).toBe(201); return response.json();
    };
    const bid=buyerPage.locator('tr').filter({hasText:opened.bids[0].supplier_name});
    for(const criterion of event.evaluation_criteria ?? opened.evaluation_criteria) {
      await bid.locator('label').filter({hasText:`${criterion.key} · ${criterion.weight}%`}).locator('input').fill('90');
    }
    await clicked(buyerPage,`/events/${event.id}/evaluate`,()=>buyerPage.getByRole('button',{name:controlName(copy.score)}).click());
    const group=buyerPage.getByRole('group',{name:event.lots[0].title,exact:true});
    // The award's justification is asked inside the page now; the POST follows the confirm.
    await clicked(buyerPage,`/events/${event.id}/award`,async()=>{
      await group.getByRole('button',{name:new RegExp(opened.bids[0].supplier_name)}).click();
      await answerDialog(buyerPage,copy.reason);
    });
    await expect(group.locator('.badge.AWARDED')).toBeVisible();
    const award=(await call(`/events/${event.id}`,undefined,buyerToken,'get',200)).awards.find((a:any)=>!a.cancelled_at);
    const activation=buyerPage.waitForResponse(r=>/\/contracts\/[^/]+\/activate$/.test(r.url())&&r.request().method()==='POST');
    const contract=await clicked(buyerPage,`/contracts/from-award/${award.id}`,
      ()=>buyerPage.getByRole('button',{name:`${copy.contract} · ${event.lots[0].title}`}).click());
    // The click immediately performs a full-page navigation after activation;
    // Chromium can discard its body, but status/URL remain available.
    const activated=await activation;expect(activated.status()).toBe(201);
    expect(activated.url()).toContain(`/contracts/${contract.id}/activate`);
    await buyerPage.waitForURL('**/buyer/contracts');
    expect(Number(contract.total_minor)).toBe(1200);
    const contractRow=buyerPage.locator('tr').filter({hasText:contract.contract_no});
    await expect(contractRow.locator('.badge.ACTIVE')).toBeVisible();
    const po=await clicked(buyerPage,`/contracts/${contract.id}/orders`,()=>contractRow.getByRole('button',{name:controlName(copy.po)}).click());
    expect(Number(po.total_minor)).toBe(1200);
    const order=buyerPage.locator('tr').filter({hasText:po.po_no});
    await clicked(buyerPage,`/orders/${po.id}/status`,()=>order.getByRole('button',{name:controlName(copy.issue)}).click());
    await supplierPage.goto('/supplier/orders');
    const supplied=supplierPage.locator('tr').filter({hasText:po.po_no});
    for(const label of copy.supplierSteps) {
      await clicked(supplierPage,`/orders/${po.id}/status`,()=>supplied.getByRole('button',{name:`→ ${label}`,exact:true}).click());
    }
    await buyerPage.reload();
    await clicked(buyerPage,`/orders/${po.id}/receipts`,()=>order.getByRole('button',{name:controlName(`📥 ${copy.receive}`)}).click());
    await expect(order.locator('.badge.ACCEPTED')).toBeVisible();
    const receipt=await call(`/orders/${po.id}/receipts`,undefined,buyerToken,'get',200);
    expect(receipt.summary).toHaveLength(1);expect(Number(receipt.summary[0].received)).toBe(1);
    await supplierPage.reload();
    const invoice=await clicked(supplierPage,`/invoices/from-po/${po.id}`,()=>supplied.getByRole('button',{name:`🧾 ${copy.invoice}`,exact:true}).click());
    await supplierPage.waitForURL('**/supplier/invoices');
    expect(invoice.status).toBe('MATCHED');
    expect([invoice.net_minor,invoice.vat_minor,invoice.gross_minor].map(Number)).toEqual([1200,216,1416]);
    await expect(supplierPage.locator('tr').filter({has:supplierPage.getByRole('link',{name:invoice.invoice_no,exact:true})}).filter({has:supplierPage.getByRole('cell',{name:po.po_no,exact:true})}).locator('.badge.MATCHED')).toBeVisible();
    await buyerPage.goto('/buyer/invoices');
    const invoiced=buyerPage.locator('tr').filter({has:buyerPage.getByRole('link',{name:invoice.invoice_no,exact:true})}).filter({has:buyerPage.getByRole('cell',{name:po.po_no,exact:true})});
    await invoiced.getByRole('link',{name:invoice.invoice_no,exact:true}).click();
    const detailHeading=buyerPage.getByRole('heading',{level:3}).filter({hasText:invoice.invoice_no});
    await expect(detailHeading.locator('.badge.MATCHED')).toBeVisible();
    await verifyInvoiceMutationFailure({page:buyerPage,row:invoiced,heading:detailHeading,call,buyerToken,id:invoice.id,
      action:'approve',status:'MATCHED',click:()=>invoiced.getByRole('button',{name:controlName(copy.approve)}).click()});
    await clicked(buyerPage,`/invoices/${invoice.id}/approve`,()=>invoiced.getByRole('button',{name:controlName(copy.approve)}).click());
    await expect(invoiced.locator('.badge.APPROVED')).toBeVisible();
    await expect(detailHeading.locator('.badge.APPROVED')).toBeVisible();
    await expect(detailHeading.locator('.badge.MATCHED')).toHaveCount(0);
    await verifyInvoiceMutationFailure({page:buyerPage,row:invoiced,heading:detailHeading,call,buyerToken,id:invoice.id,
      action:'pay',status:'APPROVED',click:()=>invoiced.getByRole('button',{name:controlName(`💳 ${copy.pay}`)}).click()});
    await clicked(buyerPage,`/invoices/${invoice.id}/pay`,()=>invoiced.getByRole('button',{name:controlName(`💳 ${copy.pay}`)}).click());
    await expect(invoiced.locator('.badge.PAID')).toBeVisible();
    await expect(detailHeading.locator('.badge.PAID')).toBeVisible();
    await expect(detailHeading.locator('.badge.APPROVED')).toHaveCount(0);
    // Updating the returned row must preserve loaded comparison lines/items.
    await expect(buyerPage.getByRole('heading',{name:`${copy.match} ✅`,exact:true})).toBeVisible();
    await expect(buyerPage.getByRole('columnheader',{name:copy.price,exact:true})).toBeVisible();
    const settled=await call(`/invoices/${invoice.id}`,undefined,buyerToken,'get',200);
    expect(settled.status).toBe('PAID');
    expect([settled.net_minor,settled.vat_minor,settled.gross_minor].map(Number)).toEqual([1200,216,1416]);
    expect(settled.match.ok).toBe(true);
    await buyerPage.reload();
    await expect(invoiced.locator('.badge.PAID')).toBeVisible();
    await invoiced.getByRole('link',{name:invoice.invoice_no,exact:true}).click();
    for(const [lang,match,price,net,vat] of [
      ['EN','Three-way match','Invoice price','Net amount','VAT'],
      ['RU','Трёхсторонняя сверка','Цена в счёте','Без НДС','НДС'],
      ['AZ','Üçtərəfli uyğunlaşdırma','Qaimə qiyməti','ƏDV-siz məbləğ','ƏDV'],
    ]) {
      await buyerPage.locator('.lang').getByRole('button',{name:lang,exact:true}).click();
      await expect(buyerPage.getByRole('heading',{name:`${match} ✅`,exact:true})).toBeVisible();
      await expect(buyerPage.getByRole('columnheader',{name:price,exact:true})).toBeVisible();
      await expect(buyerPage.locator('.hint').filter({hasText:net}).filter({hasText:vat})).toBeVisible();
    }
    await buyerPage.locator('.lang').getByRole('button',{name:lang.toUpperCase(),exact:true}).click();
    await supplierPage.reload();
    await expect(supplierPage.locator('tr').filter({has:supplierPage.getByRole('link',{name:invoice.invoice_no,exact:true})}).filter({has:supplierPage.getByRole('cell',{name:po.po_no,exact:true})}).locator('.badge.PAID')).toBeVisible();
    for (const name of [copy.approve, `💳 ${copy.pay}`]) {
      await expect(supplierPage.getByRole('button',{name:controlName(name)})).toHaveCount(0);
    }
    // Return to the proposal page so existing own-response/secrecy assertions
    // still run after the entire commercial chain has completed.
    await supplierPage.goto(`/supplier/events/${event.id}`);
  });
}
