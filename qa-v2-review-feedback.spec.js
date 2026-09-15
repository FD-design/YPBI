import {test,expect} from '@playwright/test';
const base=process.env.YPBI_BASE_URL??'http://127.0.0.1:5173';
const board=id=>`${base}/dashboards/public?design=dashboard-center&board=${id}`;
test.use({channel:'chrome',viewport:{width:1440,height:1000}});
test.afterEach(async({page},info)=>{if(info.status!==info.expectedStatus)await page.screenshot({path:`/private/tmp/ypbi-feedback-failure-${info.line}.png`});});

test('支付日报、真实方式及未接入状态一致',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(board('5.11'));
  const panel=page.getByRole('article',{name:'拉单与充值转化',exact:true});
  await expect(panel).toBeVisible();
  for(const label of ['拉单人数','拉单次数','充值成功次数','充值成功率','充值人数','活跃用户付费率','充值金额','ARPU','ARPPU'])await expect(panel).toContainText(label);
  await expect(panel).not.toContainText('演示支付方式');
  await panel.getByRole('radiogroup',{name:'支付范围',exact:true}).getByRole('radio',{name:'微信',exact:true}).click();
  await panel.getByRole('button',{name:'充值成功率',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('同日充值成功次数');
  await expect(page.getByRole('dialog')).toContainText('同日拉单次数');
  await page.mouse.click(5,5);await expect(page.getByRole('dialog')).toHaveCount(0);
  for(const width of [1440,1024,390]){await page.setViewportSize({width,height:1000});await panel.scrollIntoViewIfNeeded();await page.screenshot({path:`/private/tmp/ypbi-feedback-payment-${width}.png`});expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);}
  expect(errors).toEqual([]);
});

