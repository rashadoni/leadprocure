import {test,expect} from '@playwright/test';
import {createRequire} from 'node:module';
const apiRequire=createRequire(new URL('../../api/package.json',import.meta.url));

// Real API fixtures in the disposable CI database; the browser signs in normally.
test('custom locked criteria and re-evaluation show only the current scores',async({page,request})=>{
  apiRequire('../../scripts/acceptance/assert-isolated.cjs')();
  const base='http://localhost:3000';const tag=Date.now().toString(36);const password='Audit-only-password123';
  const post=async(path:string,body:any,token?:string)=>{
    const r=await request.post(base+path,{data:body,headers:token?{Authorization:`Bearer ${token}`}:{}});expect(r.status(),await r.text()).toBe(201);return r.json();
  };
  const register=(kind:string,name:string)=>post(`/auth/register/${kind}`,{legalName:`Browser audit ${name}`,email:`${name}-${tag}@audit.invalid`,password,fullName:name});
  const buyer=await register('buyer','buyer'),s1=await register('supplier','s1'),s2=await register('supplier','s2');
  await post('/settings/users',{email:`approver-${tag}@audit.invalid`,fullName:'Approver',password,role:'BUYER_APPROVER'},buyer.accessToken);
  const approver=await post('/auth/login',{email:`approver-${tag}@audit.invalid`,password});
  const req=await post('/requests',{title:'Browser custom criteria',items:[{name:'Item',qty:1,estUnitPriceMinor:10000}]},buyer.accessToken);
  await post(`/requests/${req.id}/submit`,{},buyer.accessToken);await post(`/requests/${req.id}/approve`,{},approver.accessToken);
  const event=await post(`/events/from-request/${req.id}`,{closeAt:new Date(Date.now()+3600000).toISOString(),visibility:'PUBLIC',criteria:[{key:'quality',weight:60},{key:'delivery',weight:40}]},buyer.accessToken);
  await post(`/events/${event.id}/publish`,{},buyer.accessToken);
  for(const [supplier,price] of [[s1,9000],[s2,9500]] as const)await post(`/events/${event.id}/bid`,{items:[{eventItemId:event.items[0].id,unitPriceMinor:price}]},supplier.accessToken);
  const {Client}=apiRequire('pg');const db=new Client({connectionString:process.env.DATABASE_OWNER_URL});await db.connect();
  try{await db.query(`UPDATE sourcing_events SET close_at=now()-interval '1 second' WHERE id=$1`,[event.id]);await db.query(`SELECT * FROM close_due_events()`);}finally{await db.end();}
  await post(`/events/${event.id}/open`,{},buyer.accessToken);
  await page.addInitScript(()=>localStorage.setItem('lp_lang','en'));
  await page.goto('/login');await page.fill('input[type=email]',`buyer-${tag}@audit.invalid`);await page.fill('input[type=password]',password);
  await page.click('form button.btn:not(.ghost):not([type=button])');await page.waitForURL(/\/buyer\//);await page.goto(`/buyer/events/${event.id}`);
  const quality=page.locator('label').filter({hasText:'quality · 60%'}).locator('input');
  const delivery=page.locator('label').filter({hasText:'delivery · 40%'}).locator('input');
  await expect(quality).toHaveCount(2);await quality.nth(0).fill('100');await quality.nth(1).fill('80');await delivery.nth(0).fill('80');await delivery.nth(1).fill('50');
  await page.getByRole('button',{name:'Score',exact:true}).click();await expect(page.getByText('92.0',{exact:true})).toBeVisible();
  await quality.nth(0).fill('50');await page.getByRole('button',{name:'Score',exact:true}).click();
  await expect(page.getByText('62.0',{exact:true})).toBeVisible();await expect(page.getByText('154.0',{exact:true})).toHaveCount(0);
});
