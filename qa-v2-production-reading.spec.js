import {test,expect} from '@playwright/test';
const base=process.env.YPBI_BASE_URL??'http://127.0.0.1:5173';
const board=id=>`${base}/dashboards/public?design=dashboard-center&board=${id}`;
test.use({channel:'chrome',viewport:{width:1280,height:950}});
test.afterEach(async({page},info)=>{if(info.status!==info.expectedStatus)await page.screenshot({path:`/private/tmp/ypbi-sept12-failure-${info.line}.png`,fullPage:true});});
async function tools(page){await page.getByRole('button',{name:/账号菜单/}).click();await page.getByRole('menuitem',{name:'体验工具',exact:true}).click();}
test('长日期热力图保留行高、全日期、固定表头与一次公式',async({page})=>{
  test.setTimeout(90000);
  for(const [start,total] of [['2026-08-01',39],['2026-06-11',90],['2026-03-13',180]]){
    const range={start,end:'2026-09-08'};
    await page.goto(board('5.8')+'&view='+encodeURIComponent(JSON.stringify({v:1,active:range,cohort:range,failure:range,compared:false,mixed:false})));
    const panel=page.getByRole('article',{name:'注册留存明细',exact:true});
    const heatmap=panel.getByRole('region',{name:'注册留存明细全部日期热力图'});
    await expect(heatmap.locator('tbody tr')).toHaveCount(total);
    for(const width of [1280,1024,390]){
      await page.setViewportSize({width,height:950});
      expect(await heatmap.locator('tbody tr').first().evaluate(el=>el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(32);
      await heatmap.evaluate(el=>{el.scrollTop=el.scrollHeight;el.scrollLeft=el.scrollWidth;});
      await expect(heatmap.locator('tbody tr').last()).toContainText('2026-09-08');
      const bounds=await heatmap.evaluate(el=>({top:el.getBoundingClientRect().top,head:el.querySelector('thead th').getBoundingClientRect().top,overflow:el.scrollHeight>el.clientHeight}));
      expect(bounds.overflow).toBe(true);expect(Math.abs(bounds.head-bounds.top)).toBeLessThan(3);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      if(total===39){await heatmap.evaluate(el=>{el.scrollTop=0;el.scrollLeft=0;});await panel.screenshot({path:`/private/tmp/ypbi-sept12-retention-${width}.png`});}
    }
    await panel.getByRole('button',{name:'查看同口径数据表',exact:true}).click();
    const dialog=page.getByRole('dialog');
    await expect(dialog.getByRole('columnheader',{name:'公式',exact:true})).toHaveCount(0);
    await expect(dialog.locator('.retention-matrix__formula > p')).toHaveText('留存率 = 对应周期留存人数 ÷ 注册用户数 × 100%');
    await expect(dialog.getByRole('columnheader',{name:'注册用户数',exact:true})).toBeVisible();
    await expect(dialog.getByRole('columnheader',{name:'留存人数',exact:true})).toBeVisible();
    await page.keyboard.press('Escape');
  }
});
test('公共和我的概览在同一工作台切换并保留对象与浏览器历史',async({page})=>{
  await page.goto(board('5.12'));
  const before=await page.locator('.dashboard-workbench__directory').boundingBox();
  await page.locator('.dashboard-workbench__scope').getByRole('link',{name:'我的概览'}).click();
  await expect(page.getByRole('heading',{name:'我的概览',exact:true})).toBeVisible();
  const after=await page.locator('.dashboard-workbench__directory').boundingBox();expect(after).toEqual(before);
  await page.getByRole('button',{name:'新建看板',exact:true}).click();
  await page.getByRole('dialog').getByRole('textbox').fill('业务观察');
  await page.getByRole('dialog').getByRole('button',{name:'保存本次体验',exact:true}).click();
  await expect(page.getByRole('heading',{name:'业务观察',exact:true})).toBeVisible();
  await expect(page.getByRole('navigation',{name:'个人看板列表'}).getByRole('link',{name:'业务观察'})).toHaveAttribute('aria-current','page');
  await page.locator('.dashboard-workbench__scope').getByRole('link',{name:'公共概览'}).click();
  await expect(page.getByRole('heading',{name:'播放与观看质量',exact:true})).toBeVisible();
  await page.goBack();await expect(page.getByRole('heading',{name:'业务观察',exact:true})).toBeVisible();
  for(const width of [1280,1024,390]){
    await page.setViewportSize({width,height:950});
    if(width===390){await page.getByRole('button',{name:'选择看板',exact:true}).click();await expect(page.getByRole('dialog',{name:'选择看板'}).getByRole('link',{name:'业务观察'})).toBeVisible();await page.keyboard.press('Escape');}
    await page.screenshot({path:`/private/tmp/ypbi-sept12-mine-${width}.png`});
  }
  await page.reload();await expect(page.getByRole('heading',{name:'本次体验对象已失效'})).toBeVisible();
});
test('评审工具不占页面且完整保留，低选项无搜索，比较维度只有一个选择器',async({page})=>{
  for(const id of ['5.2','5.7','5.8','5.9','5.12','5.15','5.5']){
    await page.goto(board(id));
    await expect(page.locator('.dashboard-workbench')).toBeVisible();
    await expect(page.getByRole('link',{name:'返回经典版'})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'组合异常态',exact:true})).toHaveCount(0);
    await expect(page.locator('.data-origin-badge').first()).toBeVisible();
    await tools(page);
    await expect(page.getByRole('dialog').getByRole('link',{name:'查看完整图表体验',exact:true})).toBeVisible();
    await page.getByRole('dialog').getByRole('button',{name:'组合异常态',exact:true}).click();
    await page.getByRole('dialog').getByRole('button',{name:'正常态',exact:true}).click();
    await page.keyboard.press('Escape');
  }
  await page.goto(board('5.12'));
  const panel=page.getByRole('article',{name:'播放质量诊断',exact:true});
  await panel.getByRole('button',{name:/播放质量诊断指标：/}).click();
  await expect(panel.getByRole('listbox').getByRole('searchbox')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await panel.getByRole('button',{name:/播放质量诊断分组：/}).click();
  await expect(panel.getByRole('option',{name:'播放模式',exact:true})).toBeVisible();
  await panel.getByRole('option',{name:'播放模式',exact:true}).click();
  await expect(panel.getByRole('button',{name:/更多维度/})).toHaveCount(0);
  await panel.screenshot({path:'/private/tmp/ypbi-sept12-diagnostics.png'});
});
test('功能业务图提示不暴露内部页面编码',async({page})=>{
  await page.goto(board('5.5'));
  const chart=page.getByRole('img',{name:'全部功能渗透率横向比较'});
  const box=await chart.boundingBox();await page.mouse.move(box.x+220,box.y+35);
  await expect(page.locator('.ui-chart-tooltip:visible')).toContainText('使用用户');
  await expect(page.locator('.ui-chart-tooltip:visible')).not.toContainText(/[a-z]+_[a-z]+/);
  await expect(page.locator('body')).not.toContainText('points_game_detail');
  await page.screenshot({path:'/private/tmp/ypbi-sept12-function-hover.png'});
});
test('旧后台404给出准确原因和恢复路径，不绕过认证',async({page})=>{
  await page.route('**/api/bi/v2/auth/session',route=>route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({statusCode:404,error:'Not Found'})}));
  await page.goto(`${base}/admin/data-sources`);
  await expect(page.getByRole('alert')).toContainText('未提供新版登录接口');
  await expect(page.locator('.ypbi-v2 .v2-topbar')).toHaveCount(0);
  await page.getByRole('link',{name:'返回看板预览'}).click();
  await expect(page.getByRole('heading',{name:'核心经营总览',exact:true})).toBeVisible();
});
