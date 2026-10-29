import {expect,test,type Page} from '@playwright/test';
type Call=(path:string,body:any,token?:string,method?:string,status?:number)=>Promise<any>;

// Reuse actual authenticated contexts; API setup prepares partial receipts, while
// invoice creation and exhausted-balance UX are exercised by real browser clicks.
export async function verifyPartialInvoices({supplierPage,call,buyerToken,approverToken,supplierOrgId,tag}: {
  supplierPage:Page;call:Call;buyerToken:string;approverToken:string;supplierOrgId:string;tag:string;
}) {
  await test.step('partial receipts invoice only the unbilled lines and stop at zero balance',async()=>{
    await call(`/suppliers/${supplierOrgId}/invite`,{},buyerToken);
    const registry=await call('/suppliers',undefined,buyerToken,'get',200);
    const relation=registry.find((r:any)=>r.supplier_org_id===supplierOrgId);
    expect(relation).toBeTruthy();
    await call(`/suppliers/relationships/${relation.id}/status`,{status:'APPROVED'},buyerToken);
    await call('/requests/method-policies',{policies:[{category:'*',minAmountMinor:0,maxAmountMinor:null,method:'DIRECT'}]},buyerToken,'put',200);
    const req=await call('/requests',{title:`Partial invoice browser ${tag}`,items:[
      {name:'Partial bolt',qty:10,estUnitPriceMinor:100,vatRateBp:0},
      {name:'Full washer',qty:5,estUnitPriceMinor:200,vatRateBp:0},
    ]},buyerToken);
    await call(`/requests/${req.id}/submit`,{},buyerToken);await call(`/requests/${req.id}/approve`,{},approverToken);
    const po=await call(`/orders/direct/from-request/${req.id}`,{supplierOrgId},buyerToken);
    const [bolt,washer]=po.items;
    await call(`/orders/${po.id}/status`,{status:'ISSUED'},buyerToken);
    await supplierPage.goto('/supplier/orders');
    const order=supplierPage.locator('tr').filter({hasText:po.po_no});
    for(const label of ['Confirm','Packed','Ship','Delivered']) {
      const response=supplierPage.waitForResponse(r=>r.url().endsWith(`/orders/${po.id}/status`)&&r.request().method()==='POST');
      await order.getByRole('button',{name:`→ ${label}`,exact:true}).click();expect((await response).status()).toBe(201);
    }
    await call(`/orders/${po.id}/receipts`,{items:[{poItemId:bolt.id,qty:4},{poItemId:washer.id,qty:5}]},buyerToken);
    const submitted:any[]=[];
    const capture=(r:any)=>{if(r.method()==='POST'&&r.url().endsWith(`/invoices/from-po/${po.id}`))submitted.push(r.postDataJSON());};
    supplierPage.on('request',capture);
    try {
      const invoice=async()=>{
        const pending=supplierPage.waitForResponse(r=>r.url().endsWith(`/invoices/from-po/${po.id}`)&&r.request().method()==='POST');
        await order.getByRole('button',{name:'🧾 Invoice',exact:true}).click();
        const response=await pending;expect(response.status(),await response.text()).toBe(201);
        await supplierPage.waitForURL('**/supplier/invoices');return response.json();
      };
      const first=await invoice();expect(first.status).toBe('MATCHED');expect(Number(first.gross_minor)).toBe(1400);
      expect(first.items).toHaveLength(2);
      expect(first.items.map((i:any)=>[i.po_item_id,Number(i.qty)])).toEqual(expect.arrayContaining([[bolt.id,4],[washer.id,5]]));
      await call(`/orders/${po.id}/receipts`,{items:[{poItemId:bolt.id,qty:6}]},buyerToken);
      await supplierPage.goto('/supplier/orders');
      const second=await invoice();expect(second.status).toBe('MATCHED');expect(Number(second.gross_minor)).toBe(600);
      expect(second.items.map((i:any)=>[i.po_item_id,Number(i.qty)])).toEqual([[bolt.id,6]]);
      expect(submitted.map(v=>v.items.map((i:any)=>[i.poItemId,i.qty]))).toEqual([[[bolt.id,4],[washer.id,5]],[[bolt.id,6]]]);
      await supplierPage.goto('/supplier/orders');
      for(const [lang,label,message] of [
        ['AZ','Qaimə','Qaimə üçün qəbul edilmiş qalıq yoxdur.'],
        ['RU','Счёт','Нет принятого остатка для выставления счёта.'],
        ['EN','Invoice','No received quantity remains to invoice.'],
      ]) {
        await supplierPage.locator('.lang').getByRole('button',{name:lang,exact:true}).click();
        const shown=supplierPage.waitForEvent('dialog').then(async d=>{expect(d.type()).toBe('alert');expect(d.message()).toBe(message);await d.accept();});
        await order.getByRole('button',{name:`🧾 ${label}`,exact:true}).click();await shown;
        await expect(supplierPage).toHaveURL(/\/supplier\/orders$/);
      }
      expect(submitted).toHaveLength(2);
      const summary=(await call(`/orders/${po.id}/receipts`,undefined,buyerToken,'get',200)).summary;
      expect(summary.map((r:any)=>Number(r.billable))).toEqual([0,0]);
    } finally {supplierPage.off('request',capture);}
  });
}
