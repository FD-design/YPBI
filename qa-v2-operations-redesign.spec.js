import {selectReviewState} from './tools/qa-review-tools.mjs';
import { test, expect } from "@playwright/test";
const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5173";
test.use({ channel:"chrome" });
test.afterEach(async({page},info)=>{if(info.status!==info.expectedStatus)await page.screenshot({path:`/private/tmp/ypbi-redesign-failure-${info.line}.png`});});
const board = id => `${base}/dashboards/public?design=dashboard-center&board=${id}`;

test('组合摘要、日序列和工作簿保持同源',async({page})=>{
  await page.goto(board('5.7'));
  const checks=await page.evaluate(async()=>{
    const model=await import('/src/v2/design/acquisition-preview-model.ts'),output=await import('/src/v2/design/acquisition-export.ts'),pay=await import('/src/v2/design/payment-observations.ts'),order=await import('/src/v2/design/PaymentOrderAnalysis.tsx');
    const range={start:'2026-08-10',end:'2026-09-08'},filters={...model.DEFAULT_ACQUISITION_FILTERS,...range,comparison:'previous'};
    const downloads=model.downloadTargetDaily(range),sources=model.sourceDaily(range),cards=model.acquisitionCards(true,false,[],range),get=id=>cards.find(card=>card.model.metric.id===id).model.result;
    const sum=rows=>rows.reduce((a,row)=>a+Object.values(row.values).reduce((a,b)=>a+b,0),0),payment=pay.paymentAggregate(range),workbook=output.acquisitionWorkbook(filters,false,[]),snapshot=order.paymentOrderSheets(range);
    return {download:sum(downloads),downloadCard:get('M003').value.raw,source:sum(sources),sourceCard:get('M008').value.raw,rate:get('M005').value.raw,numerator:get('M005').calculation.numerator.value,denominator:get('M005').calculation.denominator.value,columns:workbook.every(sheet=>sheet.rows.every(row=>row.length===0||row.length===sheet.rows[0].length)),payment,amount:pay.paymentAggregate(range,{product:'vip'}).amount+pay.paymentAggregate(range,{product:'coin'}).amount,snapshot};
  });
  expect(checks.download).toBe(checks.downloadCard);expect(checks.source).toBe(checks.sourceCard);expect(checks.rate).toBeCloseTo(checks.numerator/checks.denominator,12);expect(checks.columns).toBe(true);expect(checks.payment.amount).toBeCloseTo(checks.amount,8);expect(checks.payment.arppu).toBeCloseTo(checks.payment.amount/checks.payment.users,10);expect(checks.snapshot[0].rows.flat()).toContain("演示数据，非真实业务结果");expect(checks.snapshot[1].rows.flat()).toContain("支付宝");
  expect(checks.snapshot.every(sheet=>sheet.rows.every(row=>row.length===sheet.rows[0].length))).toBe(true);
  const total=checks.snapshot[1].rows[1];expect(total[1]).toBe("总体");expect(typeof total[8]).toBe("number");
  expect(total[8]).toBeCloseTo(checks.payment.amount,10);
  for(const row of checks.snapshot[2].rows.slice(1)){expect(row[10]).toBeCloseTo(row[4]/row[7],12);}
});

