import {expect,test,type Page,type Route} from '@playwright/test';
type Call=(path:string,body:any,token?:string,method?:string)=>Promise<any>;

// Reuse the finance scenario's real authenticated browser. Responses come from
// the real API; the route barrier only controls order, and failures are explicit503.
export async function verifyBudgetReport({page,call,buyerToken,tag}:{page:Page;call:Call;buyerToken:string;tag:string}) {
  const years=['2031','2032'];
  const names=years.map(y=>`Filter plan ${y} ${tag}`);
  for(let i=0;i<years.length;i++) {
    const budget=await call('/budgets',{name:names[i],category:`FILTER_${years[i]}`,periodYear:Number(years[i]),amountMinor:(i+1)*10001},buyerToken);
    await call(`/budgets/${budget.id}/submit`,{},buyerToken);
    await page.reload();
    const row=page.locator('tr').filter({hasText:names[i]});
    const approved=page.waitForResponse(r=>r.url().endsWith(`/budgets/${budget.id}/approve`)&&r.request().method()==='POST');
    await row.getByRole('button',{name:/^Approve\b/}).click();expect((await approved).status()).toBe(201);
    await expect(row.locator('.badge.APPROVED')).toBeVisible();
  }
  const year=page.getByPlaceholder('Year',{exact:true});
  const rollup=page.getByTestId('budget-rollup');
  await test.step('late old plan/rollup responses cannot replace a newer year',async()=>{
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    let held=0,finished=0;let resolveFinished!:()=>void;
    const drained=new Promise<void>(resolve=>{resolveFinished=resolve;});
    const isReport=(url:URL)=>['/budgets','/budgets/rollup'].includes(url.pathname);
    const onFinished=(request:any)=>{const u=new URL(request.url());if(isReport(u)&&u.searchParams.get('year')===years[0]&&++finished===2)resolveFinished();};
    const barrier=async(route:Route)=>{
      const response=await route.fetch();
      if(new URL(route.request().url()).searchParams.get('year')===years[0]) {held++;await gate;}
      await route.fulfill({response});
    };
    page.on('requestfinished',onFinished);await page.route(isReport,barrier);
    try {
      await year.fill(years[0]);await expect.poll(()=>held).toBe(2);
      await expect(page.getByRole('button',{name:'⤓ CSV',exact:true})).toBeDisabled();
      await year.fill(years[1]);
      await expect(page.getByText(names[1],{exact:true})).toBeVisible();
      await expect(page.getByText(names[0],{exact:true})).toHaveCount(0);
      await expect(rollup.locator('tbody tr').first().locator('td').nth(1)).toHaveText('200,02 AZN');
      release();await drained;
      await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
      await expect(year).toHaveValue(years[1]);
      await expect(page.getByText(names[1],{exact:true})).toBeVisible();
      await expect(page.getByText(names[0],{exact:true})).toHaveCount(0);
      await expect(rollup.locator('tbody tr').first().locator('td').nth(1)).toHaveText('200,02 AZN');
    } finally {release();await page.unrouteAll({behavior:'wait'});page.off('requestfinished',onFinished);}
  });
  const cases=[
    {path:'/budgets',lang:'EN',error:'Could not load the budget report.',retry:'Retry',year:years[0],name:names[0]},
    {path:'/budgets/rollup',lang:'AZ',error:'Büdcə hesabatını yükləmək mümkün olmadı.',retry:'Yenidən yoxla',year:years[1],name:names[1]},
    {path:'/budgets/unbudgeted',lang:'RU',error:'Не удалось загрузить бюджетный отчёт.',retry:'Повторить',year:years[0],name:names[0]},
  ];
  for(const scenario of cases) await test.step(`${scenario.path} failure is explicit in ${scenario.lang} and retries current year`,async()=>{
    let fail=true;
    await page.locator('.lang').getByRole('button',{name:scenario.lang,exact:true}).click();
    const matches=(url:URL)=>url.pathname===scenario.path;
    await page.route(matches,async route=>{
      if(fail){fail=false;await route.fulfill({status:503,json:{message:'Isolated report failure'}});}else await route.continue();
    });
    try {
      // The filter is the number input with a placeholder; its text follows locale.
      // The plan form's year input has no placeholder.
      const filter=page.locator('input[type=number][placeholder]');
      await filter.fill(scenario.year);
      await expect(page.getByRole('alert')).toContainText(scenario.error);
      await expect(page.getByTestId('budget-list')).toHaveCount(0);
      await expect(rollup).toHaveCount(0);
      await expect(page.getByRole('button',{name:'⤓ CSV',exact:true})).toBeDisabled();
      await page.getByRole('button',{name:scenario.retry,exact:true}).click();
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.getByText(scenario.name,{exact:true})).toBeVisible();
      await expect(page.getByRole('button',{name:'⤓ CSV',exact:true})).toBeEnabled();
    } finally {await page.unrouteAll({behavior:'wait'});}
  });
  await page.locator('.lang').getByRole('button',{name:'EN',exact:true}).click();
}
