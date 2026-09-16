import { coreOverviewDesignMetricAuthority } from "./core-overview-contract-fixture";
import type { DetailValueKind } from "./operating-detail-presentation";

export interface DetailColumn {
  metric: ReturnType<typeof coreOverviewDesignMetricAuthority>;
  kind: DetailValueKind;
  unit: string;
  group: string;
  slice?: string;
  periodDays?: number;
  sourceColumn?: string;
  sourceLabel?: string;
  pendingReason?: string;
  displayOnly?: boolean;
}

const existing = new Set(["M016", "M008", "M026", "M102", "M059", "M058", "M081", "M036", "M020", "M061", "M090"]);
const units: Record<string, [DetailValueKind, string]> = {
  M102: ["duration", "小时"], M058: ["currency", "USD"],
  M067: ["currency", "USD/人"], M087: ["currency", "USD/人"], M088: ["currency", "USD/人"],
  M110: ["average", "次/人"], M055: ["events", "次"], M112: ["events", "次"],
  M060: ["events", "单"], M001: ["events", "次"], M003: ["events", "次"]
};
const ratios = new Set(["M081", "M036", "M020", "M021", "M022", "M061", "M064", "M090", "M111", "M114", "M005", "M006", "M007"]);
export function operatingPendingReason(id: string, slice?: string) {
  if (id === "M016" && ["Android", "iOS"].includes(slice ?? "")) return "旧接口已有端别日活候选字段；该看板尚未接入并完成同日、同PID验数。";
  if (["M020", "M021", "M022", "M115"].includes(id)) return "需要对应注册批次、目标日返访人数和成熟状态；当前看板尚无已验证返回。";
  if (id === "M008") return "需要按注册事实去重及注册时归因的新增人数；不使用端登录人数相减替代。";
  if (["M060", "M114"].includes(id)) return "需要核对支付成功终点、同一订单关系和观察窗口；不使用到账或支付提交指标替代。";
  if (id === "M018") return "按自然月去重并保留数据截至日；当前看板尚未接入已验证的月活结果。";
  return "指标及分析范围已登记，当前看板尚未接入同日、同PID、同一人群的已验证结果。";
}

function metric(group: string, id: string, sourceColumn?: string, sourceLabel?: string, slice?: string, periodDays?: number): DetailColumn {
  const authority = coreOverviewDesignMetricAuthority(id);
  const [kind, unit] = ratios.has(id) ? ["ratio" as const, "%"] : units[id] ?? ["count", "人"];
  const suffix = slice ?? (id === "M115" ? `D${periodDays}` : undefined);
  return { metric: { ...authority, name: `${authority.name}${suffix ? `（${suffix}）` : ""}`, definition: `${authority.definition}${suffix ? ` 本列范围：${suffix}，沿用该指标对应人群和日期口径。` : ""}${sourceLabel ? ` 日报对应字段：${sourceLabel}。` : ""}` }, kind, unit, group, sourceColumn, sourceLabel, slice, periodDays,
    pendingReason: slice || !existing.has(id) ? operatingPendingReason(id, slice) : undefined };
}
function platformRatio(id: "M016" | "M008", sourceColumn: string): DetailColumn {
  const name = id === "M016" ? "日活Android:iOS比值" : "新增Android:iOS比值";
  return { metric: { id: `display:${id}`, name, definition: "Android与iOS同范围数值的展示比值，不是独立指标；缺少任一端结果不计算，iOS为0时显示无可比数据。" },
    kind: "platformRatio", unit: "Android:iOS", group: "活跃增长", sourceColumn, sourceLabel: "比例", displayOnly: true,
    pendingReason: "需要两个客户端的同口径已验证结果；不从整体人数推算端别。" };
}

