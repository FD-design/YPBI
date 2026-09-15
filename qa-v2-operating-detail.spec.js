import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5197";
test.use({ channel: "chrome" });
const target = `${base}/dashboards/public?design=dashboard-center&board=5.2`;
const section = page => page.locator('.core-review__detail');
async function expectValueRowsAligned(local) {
  const boxes = await local.locator('.is-value').evaluateAll(cards => cards.map(card => {
    const { y, height } = card.getBoundingClientRect(); return { y, height };
  }));
  for (const left of boxes) for (const right of boxes) {
    if (Math.abs(left.y - right.y) < 1) expect(Math.abs(left.height - right.height)).toBeLessThan(1);
  }
}
async function choosePlatform(page, name) {
  await section(page).getByRole("button", { name: /^经营明细平台：/ }).click();
  await page.getByRole("option", { name, exact: true }).click();
}

test("局部平台仅联动经营卡、宽表和真实下载，保留首屏九张趋势卡", async ({ page }) => {
  const errors=[]; page.on("pageerror",e=>errors.push(e.message));
  await page.goto(target);
  const trend = page.locator('.core-review__metric-grid .dashboard-metric-card');
  await expect(trend).toHaveCount(9);
  const before = await trend.allTextContents();
  const local = section(page);
  await expect(local.locator('.dashboard-metric-card.is-value')).toHaveCount(6);
  await expect(local.locator('.dashboard-mini-trend, .trend-range')).toHaveCount(0);
  await expect(local.locator('tbody tr')).toHaveCount(4);
  await expect(local.getByRole('button',{name:'经营明细平台：全部平台',exact:true})).toBeVisible();
  await choosePlatform(page,'TikTok');
  await expect(local.locator('tbody tr')).toHaveCount(1);
  await expect(local.locator('tbody tr')).toContainText('TikTok');
  await expect(local.locator('.dashboard-metric-card').first().locator('.dashboard-metric-card__value strong')).toHaveText('60,000');
  await expect(local.locator('.dashboard-metric-card').last()).toContainText('未成熟');
  expect(await trend.allTextContents()).toEqual(before);
  await local.getByRole('button',{name:'导出经营明细',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'导出经营明细',exact:true});
  await expect(dialog).toContainText('数据日 2026-09-08 · TikTok');
  const download=page.waitForEvent('download');
  await dialog.getByRole('button',{name:'下载演示 XLSX',exact:true}).click();
  const file=await download; expect(file.suggestedFilename()).toBe('经营明细-演示数据.xlsx');
  await file.saveAs('/private/tmp/ypbi-operating-detail.xlsx');
  // The shared writer emits uncompressed XML ZIP entries; inspect the actual downloaded payload.
  const content=(await readFile(await file.path())).toString('utf8');
  expect(content).toContain('01_经营明细'); expect(content).toContain('02_数值摘要');
  expect(content).toContain('03_字段说明');
  for (const name of ['总充值ARPPU','新增充值ARPPU','广告总人次比例','支付宝拉单次数','微信成功率','次留登陆人数','3留登陆人数','7留登陆人数','访问-下载转化','M112','M114','次/人','MAU｜自然月']) expect(content).toContain(name);
  expect(content).toContain('TikTok'); expect(content).not.toContain('Pornhub');
  expect(content).toContain('活跃用户观影率（Android）'); expect(content).toContain('待接口支持');
  await choosePlatform(page,'全部平台'); await expect(local.locator('tbody tr')).toHaveCount(4);
  expect(errors).toEqual([]);
});