test('总体、分组、占比和ARPPU计算表保持分离',async({page})=>{
  await page.goto(board('5.10')+'&view='+encodeURIComponent(JSON.stringify({range:{start:'2026-09-02',end:'2026-09-08'},compared:true,mixed:false})));
  const panel=page.getByRole('article',{name:'新老用户付费表现',exact:true});
  expect(await panel.locator('.dashboard-panel__title').evaluate(el=>parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThan(await panel.locator('.composition-chart h3').evaluate(el=>parseFloat(getComputedStyle(el).fontSize)));
  await expect(panel.getByRole('table',{name:'新老付费摘要'}).locator('tbody tr')).toHaveCount(3);
  await panel.getByRole('radiogroup',{name:'新老用户付费展示范围'}).getByRole('radio',{name:'总体',exact:true}).click();
  await expect(panel.getByRole('group',{name:'新老用户付费分组',exact:true})).toHaveCount(0);
  await panel.getByRole('radiogroup',{name:'新老用户付费展示范围'}).getByRole('radio',{name:'分组对比',exact:true}).click();
  await panel.getByRole('button',{name:'老用户',exact:true}).click();
  await expect(panel.getByRole('table',{name:'新老付费摘要'}).locator('tbody tr')).toHaveCount(2);
  await panel.getByRole('radio',{name:'ARPPU',exact:true}).click();
  await panel.getByRole('button',{name:'查看同口径数据表',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await expect(dialog.getByRole('columnheader',{name:'新用户充值金额（分子）',exact:true})).toBeVisible();
  await expect(dialog).toContainText('新用户充值金额');await expect(dialog).toContainText('新用户付费用户数');
  await expect(dialog.getByRole('columnheader',{name:'公式',exact:true})).toBeVisible();
  await expect(dialog.getByRole('columnheader',{name:'对比新用户付费用户数（分母）',exact:true})).toBeVisible();
  await expect(dialog.getByRole('columnheader')).toHaveCount(11);
  await expect(dialog.locator('tbody tr').first().locator('td').nth(7)).toContainText('USD');
  await expect(dialog.locator('tbody tr').first().locator('td').nth(8)).toContainText('人');
  await dialog.getByRole('button',{name:'查看全部分组',exact:true}).click();
  await expect(dialog.getByRole('columnheader',{name:'分子指标',exact:true})).toBeVisible();
  await expect(dialog.getByRole('columnheader',{name:'对比分母指标',exact:true})).toBeVisible();
  await expect(dialog.getByRole('columnheader')).toHaveCount(15);
  await expect(dialog.locator('tbody')).toContainText('老用户充值金额');
  await expect(dialog.locator('tbody')).toContainText('老用户付费用户数');
  await page.mouse.click(5,5);await expect(dialog).toHaveCount(0);
  await panel.evaluate(el=>el.scrollIntoView({block:'start'}));
  await page.waitForTimeout(500); // Capture the completed chart transition, not its first frame.
  await page.screenshot({path:'/private/tmp/ypbi-feedback-new-old.png'});
});

test('留存全部日期热力图、折线和表格共享结果',async({page})=>{
  await page.goto(board('5.8'));
  const panel=page.getByRole('article',{name:'注册留存明细',exact:true});
  await expect(panel.getByRole('region',{name:'注册留存明细全部日期热力图'})).toBeVisible();
  await page.getByRole('button',{name:'更多筛选',exact:true}).click();
  await page.getByRole('radio',{name:'近30日',exact:true}).click();
  await page.getByRole('button',{name:'完成',exact:true}).click();
  await page.locator('.topic-preview__query').getByRole('button',{name:'应用',exact:true}).click();
  await expect(panel).toContainText('共 30 个日期批次');
  await panel.screenshot({path:'/private/tmp/ypbi-feedback-retention-30.png'});
  await panel.getByRole('radio',{name:'趋势',exact:true}).click();
  await expect(panel.getByRole('img',{name:'注册留存明细各周期趋势'})).toBeVisible();
  await panel.getByRole('radio',{name:'表格',exact:true}).click();
  await expect(panel.getByRole('table',{name:'注册留存明细',exact:true}).locator('tbody tr')).toHaveCount(30);
  await panel.getByRole('button',{name:'查看同口径数据表',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('观察窗口结束');
  await expect(page.getByRole('dialog').getByRole('columnheader',{name:'留存人数',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');
  await panel.getByRole('button',{name:'放大查看',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('共 30 个日期批次');
  await page.mouse.click(5,5);await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('播放质量有效观影率、公式名称和说明清单',async({page})=>{
  await page.goto(board('5.12'));
  const shared=await page.evaluate(async()=>{const {topicCard}=await import('/src/v2/design/topic-preview-fixtures.ts');const {extendedMetricModel}=await import('/src/v2/design/extended-board-model.ts');const range={start:'2026-09-02',end:'2026-09-08'};const source=topicCard('M036',range,false).result,shown=extendedMetricModel('M036',range,false).result,starts=extendedMetricModel('M097',range,false).result;return {source:source.value.raw,shown:shown.value.raw,denominator:shown.calculation.denominator.value,starts:starts.value.raw};});
  expect(shared.shown).toBe(shared.source);expect(shared.denominator).toBe(shared.starts);
  await expect(page.locator('.dashboard-metric-card').filter({hasText:'有效观影率'})).toBeVisible();
  const card=page.locator('.dashboard-metric-card').filter({has:page.getByRole('link',{name:'播放发起率',exact:true})});
  await card.getByRole('button',{name:/计算依据/}).click();
  await expect(page.getByRole('dialog')).toContainText('由点击直接触发的播放尝试次数');
  await page.keyboard.press('Escape');
  await card.getByRole('button',{name:'查看同口径数据表',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('可进入播放的视频内容点击次数');
  await page.mouse.click(5,5);
  await page.getByRole('button',{name:'查看看板说明',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('解决什么问题');
  await expect(page.getByRole('dialog')).toContainText('有效观影率');
  await page.mouse.click(5,5);await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.screenshot({path:'/private/tmp/ypbi-feedback-playback.png'});
});

test('全看板纯数值与趋势模式窄屏不溢出',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  for(const id of ['5.2','5.7','5.8','5.9','5.10','5.11','5.12','5.13','5.14','5.15','5.5']){
    await page.goto(board(id));await expect(page.locator('.dashboard-header h1')).toBeVisible();
    const control=page.getByRole('radiogroup',{name:'指标卡展示',exact:true});
    if(await control.count())await control.getByRole('radio',{name:'纯数值',exact:true}).click();
    for(const width of [1280,1024,390]){await page.setViewportSize({width,height:950});expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);}
    if(['5.8','5.13'].includes(id))await page.screenshot({path:`/private/tmp/ypbi-feedback-pure-${id}.png`});
  }
  expect(errors).toEqual([]);
});
