import {expect,test,type Page} from "@playwright/test";
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import type {DailyDashboardQuery,DailyDashboardSuccess} from "./contracts/daily-dashboard";

test.use({channel:"chrome",viewport:{width:1280,height:900}});
const base=process.env.YPBI_BASE_URL??"http://127.0.0.1:5187";
const generated=JSON.parse(execFileSync("bun",["-e",`
  import {DailyDashboardService,dailyDashboardCatalog} from './server/v2/daily-dashboard.service';
  const service=new DailyDashboardService({get:async()=>({msg:{pageData:[],totalCount:0},data:[]})});
  const result=await service.execute({boardId:'5.8',pid:'PH',dateRange:['2026-07-01','2026-08-31']});
  process.stdout.write(JSON.stringify({catalog:dailyDashboardCatalog(true),result}));
`],{encoding:"utf8"}));
const url=base+"/dashboards/public?board=5.8&pid=PH&start=2026-07-01&end=2026-08-31&compare=previous";
const matrix=(page:Page)=>page.locator(".dashboard-panel").filter({has:page.getByRole("heading",{name:"注册留存明细",exact:true})});
const card=(page:Page,name:string)=>page.locator(".dashboard-metric-card").filter({has:page.getByRole("link",{name,exact:true})}).first();
async function fixtures(page:Page,splitState=false) {
  const calls:DailyDashboardQuery[]=[],errors:string[]=[];
  page.on("pageerror",error=>errors.push(error.message));
  await page.route("**/api/bi/v2/**",async route=>{
    const path=new URL(route.request().url()).pathname;
    let body:unknown;
    if(path.endsWith("/auth/session"))body={success:true,data:{user:{subjectId:"00000000-0000-4000-8000-000000000001",username:"qa.reader",displayName:"隔离验收",role:"reader",permissions:["bi:read","bi:export"],pidScope:"all"},expiresAt:"2099-01-01T00:00:00.000Z",csrfToken:"a".repeat(43),mustChangePassword:false}};
    else if(path.endsWith("/catalog/readable-dashboards"))body=generated.catalog;
    else if(path.endsWith("/catalog/platforms"))body={success:true,data:{items:[{id:"HX-001",pid:"PH",name:"Pornhub",order:1}]}};
    else if(path.endsWith("/queries/dashboards/daily-reading")) {
      const query=route.request().postDataJSON() as DailyDashboardQuery;calls.push(query);
      expect(Object.keys(query).sort()).toEqual(["boardId","dateRange","pid"]);
      const result=structuredClone(generated.result) as DailyDashboardSuccess;
      result.data.query=query;
      const count=(Date.parse(query.dateRange[1])-Date.parse(query.dateRange[0]))/86400000+1;
      result.data.series=result.data.series.map(series=>({...series,points:Array.from({length:count},(_,i)=>{
        const date=new Date(Date.parse(query.dateRange[0])+i*86400000).toISOString().slice(0,10),id=series.metric.id;
        const suffix=id.split(".")[1]??"overall",scope={overall:8,android:1,ios:2,natural:3,internal:4}[suffix]??5;
        const retention=/^M02[0-3](\.|$)/.test(id),n=retention?scope:100,denominator=retention?10:200;
        const value=series.metric.inputs.length===2?n/denominator:n;
        const point:DailyDashboardSuccess["data"]["series"][number]["points"][number]={date,state:"available",sourceStatus:"READY",value,inputs:series.metric.inputs.map((input,j)=>({key:input.key,value:j===0?n:denominator}))};
        if(splitState && id==="M021.android") {point.inputs[1].value=7;point.value=1/7;}
        if(splitState && ["M020.android","M022.android","M023.android"].includes(id)) return {...point,state:id==="M020.android"?"no_record":id==="M022.android"?"source_failure":"immature",sourceStatus:id==="M020.android"?undefined:id==="M022.android"?"FAILED":"NOT_MATURE",value:null,inputs:point.inputs.map(input=>({...input,value:null}))};
        return point;
      })}));
      body=result;
    } else return route.fulfill({status:404,json:{success:false,error:{code:"NOT_FOUND",message:"隔离验收未配置",requestId:"qa"}}});
    return route.fulfill({status:200,json:body});
  });
  return {calls,errors};
}
async function choose(page:Page,label:string) {
  await matrix(page).getByRole("button",{name:/^注册日分组：/}).click();
  await page.getByRole("option",{name:label,exact:true}).click();
}