test("三档布局紧凑可读，横向滚动只在宽表；待接入列与弹窗可操作", async ({ page }) => {
  await page.goto(target);
  for(const width of [1280,1024,390]) {
    await page.setViewportSize({width,height:950});
    const local=section(page); await local.scrollIntoViewIfNeeded();
    for(const card of await local.locator('.is-value').all()) {
      const box=await card.boundingBox(); expect(box.width).toBeGreaterThan(150); expect(box.height).toBeLessThan(230);
      await expect(card.locator('.dashboard-mini-trend')).toHaveCount(0);
    }
    await expectValueRowsAligned(local);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight)).toBe(950);
    for (const name of ['日活Android:iOS比值', '新增Android:iOS比值']) {
      const heading = local.locator('th').filter({hasText:name});
      await expect(heading).toHaveCount(1);
      await expect(heading.locator('.metric-heading-unit')).toHaveCount(0);
    }
    const first=local.locator('tbody tr').first().locator('td[data-column-key="M016:overall"]');
    expect((await first.boundingBox()).width).toBeLessThan(174);
    const unsupported=local.locator('tbody tr').first().locator('td[data-column-key="M016:Android"]').getByRole('button');
    await unsupported.scrollIntoViewIfNeeded(); await unsupported.click();
    const dialog=page.getByRole('dialog',{name:'日活跃用户数（Android）',exact:true});
    await expect(dialog).toContainText('待接口支持'); await expect(dialog).toContainText('旧接口已有端别日活');
    await expect(dialog.getByRole('button',{name:/关闭/})).toHaveCount(1);
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(unsupported).toBeFocused();
    await local.locator('.core-review__comparison-scroll').evaluate(el=>el.scrollLeft=0);
    await local.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.screenshot({path:`/private/tmp/ypbi-operating-detail-${width}.png`,fullPage:false});
  }
});

test("完整图表体验复用纯数值变体并保留详细趋势、零值与对比", async ({page})=>{
  await page.goto(`${base}/dashboards/public?design=v1-chart-states`);
  const examples=page.locator('[data-chart-kind="kpi-compact"]');
  await expect(examples.getByRole('heading',{name:'纯数值卡',exact:true})).toBeVisible();
  await expect(examples.locator('.dashboard-metric-card.is-value')).toHaveCount(11);
  await expect(examples.locator('.dashboard-mini-trend')).toHaveCount(0);
  await expect(examples.locator('.is-value').last().locator('.dashboard-metric-card__value strong')).toHaveText('0');
  await expect(page.locator('[data-chart-kind="kpi-detailed"] .dashboard-metric-card.is-detailed')).toHaveCount(1);
  for(const width of [1280,1024,390]){
    await page.setViewportSize({width,height:950});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const info=examples.locator('.is-value').first().getByRole('button',{name:/说明$/});
    await info.click(); await expect(page.getByRole('dialog')).toContainText('日活跃用户数'); await page.keyboard.press('Escape');
  }
  await page.setViewportSize({width:1280,height:950}); await examples.scrollIntoViewIfNeeded();
  await page.screenshot({path:'/private/tmp/ypbi-value-gallery.png',fullPage:false});
});

test("纯数值卡五类拆解和说明独立，详情关闭返回入口且宽表完整", async ({ page }) => {
  await page.goto(target);
  const local = section(page);
  await expect(local.locator('thead th')).toHaveCount(77);
  const headers = await local.locator('thead th').allTextContents();
  for (const name of ['日活跃用户数', '新增用户数', '观影用户数', '活跃用户观影率', '注册用户D1留存率']) {
    const trigger = local.getByRole('button', { name: new RegExp(`^${name}，按`) });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: `${name} · 维度拆解`, exact: true });
    await expect(dialog.locator('.metric-breakdown__group')).toHaveCount(2);
    await expect(dialog).toContainText('Android'); await expect(dialog).toContainText('iOS');
    if (['新增用户数', '注册用户D1留存率'].includes(name)) { await expect(dialog).toContainText('自然新增'); await expect(dialog).not.toContainText('老用户'); }
    else await expect(dialog).toContainText('老用户');
    await expect(dialog).toContainText(name === '注册用户D1留存率' ? '未成熟' : '待接口支持');
    await expect(dialog.locator('.metric-breakdown__track')).toHaveCount(0);
    await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
  }
  expect(await local.locator('thead th').allTextContents()).toEqual(headers);
  await local.getByRole('group', { name: '经营明细纯数值卡' }).getByRole('button', { name: '查看日活跃用户数说明', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toContainText('维度拆解'); await page.keyboard.press('Escape');
  const title = local.getByRole('button', { name: /^日活跃用户数，按/ });
  await title.focus(); await page.keyboard.press('Enter'); await expect(page.getByRole('dialog')).toContainText('维度拆解');
  await page.keyboard.press('Escape'); await expect(title).toBeFocused();
  await choosePlatform(page, 'TikTok');
  await local.getByRole('button', { name: /^日活跃用户数，按/ }).click();
  await expect(page.getByRole('dialog')).toContainText('TikTok'); await expect(page.getByRole('dialog')).toContainText('60,000');
});

