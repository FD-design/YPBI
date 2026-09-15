import { test, expect } from '@playwright/test';
const base=process.env.YPBI_BASE_URL??'http://127.0.0.1:5173';
const board=id=>`${base}/dashboards/public?design=dashboard-center&board=${id}`;
test.use({channel:'chrome',viewport:{width:1280,height:1000}});
test.afterEach(async({page},info)=>{if(info.status!==info.expectedStatus)await page.screenshot({path:`/private/tmp/ypbi-quality-failure-${info.line}.png`,fullPage:true});});

async function alignedRows(grid){
  const boxes=await grid.locator(':scope > .dashboard-metric-card').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {top:r.top,bottom:r.bottom};}));
  for(const a of boxes)for(const b of boxes)if(Math.abs(a.top-b.top)<2)expect(Math.abs(a.bottom-b.bottom)).toBeLessThan(2);
}
test('活跃卡片在纯值、趋势、未成熟及窄屏中同排对齐',async({page})=>{
  await page.goto(board('5.8'));
  const grid=page.locator('.topic-preview__grid').first();
  await expect(grid.locator('.dashboard-metric-card').first()).toBeVisible();
  for(const width of [1440,1280,1024,390]){
    await page.setViewportSize({width,height:1000});
    for(const label of ['纯数值','数值＋趋势']){
      await page.getByRole('radio',{name:label,exact:true}).click();
      await alignedRows(grid);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await grid.screenshot({path:`/private/tmp/ypbi-quality-cards-${width}-${label==='纯数值'?'value':'trend'}.png`});
    }
  }
});
test('计算依据紧凑入口保留实名输入、公式和逐日完整表',async({page})=>{
  await page.goto(board('5.12'));
  const card=page.locator('.dashboard-metric-card').filter({has:page.getByRole('link',{name:'播放发起率',exact:true})});
  const trigger=card.getByRole('button',{name:/计算依据/});
  await expect(trigger).toBeVisible();
  expect((await trigger.boundingBox()).height).toBeLessThanOrEqual(30);
  await trigger.click();
  await expect(page.getByRole('dialog')).toContainText('由点击直接触发的播放尝试次数');
  await expect(page.getByRole('dialog')).toContainText('可进入播放的视频内容点击次数');
  await page.keyboard.press('Escape');
  await card.getByRole('button',{name:'查看同口径数据表',exact:true}).click();
  await expect(page.getByRole('dialog').getByRole('columnheader',{name:'由点击直接触发的播放尝试次数（分子）',exact:true})).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('可进入播放的视频内容点击次数');
});
test('直达我的概览使用工作台，搜索框和链接完整应用共享样式',async({page})=>{
  await page.goto(`${base}/dashboards/mine?design=personal-workspace`);
  const search=page.getByRole('searchbox',{name:'搜索我的看板'});
  await expect(search).toBeVisible();
  for(const width of [1280,1024,390]){
    await page.setViewportSize({width,height:900});
    if(width<768)await page.getByRole('button',{name:'选择看板',exact:true}).click();
    expect(await search.evaluate(el=>getComputedStyle(el).borderStyle)).toBe('none');
    expect(await search.evaluate(el=>getComputedStyle(el.parentElement).display)).toBe('flex');
    expect(await search.evaluate(el=>parseFloat(getComputedStyle(el.parentElement).borderRadius))).toBeGreaterThan(0);
    await page.screenshot({path:`/private/tmp/ypbi-quality-personal-${width}.png`});
  }
  await page.setViewportSize({width:1280,height:900});
  await page.reload();await expect(search).toBeVisible();
  expect(await search.evaluate(el=>getComputedStyle(el.parentElement).display)).toBe('flex');
});
test('留存工具分组、趋势图例和色阶按当前视图呈现',async({page})=>{
  await page.goto(board('5.8'));
  const panel=page.getByRole('article',{name:'注册留存明细',exact:true});
  await panel.getByRole('radio',{name:'趋势',exact:true}).click();
  await expect(panel.locator('.retention-matrix__legend')).toHaveCount(0);
  await expect(panel.locator('.retention-matrix__choices')).toBeVisible();
  await expect(panel.locator('.retention-matrix__actions').getByRole('button',{name:'放大查看',exact:true})).toBeVisible();
  await panel.getByRole('radio',{name:'留存人数',exact:true}).click();
  await panel.getByRole('button',{name:'放大查看',exact:true}).click();
  await expect(page.getByRole('dialog').getByRole('radio',{name:'趋势',exact:true})).toHaveAttribute('aria-checked','true');
  await expect(page.getByRole('dialog').getByRole('radio',{name:'留存人数',exact:true})).toHaveAttribute('aria-checked','true');
  await page.keyboard.press('Escape');
  await panel.screenshot({path:'/private/tmp/ypbi-quality-retention-trend.png'});
});
test('支付演示同源、真实方式、完整表与辅助指标有样式',async({page})=>{
  await page.goto(board('5.11'));
  const panel=page.getByRole('article',{name:'拉单与充值转化',exact:true});
  await expect(panel.locator('.data-origin-badge')).toHaveText(['演示数据','演示数据','演示数据','演示数据']);
  const amount=panel.locator('.payment-business__summary section').filter({has:page.getByRole('button',{name:'充值金额',exact:true})});
  const overall=await amount.locator('strong').innerText();
  await panel.getByRole('radio',{name:'微信',exact:true}).click();
  await expect(amount.locator('strong')).not.toHaveText(overall);
  await panel.getByRole('button',{name:'查看同口径数据表',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('支付宝');
  await expect(page.getByRole('dialog')).toContainText('微信');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('link',{name:/进入有序漏斗/})).toHaveCount(0);
  await page.getByText('提交、下单、回调与到账指标',{exact:true}).click();
  await expect(page.locator('.payment-business__advanced .dashboard-metric-card').first()).toBeVisible();
  const nativeButtons=await page.locator('button:visible').evaluateAll(nodes=>nodes.filter(node=>getComputedStyle(node).borderStyle==='outset').map(node=>node.textContent));
  expect(nativeButtons).toEqual([]);
  for(const width of [1280,1024,390]){await page.setViewportSize({width,height:1000});await panel.scrollIntoViewIfNeeded();await page.screenshot({path:`/private/tmp/ypbi-quality-payment-${width}.png`});expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);}
});
test('指标速览可直接体验平台、大盘、日期及双序列详情',async({page})=>{
  await page.goto(`${base}/dashboards/metric-overviews?design=personal-workspace`);
  await page.getByRole('button',{name:'体验核心指标速览',exact:true}).click();
  const table=page.getByRole('table',{name:'指标速览结果'});
  await expect(table.locator('tbody tr')).toHaveCount(6);
  await expect(table).not.toContainText('待接入');
  const row=table.locator('tbody tr').first();
  await row.locator('td').nth(2).getByRole('button').click();
  const dialog=page.getByRole('dialog');
  await expect(dialog).toContainText('所选平台与大盘分别展示');
  await dialog.getByRole('button',{name:'查看指标定义',exact:true}).click();
  await expect(dialog.getByRole('region',{name:'指标定义'})).toContainText('定义版本');
  await dialog.getByRole('button',{name:'进入指标分析',exact:true}).click();
  await expect(page).toHaveURL(/analysis\/metrics\?design=personal-workspace/);
  await expect(page.getByText('当前样例未提供该业务平台的独立结果',{exact:false})).toHaveCount(0);
  await expect(page.locator('.personal-result')).toBeVisible();
  page.once("dialog",dialog=>dialog.accept());
  await page.goBack();
  await expect(table).toBeVisible();
  await page.getByRole('button',{name:'编辑速览',exact:true}).click();
  await table.locator('tbody tr').first().locator('td').first().getByRole('button').click();
  page.once('dialog',dialog=>dialog.dismiss());
  await page.getByRole('dialog').getByRole('button',{name:'进入指标分析',exact:true}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page).toHaveURL(/metric-overviews/);
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'取消编辑',exact:true}).click();
  await page.screenshot({path:'/private/tmp/ypbi-quality-quick-overview.png'});
});

