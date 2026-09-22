import { test, expect } from "@playwright/test";
test.use({channel:"chrome",viewport:{width:1440,height:1000}});
const base=process.env.YPBI_BASE_URL??"http://127.0.0.1:5173";
const href=path=>base+path+"?design=personal-workspace";
async function choose(page,label,name) {
  await page.getByRole("button",{name:new RegExp("^"+label+"：")}).first().click();
  const box=page.getByRole("listbox",{name:label,exact:true});
  const search=box.getByRole("searchbox");
  if(await search.count()) await search.fill(name);
  await box.getByRole("option",{name:new RegExp("^"+name)}).first().click();
}
async function event(page,name){await choose(page,"选择事件",name);}
async function query(page){await page.getByRole("button",{name:"查询样例",exact:true}).click();}
test("换事件保留兼容条件、取消不丢失、指标别名进入结果",async({page})=>{
  await page.goto(href("/analysis/events")); await event(page,"页面停留");
  await page.getByRole("button",{name:"分析项A局部：添加筛选",exact:true}).click();
  await choose(page,"分析项A局部属性1","客户端平台");
  await choose(page,"分析项A局部筛选值1","iOS");
  await page.keyboard.press("Escape");
  await choose(page,"分析项1统计方式","属性统计");
  await choose(page,"数值属性","页面有效停留时长"); await choose(page,"聚合方式","求和");
  page.once("dialog",d=>d.dismiss()); await event(page,"应用启动");
  await expect(page.getByRole("button",{name:/^选择事件：页面停留/})).toBeVisible();
  page.once("dialog",d=>d.accept()); await event(page,"应用启动");
  await expect(page.getByRole("button",{name:/^分析项A局部筛选值1：iOS/})).toBeVisible();
  await expect(page.getByRole("button",{name:/^分析项1统计方式：总次数/})).toBeVisible();
  await query(page);
  await page.goto(href("/analysis/metrics")); await choose(page,"选择指标","日活跃用户数");
  await page.getByRole("textbox",{name:"分析项1别名",exact:true}).fill("每日活跃规模"); await query(page);
  await expect(page.locator(".personal-summary")).toContainText("每日活跃规模");
});
test("事件配置、饼图、二维交叉、完整表与过期保护",async({page})=>{
  const errors=[]; page.on("pageerror",e=>errors.push(e.message));
  await page.goto(href("/analysis/events")); await event(page,"应用启动");
  await choose(page,"分组维度","客户端平台"); await query(page);
  await expect(page.getByRole("tab",{name:"饼图",exact:true})).toBeVisible();
  await page.getByRole("tab",{name:"饼图",exact:true}).click();
  await expect(page.getByRole("table",{name:"完整聚合结果",exact:true})).toBeVisible();
  await page.screenshot({path:"/private/tmp/ypbi-analysis-pie.png",fullPage:true});
  await choose(page,"分析项1统计方式","触发用户数");
  await expect(page.getByRole("button",{name:"导出样例",exact:true})).toBeDisabled();
  await query(page); await expect(page.getByRole("tab",{name:"饼图",exact:true})).toHaveCount(0);
  await choose(page,"第二分组维度","是否登录"); await query(page);
  await expect(page.getByRole("tab",{name:"交叉明细",exact:true})).toBeVisible();
  await choose(page,"明细布局","日期展开为列");
  await expect(page.getByRole("table",{name:"按日期展开的完整结果"})).toBeVisible();
  expect(errors).toEqual([]);
});
test("局部属性统计、全局筛选与继续拆解",async({page})=>{
  await page.goto(href("/analysis/events")); await event(page,"页面停留");
  await choose(page,"分析项1统计方式","属性统计");
  await choose(page,"数值属性","页面有效停留时长"); await choose(page,"聚合方式","求和");
  await choose(page,"分组维度","客户端平台"); await query(page);
  const drill=page.getByRole("button",{name:/^继续拆解 /}).first();
  await drill.click();
  await page.getByRole("option",{name:"是否登录",exact:true}).click();
  await expect(page.getByRole("button",{name:/返回上层分析/})).toBeVisible();
  await expect(page.getByText(/条件已修改，以下仍为上次结果/)).toBeVisible();
  await query(page);
  await page.getByRole("button",{name:/返回上层分析/}).click();
  await expect(page.getByRole("button",{name:/^分组维度：客户端平台/})).toBeVisible();
});
test("漏斗步骤、窗口、保存重开与完整导出",async({page})=>{
  const errors=[]; page.on("pageerror",e=>errors.push(e.message));
  await page.goto(href("/analysis/funnels")); await event(page,"视频内容点击");
  await page.getByRole("button",{name:"选择事件：未选择",exact:true}).click();
  await page.getByRole("searchbox",{name:"搜索选择事件"}).fill("视频播放开始");
  await page.getByRole("option",{name:/^视频播放开始/}).click();
  await query(page); await expect(page.getByRole("table",{name:"漏斗完整聚合结果"})).toBeVisible();
  await page.getByRole("tab",{name:"转化趋势",exact:true}).click();
  await page.getByRole("spinbutton",{name:"转化窗口分钟"}).fill("1");
  await expect(page.getByRole("button",{name:"导出样例",exact:true})).toBeDisabled();
  await query(page);
  await page.getByRole("button",{name:"保存配置",exact:true}).click();
  await page.getByRole("textbox",{name:"方案名称"}).fill("视频有序转化体验");
  await page.getByRole("button",{name:"保存本次体验",exact:true}).click();
  await page.getByRole("link",{name:"已保存的分析",exact:true}).click();
  await page.getByRole("link",{name:"视频有序转化体验",exact:true}).click();
  await expect(page.getByRole("spinbutton",{name:"转化窗口分钟"})).toHaveValue("1");
  const download=page.waitForEvent("download");
  await page.getByRole("button",{name:"导出样例",exact:true}).click();
  await(await download).saveAs("/private/tmp/ypbi-funnel-rebuild.xlsx");
  await page.screenshot({path:"/private/tmp/ypbi-funnel-rebuild.png",fullPage:true});
  expect(errors).toEqual([]);
});
test("指标分析顶部配置、异单位分图与响应式",async({page})=>{
  await page.goto(href("/analysis/metrics")); await choose(page,"选择指标","日活跃用户数");
  await page.getByRole("button",{name:/添加分析项/}).click();
  await page.getByRole("button",{name:"选择指标：未选择",exact:true}).click();
  await page.getByRole("searchbox",{name:"搜索选择指标"}).fill("总充值金额");
  await page.getByRole("option",{name:/^总充值金额/}).click();
  await query(page); await expect(page.locator(".personal-result__chart")).toHaveCount(2);
  for(const width of [1440,1024,390]){
    await page.setViewportSize({width,height:900});
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await page.screenshot({path:`/private/tmp/ypbi-analysis-${width}.png`,fullPage:true});
  }
});
test("只读遮罩关闭、内部拖动不关闭、编辑名称保护与导航漏斗入口",async({page})=>{
  await page.goto(base+"/dashboards/public?design=dashboard-center");
  const trigger=page.locator(".core-review__detail").getByRole("button",{name:/^日活跃用户数，按/});
  await trigger.click();
  let dialog=page.getByRole("dialog");
  const box=await dialog.boundingBox();
  await page.mouse.move(box.x+70,box.y+100); await page.mouse.down();
  await page.mouse.move(10,box.y+100); await page.mouse.up();
  await expect(dialog).toBeVisible();
  await page.mouse.click(10,box.y+100); await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.getByRole("button",{name:"分析中心",exact:true}).click();
  await page.getByRole("link",{name:"漏斗分析",exact:true}).click();
  await expect(page.getByRole("heading",{name:"新建漏斗分析",exact:true})).toBeVisible();
  await event(page,"视频内容点击");
  await page.getByRole("button",{name:"选择事件：未选择",exact:true}).click();
  await page.getByRole("searchbox",{name:"搜索选择事件"}).fill("视频播放开始");
  await page.getByRole("option",{name:/^视频播放开始/}).click();
  await page.getByRole("button",{name:"保存配置",exact:true}).click();
  dialog=page.getByRole("dialog");
  await page.getByRole("textbox",{name:"方案名称"}).fill("尚未保存");
  await page.mouse.click(10,300); await expect(dialog).toBeVisible();
  page.once("dialog",prompt=>prompt.dismiss());
  await page.keyboard.press("Escape"); await expect(dialog).toBeVisible();
  page.once("dialog",prompt=>prompt.accept());
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
});