// This registry is the only projection of the approved report fields, not a metric or query registry.
export const DETAIL_COLUMNS: DetailColumn[] = [
  metric("活跃增长","M016","E","日活总计"), metric("活跃增长","M016","G","Android日活","Android"), metric("活跃增长","M016","H","IOS日活","iOS"),
  metric("活跃增长","M016",undefined,undefined,"新用户"), metric("活跃增长","M016",undefined,undefined,"老用户"), platformRatio("M016","I"), metric("活跃增长","M018","F","MAU"),
  metric("活跃增长","M008","J","新增总计"), metric("活跃增长","M008","M","新增Android","Android"), metric("活跃增长","M008","N","新增IOS","iOS"),
  metric("活跃增长","M008","K","自然总新增","自然新增"), metric("活跃增长","M008","L","内部导量总新增","内部导量"), platformRatio("M008","O"),
  metric("观影留存","M026","AV","总观影人数"), metric("观影留存","M026",undefined,undefined,"Android"), metric("观影留存","M026",undefined,undefined,"iOS"),
  metric("观影留存","M026","AX","新增观影人数","新用户"), metric("观影留存","M026",undefined,undefined,"老用户"), metric("观影留存","M102"),
  metric("观影留存","M081","AW","总观影率"), metric("观影留存","M081",undefined,undefined,"Android"), metric("观影留存","M081",undefined,undefined,"iOS"),
  metric("观影留存","M081","AY","新增观影率","新用户"), metric("观影留存","M081",undefined,undefined,"老用户"), metric("观影留存","M036"),
  metric("观影留存","M020","AZ","次留",undefined,1), metric("观影留存","M020",undefined,undefined,"Android",1), metric("观影留存","M020",undefined,undefined,"iOS",1),
  metric("观影留存","M020",undefined,undefined,"自然新增",1), metric("观影留存","M020",undefined,undefined,"内部导量",1), metric("观影留存","M115","BA","次留登陆人数",undefined,1),
  metric("观影留存","M021","BB","3留",undefined,3), metric("观影留存","M115","BC","3留登陆人数",undefined,3),
  metric("观影留存","M022","BD","7留",undefined,7), metric("观影留存","M115","BE","7留登陆人数",undefined,7),
  metric("广告","M055","P","广告总点击人次"), metric("广告","M055","T","广告新增点击人次","新用户"),
  metric("广告","M110","Q","广告总人次比例"), metric("广告","M110","U","广告新增人次比例","新用户"),
  metric("广告","M094","R","广告总点击人数"), metric("广告","M094","V","广告新增点击人数","新用户"),
  metric("广告","M111","S","广告总点击人数比例"), metric("广告","M111","W","广告新增点击人数比例","新用户"),
  metric("付费价值","M058","AL","总充值金额"), metric("付费价值","M058","AS","新增充值金额","新用户"),
  metric("付费价值","M058","AM","自然新增总充值","自然新增"), metric("付费价值","M058","AN","内部导量总充值","内部导量"),
  metric("付费价值","M059","AJ","总充值人数"), metric("付费价值","M059","AQ","新增充值人数","新用户"),
  metric("付费价值","M061","AK","总充值付费率"), metric("付费价值","M064","AR","新增充值付费率"),
  metric("付费价值","M087","AO","总充值ARPU"), metric("付费价值","M088","AT","新增充值ARPU"),
  metric("付费价值","M067","AP","总充值ARPPU"), metric("付费价值","M067","AU","新增充值ARPPU","新用户"),
  ...([ ["M112","X","总拉单次数","AB","支付宝拉单次数","AF","微信拉单次数"],
    ["M113","Y","总拉单人数","AC","支付宝拉单人数","AG","微信拉单人数"],
    ["M060","Z","总充值成功次数","AD","支付宝充值成功次数","AH","微信充值成功次数"],
    ["M114","AA","总成功率","AE","支付宝成功率","AI","微信成功率"] ] as const).flatMap(([id,c,n,a,an,w,wn])=>[
      metric("支付链路",id,c,n),metric("支付链路",id,a,an,"支付宝"),metric("支付链路",id,w,wn,"微信")]),
  metric("支付链路","M090"),
  metric("获客","M001","BF","访问"), metric("获客","M003","BG","下载"), metric("获客","M005","BH","访问-下载转化"),
  metric("获客","M006","BI","下载-注册转化"), metric("获客","M007","BJ","访问-注册转化")
];
export const OPERATING_SUMMARY_IDS = ["M016", "M008", "M026", "M058", "M081", "M020", "M059", "M061", "M067", "M111"];
export function detailColumnKey(column: DetailColumn) { return `${column.metric.id}:${column.slice ?? "overall"}${column.metric.id === "M115" ? `:D${column.periodDays}` : ""}`; }
export function summaryColumn(id: string) { return DETAIL_COLUMNS.find(c=>c.metric.id===id && !c.slice)!; }
export function breakdownColumn(id: string, slice: string) { return id === "M061" && slice === "新用户" ? summaryColumn("M064") : DETAIL_COLUMNS.find(c=>c.metric.id===id && c.slice===slice); }

export function operatingColumnDocumentation() {
  return [["日报列","日报原名","展示列","指标ID","拆分/周期","单位","定义","数据接入说明"],
    ["A","统计日期","数据日","维度","","日期","按本区快照数据日读取；留存为注册日，月活为所属自然月","随已应用查询结束日变化"],
    ["B","平台","业务平台 / PID","维度","","","沿用稳定业务平台标识","当前为开发环境平台样例"],
    ["C","模式","模式","维度","","","保留上游映射后的业务模式","枚举与接口未验证，留空并保留状态"],
    ["D","推广状态","推广状态","维度","","","保留上游映射后的推广状态","枚举与接口未验证，留空并保留状态"],
    ...DETAIL_COLUMNS.map(c=>[c.sourceColumn??"",c.sourceLabel??"",c.metric.name,c.displayOnly?"展示计算":c.metric.id,c.slice??(c.periodDays?`D${c.periodDays}`:"整体"),c.unit,c.metric.definition,c.pendingReason??"开发环境固定样例；正式数据独立验数"] )];
}