test('全部看板冷启动控件有完整样式，诊断工具实际边界可读',async({page})=>{
  test.setTimeout(90000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  for(const id of ['5.2','5.7','5.8','5.9','5.10','5.11','5.12','5.13','5.14','5.15','5.5']){
    await page.goto(board(id));
    await expect(page.locator('.dashboard-header h1')).toBeVisible();
    const native=await page.locator('button:visible,input:not([type=range]):visible').evaluateAll(nodes=>nodes.filter(node=>['outset','inset'].includes(getComputedStyle(node).borderStyle)).map(node=>node.getAttribute('aria-label')||node.textContent));
    expect(native).toEqual([]);
    await expect(page.getByRole('link',{name:'连接真实数据',exact:true})).toHaveAttribute('href','/admin/data-sources');
    if(['5.12','5.14','5.15'].includes(id)){
      const panel=page.getByRole('article',{name:id==='5.12'?'播放质量诊断':id==='5.15'?'启动结构与质量诊断':'签到拆解',exact:true});
      for(const width of [1280,1024,390]){
        await page.setViewportSize({width,height:950});await panel.scrollIntoViewIfNeeded();
        const outside=await panel.locator('button:visible').evaluateAll(nodes=>nodes.filter(node=>{const r=node.getBoundingClientRect();return r.left<0||r.right>window.innerWidth+1;}).map(node=>node.textContent));
        expect(outside).toEqual([]);
        await expect(panel).not.toContainText('请选择');
        await panel.screenshot({path:`/private/tmp/ypbi-quality-controls-${id}-${width}.png`});
      }
      await page.setViewportSize({width:1280,height:1000});
    }
  }
  expect(errors).toEqual([]);
});
