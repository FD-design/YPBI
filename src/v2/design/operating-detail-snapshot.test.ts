import { describe, expect, test } from "bun:test";
import { DETAIL_COLUMNS, detailColumnKey, operatingDetailRows, operatingSummaryModels, selectOperatingRows, operatingDetailExportRows, operatingValueLabel, operatingDetailBreakdown } from "./operating-detail-snapshot";
import { OPERATING_BREAKDOWNS, galleryBreakdown } from "./operating-breakdown-preview";
import { operatingColumnDocumentation, OPERATING_SUMMARY_IDS } from "./operating-detail-columns";
import { retentionTargetDate } from "./operating-detail-snapshot";

describe("经营明细单日快照", () => {
  const date = "2026-09-08";
  const rows = operatingDetailRows(date);
  test("73 个展示列同源引用适用维度，新增和留存不拆老用户", () => {
    expect(DETAIL_COLUMNS).toHaveLength(73);
    expect(new Set(DETAIL_COLUMNS.map(detailColumnKey)).size).toBe(73);
    for (const id of ["M008", "M020"]) expect(DETAIL_COLUMNS.filter(c => c.metric.id === id).map(c => c.slice)).toEqual([undefined, "Android", "iOS", "自然新增", "内部导量"]);
  });
  test("全部/单平台选择不修改原快照", () => {
    expect(selectOperatingRows(rows, "all")).toHaveLength(4);
    expect(selectOperatingRows(rows, "TT").map(r => r.name)).toEqual(["TikTok"]);
    expect(selectOperatingRows(rows, "unknown")).toHaveLength(0);
    expect(rows).toHaveLength(4);
  });
  test("单平台数值卡与对应表格单元格同源，保留未成熟", () => {
    for (const row of rows) for (const model of operatingSummaryModels(rows, row.pid, date)) {
      const i = DETAIL_COLUMNS.findIndex(c => c.metric.id === model.metric.id && !c.slice);
      if (model.result.status === "available") expect(model.result.value.raw).toBe(row.values[i].current);
      else expect(["immature", "unsupported"]).toContain(model.result.status);
    }
  });
  test("大盘为独立结果，不相加 PID 人数；注册日尚未成熟", () => {
    const models = operatingSummaryModels(rows, "all", date);
    const dau = models.find(m => m.metric.id === "M016")!;
    expect(dau.result.status).toBe("available");
    if (dau.result.status === "available") expect(dau.result.value.raw).not.toBe(rows.reduce((sum,r) => sum + r.values[0].current!, 0));
    expect(models.find(m => m.metric.id === "M020")!.result.status).toBe("immature");
  });
  test("大盘单日付费率由同快照付费与活跃人数组成，不采用独立随机比例", () => {
    for (const day of ["2026-09-08", "2026-09-07", "2026-08-31"]) {
      const models = operatingSummaryModels(operatingDetailRows(day), "all", day);
      const active = models.find(m => m.metric.id === "M016")!.result;
      const payer = models.find(m => m.metric.id === "M059")!.result;
      const rate = models.find(m => m.metric.id === "M061")!.result;
      expect(active.status).toBe("available"); expect(payer.status).toBe("available"); expect(rate.status).toBe("available");
      if (active.status === "available" && payer.status === "available" && rate.status === "available") {
        expect(rate.value.raw).toBeCloseTo(payer.value.raw / active.value.raw, 10);
        expect(rate.value.display).toBe((payer.value.raw / active.value.raw * 100).toFixed(2));
      }
    }
  });
  test("未接入维度保持空值与原因，不推算端别或新老用户", () => {
    for (const row of rows) DETAIL_COLUMNS.forEach((column,i) => {
      if (!column.slice) return;
      const immature = column.metric.id === "M020";
      expect(row.values[i]).toEqual({ current: null, previousDay: null, previousWeek: null, state: immature ? "immature" : "unsupported" });
      expect(operatingValueLabel(row.values[i], column)).toBe(immature ? "未成熟" : "待接口支持");
    });
  });
  test("演示单日总览不会小于任一平台人数，原始单日比率可核对", () => {
    for(const model of operatingSummaryModels(rows,"all",date)) {
      if(model.result.status!=="available" || !["M016","M008","M026"].includes(model.metric.id))continue;
      const i=DETAIL_COLUMNS.findIndex(c=>c.metric.id===model.metric.id && !c.slice);
      expect(model.result.value.raw).toBeGreaterThanOrEqual(Math.max(...rows.map(r=>r.values[i].current!)));
    }
    const viewers=DETAIL_COLUMNS.findIndex(c=>c.metric.id==="M026");
    const rate=DETAIL_COLUMNS.findIndex(c=>c.metric.id==="M081");
    for(const row of rows) expect(row.values[rate].current).toBeCloseTo(row.values[viewers].current! / row.values[0].current!,6);
  });
  test("宽表每行一个平台；导出数值、百分比、真实0和状态均保留", () => {
    const selected = structuredClone(selectOperatingRows(rows, "TT")); selected[0].values[0].current = 0;
    const output = operatingDetailExportRows(selected, date);
    expect(output).toHaveLength(2);
    expect(output[0]).toHaveLength(307);
    expect(output[1]).toHaveLength(output[0].length);
    expect(new Set(output[0]).size).toBe(output[0].length);
    expect(output[1].slice(0,13)).toEqual([date, "TikTok", "TT", null, "待接口支持", null, "待接口支持", 0, "完整", 60500, 59000, null, "待接口支持"]);
    const i = output[0].indexOf("活跃用户观影率（%）"); expect(output[1][i]).toBeCloseTo(78, 8);
  });
  test("十种摘要拆解使用同一日期和平台，未成熟优先且不伪造可用结果", () => {
    for (const model of operatingSummaryModels(rows, "TT", date)) {
      if (!OPERATING_BREAKDOWNS[model.metric.id]) continue;
      const detail = operatingDetailBreakdown(model, rows, "TT", date);
      expect(detail.metric).toBe(model);
      expect(detail.context).toContain("TikTok"); expect(detail.context).toContain(date);
      expect(detail.groups).toHaveLength(OPERATING_BREAKDOWNS[model.metric.id].length);
      expect(detail.groups.flatMap(g => g.rows).every(r => r.value.status === (model.metric.id === "M020" ? "immature" : "unsupported"))).toBe(true);
      const sample = galleryBreakdown(model);
      expect(sample.sampleOnly).toBe(true);
      expect(sample.groups.flatMap(g => g.rows).every(r => r.value.status === "available")).toBe(true);
    }
  });
  test("切换数据日更新所有行；历史基准保留，计数不变成人数小数", () => {
    expect(rows[0].values[0].previousDay).toBe(88000);
    for (const day of ["2026-08-01", "2026-08-31", "2026-09-07"]) {
      const changed = operatingDetailRows(day);
      expect(changed[0].values[0].current).not.toBe(rows[0].values[0].current);
      for(const row of changed) {
        const metric=(id:string)=>row.values[DETAIL_COLUMNS.findIndex(c=>c.metric.id===id && !c.slice)].current!;
        expect(metric("M081")).toBeCloseTo(metric("M026") / metric("M016"),8);
        expect(metric("M061")).toBeCloseTo(metric("M059") / metric("M016"),8);
      }
      for (const row of changed) DETAIL_COLUMNS.forEach((c,i) => {
        const value=row.values[i].current; if(value===null)return;
        if(c.kind==="count")expect(Number.isInteger(value)).toBe(true);
        if(c.kind==="ratio"){expect(value).toBeGreaterThanOrEqual(0);expect(value).toBeLessThanOrEqual(1);}
      });
      expect(operatingSummaryModels(changed,"all",day).find(m=>m.metric.id==="M020")!.result.status).toBe("available");
    }
  });
  test("原始日报 A:BJ 全量可追溯，58业务字段各出现一次，保留15额外列", () => {
    const headers = "日活总计|MAU|Android日活|IOS日活|比例|新增总计|自然总新增|内部导量总新增|新增Android|新增IOS|比例|广告总点击人次|广告总人次比例|广告总点击人数|广告总点击人数比例|广告新增点击人次|广告新增人次比例|广告新增点击人数|广告新增点击人数比例|总拉单次数|总拉单人数|总充值成功次数|总成功率|支付宝拉单次数|支付宝拉单人数|支付宝充值成功次数|支付宝成功率|微信拉单次数|微信拉单人数|微信充值成功次数|微信成功率|总充值人数|总充值付费率|总充值金额|自然新增总充值|内部导量总充值|总充值ARPU|总充值ARPPU|新增充值人数|新增充值付费率|新增充值金额|新增充值ARPU|新增充值ARPPU|总观影人数|总观影率|新增观影人数|新增观影率|次留|次留登陆人数|3留|3留登陆人数|7留|7留登陆人数|访问|下载|访问-下载转化|下载-注册转化|访问-注册转化".split("|");
    const letter = (n:number): string => n > 26 ? `${String.fromCharCode(64 + Math.floor((n-1)/26))}${String.fromCharCode(65+(n-1)%26)}` : String.fromCharCode(64+n);
    headers.forEach((name, i) => {
      const matches = DETAIL_COLUMNS.filter(c => c.sourceColumn === letter(i+5));
      expect(matches).toHaveLength(1); expect(matches[0].sourceLabel).toBe(name);
    });
    expect(DETAIL_COLUMNS.filter(c=>!c.sourceColumn)).toHaveLength(15);
    expect(operatingColumnDocumentation()).toHaveLength(78);
    expect(operatingSummaryModels(rows,"all",date).map(m=>m.metric.id)).toEqual(OPERATING_SUMMARY_IDS);
  });
  test("次数获客、广告人均与拉单口径精确绑定，不用提交或到账替代", () => {
    const field = (letter:string) => DETAIL_COLUMNS.find(c=>c.sourceColumn===letter)!;
    for (const [letter,id,unit] of [["BF","M001","次"],["BG","M003","次"],["BH","M005","%"],["Q","M110","次/人"],["X","M112","次"],["Y","M113","人"],["Z","M060","单"],["AA","M114","%"],["AP","M067","USD/人"]]) {
      expect(field(letter).metric.id).toBe(id); expect(field(letter).unit).toBe(unit);
    }
    for (const row of rows) DETAIL_COLUMNS.forEach((c,i)=>{ if(c.pendingReason) expect(row.values[i].current).toBeNull(); });
    for(const c of DETAIL_COLUMNS.filter(c=>c.periodDays)) expect(c.slice).not.toBe("老用户");
  });
  test("自然月和 D1/D3/D7 日期及未成熟状态随数据日更新", () => {
    const historical=operatingDetailRows("2026-09-07");
    for (const days of [1,3,7]) {
      const i=DETAIL_COLUMNS.findIndex(c=>c.metric.id==="M115" && c.periodDays===days);
      expect(retentionTargetDate(DETAIL_COLUMNS[i],"2026-09-07")).toBe(`2026-09-${String(7+days).padStart(2,"0")}`);
      expect(historical[0].values[i].state).toBe(days===1?"unsupported":"immature");
    }
    const output=operatingDetailExportRows(operatingDetailRows("2026-08-31"),"2026-08-31");
    expect(output[1][output[0].indexOf("MAU｜自然月")]).toBe("2026-08");
    expect(output[1][output[0].indexOf("MAU｜数据截至日")]).toBeNull();
  });
});