test("五范围联动卡片矩阵，保持活跃与公共查询并恢复历史刷新",async({page})=>{
  const control=await fixtures(page);await page.goto(url);
  await expect(card(page,"注册用户D1留存率").locator(".dashboard-metric-card__value")).toContainText("80.00",{timeout:20000});
  await expect(card(page,"日活跃用户数").locator(".dashboard-metric-card__value")).toContainText("100");
  for(const [label,value] of [["注册Android","10.00"],["注册iOS","20.00"],["自然新增","30.00"],["内部导量","40.00"]]) {
    await choose(page,label);
    await expect(card(page,"注册用户D1留存率").locator(".dashboard-metric-card__value")).toContainText(value);
    await expect(matrix(page).getByRole("button",{name:`2026-07-01 次日 ${value}%`,exact:true})).toBeVisible();
    await expect(card(page,"日活跃用户数").locator(".dashboard-metric-card__value")).toContainText("100");
  }
  await page.goBack();await expect(matrix(page).getByRole("button",{name:"注册日分组：自然新增",exact:true})).toBeVisible();
  await page.goForward();await expect(matrix(page).getByRole("button",{name:"注册日分组：内部导量",exact:true})).toBeVisible();
  await page.reload();await expect(matrix(page).getByRole("button",{name:"注册日分组：内部导量",exact:true})).toBeVisible();
  const before=control.calls.length;await page.getByRole("button",{name:"刷新看板",exact:true}).click();
  await expect.poll(()=>control.calls.length).toBeGreaterThan(before);
  await expect(matrix(page).getByRole("button",{name:"注册日分组：内部导量",exact:true})).toBeVisible();
  const scope=JSON.parse(new URL(page.url()).searchParams.get("view")!).reading.cohortScope;expect(scope).toBe("internal");
  await page.getByRole("button",{name:"关闭提示",exact:true}).click();
  for(const width of [1280,1440,1024,390]) {
    await page.setViewportSize({width,height:900});await matrix(page).scrollIntoViewIfNeeded();
    await expect(matrix(page).getByRole("button",{name:"注册日分组：内部导量",exact:true})).toBeVisible();
    await page.screenshot({path:`/private/tmp/ypbi-cohort-scope-${width}.png`});
  }
  expect(control.errors).toEqual([]);
});

test("切换关闭详情并重置分页，矩阵与整页导出只含当前D0分组",async({page})=>{
  const control=await fixtures(page);await page.goto(url);await choose(page,"注册Android");
  await matrix(page).getByRole("radio",{name:"表格",exact:true}).check();
  const pagination=matrix(page).getByRole("navigation",{name:"注册留存明细分页",exact:true});
  await pagination.getByRole("button",{name:"下一页",exact:true}).click();await expect(pagination).toContainText("51–62");
  await choose(page,"注册iOS");await matrix(page).getByRole("radio",{name:"表格",exact:true}).check();await expect(pagination).toContainText("1–50");
  await matrix(page).getByRole("button",{name:"2026-07-01 第 3 天 20.00%",exact:true}).click();
  await expect(page.getByRole("dialog")).toContainText("注册iOS");
  await page.goBack();await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(matrix(page).getByRole("button",{name:"注册日分组：注册Android",exact:true})).toBeVisible();
  await matrix(page).getByRole("button",{name:"导出注册留存明细",exact:true}).first().click();
  const download=page.waitForEvent("download");await page.getByRole("dialog").getByRole("button",{name:"下载 XLSX",exact:true}).click();
  const text=readFileSync((await(await download).path())!,"utf8");expect(text).toContain("注册Android");expect(text).not.toContain("注册iOS");expect(text).toContain("对比注册留存");
  await page.getByRole("button",{name:"导出活跃与留存",exact:true}).click();
  const full=page.waitForEvent("download");await page.getByRole("dialog").getByRole("button",{name:"下载真实 XLSX",exact:true}).click();
  const fulltext=readFileSync((await(await full).path())!,"utf8");expect(fulltext).toContain("注册Android");expect(fulltext).not.toContain("M021.ios");expect(fulltext).not.toContain("M115.d1");
  expect(control.errors).toEqual([]);
});

test("D1缺失D3独立可读，单周期失败与未成熟保留状态和直接分母",async({page})=>{
  const control=await fixtures(page,true);await page.goto(url);await choose(page,"注册Android");
  await expect(matrix(page).getByRole("button",{name:"2026-07-01 次日 当日无记录 · 待验数",exact:true})).toBeVisible();
  await expect(matrix(page).getByRole("button",{name:"2026-07-01 第 7 天 数据异常 · 待验数",exact:true})).toBeVisible();
  await expect(matrix(page).getByRole("button",{name:"2026-07-01 第 30 天 待成熟 · 待验数",exact:true})).toBeVisible();
  await matrix(page).getByRole("button",{name:"2026-07-01 第 3 天 14.29%",exact:true}).click();
  const dialog=page.getByRole("dialog");await expect(dialog).toContainText("注册Android");await expect(dialog).toContainText("14.29%");
  await expect(dialog.locator(".calculation-evidence")).toContainText("7");
  expect(control.errors).toEqual([]);
});