test("广告摘要联动、下载环图、来源比较和落地页基数",async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(board('5.2'));
  const ad=page.getByRole('article',{name:'广告点击表现',exact:true});
  await ad.getByRole('radio',{name:'新用户',exact:true}).click();
  await ad.getByRole('button',{name:'活跃用户广告点击渗透率数值与计算依据',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('注册当日新用户活跃数');await page.keyboard.press('Escape');
  await page.goto(board('5.7'));
  const downloads=page.getByRole('article',{name:'下载表现',exact:true});
  await expect(downloads.getByRole('img',{name:'下载目标构成构成环图',exact:true})).toBeVisible();
  await downloads.getByRole('radio',{name:'占比',exact:true}).click();
  await downloads.getByRole('radiogroup',{name:'分目标下载展示范围',exact:true}).getByRole('radio',{name:'总体',exact:true}).click();
  await downloads.getByRole('button',{name:'查看同口径数据表',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('下载点击总次数');await page.keyboard.press('Escape');
  const landing=page.getByRole('article',{name:'落地页转化诊断',exact:true});
  await landing.locator('.acquisition-visuals__relations button').first().click();
  await expect(page.getByRole('dialog')).toContainText('落地页访问次数');await page.keyboard.press('Escape');
  await downloads.getByRole('button',{name:'查看下载明细',exact:true}).click();
  await expect(page.getByRole('region',{name:'获客明细',exact:true})).toContainText('Android');
  for(const width of [1280,1024,390]) {await page.setViewportSize({width,height:950});await downloads.scrollIntoViewIfNeeded();await page.screenshot({path:`/private/tmp/ypbi-download-redesign-${width}.png`});expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);}
  await selectReviewState(page, '组合异常态');
  await expect(downloads.getByRole('img',{name:'下载目标构成构成环图',exact:true})).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("日报支付保留真实方式，缺少数据不绘制订单漏斗",async({page})=>{
  await page.goto(board('5.11'));
  const panel=page.getByRole('article',{name:'拉单与充值转化',exact:true});
  await expect(panel).toContainText('支付宝');await expect(panel).toContainText('微信');
  await expect(panel).toContainText('同日充值成功次数 ÷ 同日拉单次数');
  await expect(panel.getByRole('img',{name:'充值成功率支付方式比较（演示数据）',exact:true})).toBeVisible();
  await expect(panel.locator('[data-chart-kind="funnel-real"]')).toHaveCount(0);
  const evidence=panel.getByRole('table',{name:'支付方式成功率核对',exact:true});
  await expect(evidence.locator('thead th')).toHaveText(['支付方式','充值成功次数','拉单次数','充值成功率','实际日期','状态']);
  await expect(evidence.locator('tbody tr')).toHaveCount(2);
  for(const row of await evidence.locator('tbody tr').all()) {
    const cells=await row.locator('td').allTextContents();
    const number=text=>Number(text.replaceAll(',','').replace(/[^\d.]/g,''));
    expect(number(cells[3])).toBeCloseTo(number(cells[1])/number(cells[2])*100,2);
    expect(cells[4]).toBe('2026-09-02 至 2026-09-08');
  }
  const values=await evidence.innerText();
  await panel.getByRole('radio',{name:'充值金额',exact:true}).click();
  await expect.poll(() => evidence.innerText()).toBe(values);
  for(const width of [1280,1024,390]){await page.setViewportSize({width,height:950});await expect(panel.locator('.data-origin-badge')).toHaveText(['演示数据','演示数据','演示数据','演示数据']);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);await evidence.screenshot({path:`/private/tmp/ypbi-payment-evidence-${width}.png`});}
});

test("整板模式保留数值、固定摘要与完整表，逐板记忆且不改查询", async ({page}) => {
  await page.goto(board("5.2"));
  const group = page.getByRole("radiogroup",{name:"指标卡展示",exact:true});
  await expect(page.locator('.core-review__metric-grid .dashboard-metric-card')).toHaveCount(9);
  const values = await page.locator('.core-review__metric-grid .dashboard-metric-card__value').allTextContents();
  const url = page.url();
  await group.getByRole("radio",{name:"纯数值",exact:true}).click();
  await expect(page.locator('.core-review__metric-grid .is-mode-value')).toHaveCount(9);
  await expect(page.locator('.core-review__metric-grid .dashboard-mini-trend')).toHaveCount(0);
  expect(await page.locator('.core-review__metric-grid .dashboard-metric-card__value').allTextContents()).toEqual(values);
  expect(page.url()).toBe(url);
  await expect(page.locator('.core-review__detail .dashboard-metric-card.is-mode-value')).toHaveCount(0);
  await page.locator('.core-review__metric-grid .dashboard-metric-card').first().getByRole('button',{name:'查看同口径数据表',exact:true}).click();
  await expect(page.getByRole('dialog').locator('tbody tr')).toHaveCount(7); await page.keyboard.press('Escape');
  await page.reload(); await expect(group.getByRole('radio',{name:'纯数值',exact:true})).toHaveAttribute('aria-checked','true');
  await page.goto(board('5.8')); await expect(group.getByRole('radio',{name:'数值＋趋势',exact:true})).toHaveAttribute('aria-checked','true');
  await page.goto(board('5.2')); await expect(group.getByRole('radio',{name:'纯数值',exact:true})).toHaveAttribute('aria-checked','true');
  await group.getByRole('radio',{name:'数值＋趋势',exact:true}).click();
  await expect(page.locator('.core-review__metric-grid .dashboard-mini-trend')).not.toHaveCount(0);
});

test("注册热力图7/30日统一应用，两种色阶、基数与全表可读", async ({page}) => {
  await page.goto(board('5.8'));
  const panel=page.getByRole('article',{name:'注册留存明细',exact:true});
  await panel.getByRole('radio',{name:'表格',exact:true}).click();
  await expect(panel.locator('tbody tr')).toHaveCount(7);
  await page.getByRole('button',{name:'更多筛选',exact:true}).click();
  await page.getByRole('radio',{name:'近30日',exact:true}).click();
  await page.getByRole('button',{name:'完成',exact:true}).click();
  await expect(panel.locator('tbody tr')).toHaveCount(7);
  await page.locator('.topic-preview__query').getByRole('button',{name:'应用',exact:true}).click();
  await panel.getByRole('radio',{name:'表格',exact:true}).click();await expect(panel.locator('tbody tr')).toHaveCount(30);
  await panel.getByRole('radio',{name:'留存人数',exact:true}).click();
  await expect(panel.getByLabel('注册留存明细色阶')).toContainText('留存人数（人）');
  const first=panel.locator('tbody tr').first().locator('td').nth(2).getByRole('button');
  await first.click(); const detail=page.getByRole('dialog'); await expect(detail).toContainText('分子'); await expect(detail).toContainText('分母'); await expect(detail).toContainText('× 100%'); await page.keyboard.press('Escape');
  for(const width of [1280,1024,390]) {
    await page.setViewportSize({width,height:950}); await panel.scrollIntoViewIfNeeded();
    await expect(panel.getByRole('radio',{name:'留存人数',exact:true})).toHaveAttribute('aria-checked','true');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(await page.evaluate(()=>document.documentElement.scrollHeight)).toBe(950);
    expect(await panel.locator('tbody tr').first().locator('td').nth(2).evaluate(cell=>cell.getBoundingClientRect().width)).toBeGreaterThanOrEqual(110);
    await page.screenshot({path:`/private/tmp/ypbi-retention-redesign-${width}.png`});
  }
});

test("分组显示保留至少一组，同日明细与完整分组可切换",async({page})=>{
  await page.goto(board('5.9'));
  const panel=page.getByRole('article',{name:'消费结构',exact:true});
  await panel.getByRole('radio',{name:'新老用户',exact:true}).click();
  const legend=panel.getByRole('group',{name:'消费结构分组',exact:true});
  await legend.getByRole('button',{name:'老用户',exact:true}).click();
  await expect(panel).toContainText('显示 1/2 组');
  await legend.getByRole('button',{name:'新用户',exact:true}).click();
  await expect(panel).toContainText('显示 1/2 组');
  await panel.getByRole('button',{name:'查看同口径数据表',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await expect(dialog).toContainText('已显示：新用户');
  await dialog.getByRole('button',{name:'查看全部分组',exact:true}).click();
  await expect(dialog.getByRole('columnheader',{name:'老用户',exact:true})).toBeVisible();
  await expect(dialog.locator('tbody tr').first().locator('td').nth(2)).toContainText('人');
  await page.keyboard.press('Escape');
  await panel.getByRole('button',{name:'恢复全部',exact:true}).click();
  await expect(panel).toContainText('显示 2/2 组');
  for(const width of [1280,1024,390]) {await page.setViewportSize({width,height:950});await panel.scrollIntoViewIfNeeded();await page.screenshot({path:`/private/tmp/ypbi-group-redesign-${width}.png`});expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);}
});

test("收入构成、基数、新老付费与独立趋势联动，固定环心不重算",async({page})=>{
  await page.goto(board('5.10'));
  const income=page.getByRole('article',{name:'商品与分端收入',exact:true}),users=page.getByRole('article',{name:'新老用户付费表现',exact:true});
  await expect(income.getByRole('img',{name:'商品收入构成构成环图',exact:true})).toBeVisible();
  const total=await users.locator('.composition-chart__center strong').innerText();
  await users.getByRole('group',{name:'新老用户付费分组',exact:true}).getByRole('button',{name:'老用户',exact:true}).click();
  await expect(users.locator('.composition-chart__center strong')).toHaveText(total);
  await expect(users.getByRole('table',{name:'新老付费摘要',exact:true}).locator('tbody tr')).toHaveCount(2);
  await users.getByRole('radio',{name:'ARPPU',exact:true}).click();
  await users.getByRole('button',{name:'查看同口径数据表',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('新用户付费用户数');
  await page.keyboard.press('Escape');
  await income.getByRole('radio',{name:'按客户端',exact:true}).click();
  await income.getByRole('radio',{name:'占比',exact:true}).click();
  await income.getByRole('button',{name:'查看商品 × 客户端明细',exact:true}).click();
  await expect(income.getByRole('table',{name:'商品与客户端交叉明细',exact:true}).locator('tbody tr')).toHaveCount(2);
  await expect(income.getByRole('table',{name:'商品与客户端交叉明细',exact:true}).locator('tbody')).not.toContainText('USD');
  for(const width of [1280,1024,390]) {await page.setViewportSize({width,height:950});await income.scrollIntoViewIfNeeded();await page.screenshot({path:`/private/tmp/ypbi-income-redesign-${width}.png`});expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);}
});