test("摘要展开收起、新增拆解与搜索定位不裁剪宽表", async ({page}) => {
  await page.goto(target);
  const local = section(page);
  await local.getByRole('button', {name:'展开全部 10 项',exact:true}).click();
  await expect(local.locator('.dashboard-metric-card.is-value')).toHaveCount(10);
  await expect(local.locator('.is-value').filter({has:page.getByRole('button',{name:/^活跃用户-付费转化率，按/})}).locator('.dashboard-metric-card__value strong')).toHaveText('1.40');
  for (const width of [1280, 1024, 390]) {
    await page.setViewportSize({width,height:950});
    await expect(local.getByRole('button',{name:/^定位经营明细指标列/})).toContainText('搜索并定位指标列');
    for (const card of await local.locator('.is-value').all()) {
      const box=await card.boundingBox(); expect(box.width).toBeGreaterThan(150); expect(box.height).toBeLessThan(230);
      await expect(card.locator('.dashboard-mini-trend')).toHaveCount(0);
    }
    await expectValueRowsAligned(local);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await local.locator('.is-value').first().evaluate(el=>el.scrollIntoView({block:'start'}));
    await page.screenshot({path:`/private/tmp/ypbi-operating-expanded-${width}.png`});
  }
  await page.setViewportSize({width:1280,height:950});
  for (const name of ['付费用户数','活跃用户-付费转化率','付费用户人均充值金额（ARPPU）','活跃用户广告点击渗透率']) {
    const trigger = local.getByRole('button', {name:new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}，按`)});
    await trigger.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('.metric-breakdown__group')).toHaveCount(1);
    await expect(dialog).toContainText('新用户');
    await expect(dialog).toContainText('待接口支持');
    await page.keyboard.press('Escape');
  }
  await local.getByRole('button',{name:/^定位经营明细指标列/}).click();
  await page.getByRole('searchbox').last().fill('支付宝拉单次数');
  await page.getByRole('option').click();
  await expect(local.locator('th.is-located')).toHaveAttribute('data-column-key','M112:支付宝');
  const position=await local.locator('th.is-located').boundingBox();
  const scroller=await local.locator('.core-review__comparison-scroll').boundingBox();
  expect(position.x).toBeGreaterThanOrEqual(scroller.x + 215);
  expect(position.x + position.width).toBeLessThanOrEqual(scroller.x + scroller.width);
  await expect(local.locator('thead th')).toHaveCount(77);
  await local.getByRole('button',{name:'收起',exact:true}).click();
  await expect(local.locator('.dashboard-metric-card.is-value')).toHaveCount(6);
});

test("完整体验拆解同时可见、比例固定刻度，手机详情全宽", async ({ page }) => {
  await page.goto(`${base}/dashboards/public?design=v1-chart-states`);
  for (const width of [1280, 1024, 772, 390]) {
    await page.setViewportSize({ width, height: 950 });
    await page.getByRole('button', { name: /^活跃用户观影率，按/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toHaveCSS('opacity', '1');
    await expect(dialog).toContainText('固定视觉样例');
    await expect(dialog.locator('.metric-breakdown__group')).toHaveCount(2);
    await expect(dialog.locator('.metric-breakdown__track')).toHaveCount(4);
    await expect(dialog).toContainText('36 人 / 活跃 50 人');
    expect(await dialog.locator('.metric-breakdown__track > div').first().getAttribute('style')).toContain('72%');
    const box = await dialog.boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
    if(width === 390) expect(box.width).toBe(width);
    await page.screenshot({ path: `/private/tmp/ypbi-breakdown-${width}.png` });
    await page.keyboard.press('Escape');
  }
});
