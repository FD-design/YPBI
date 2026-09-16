import { shiftDate, type DateRangeValue } from "../../components/ui/date-range-model";
import type { CalculationBasis } from "../features/dashboards/CalculationEvidence";
import { acquisitionBaseline, acquisitionDates, acquisitionMetric, acquisitionRangeLabel, acquisitionRows, fixtureSupports, type AcquisitionFilters } from "./acquisition-preview-model";
import type { WorkbookCell, WorkbookSheet } from "./preview-workbook";

export const CHANNEL_QUALITY_GROUPS = [
  { value: "scale", label: "规模与转化", ids: ["M008", "M001", "M003", "M005", "M006", "M007", "M099"], scope: "行为发生日与注册业务日分别统计；注册转化是 IP·天趋势参考，不是同用户漏斗。" },
  { value: "experience", label: "首次体验", ids: ["M033", "M037", "M038"], scope: "同一渠道、同一注册批次的首次体验；仅汇总观察窗口已结束的批次。" },
  { value: "retention", label: "注册留存", ids: ["M020", "M021", "M022", "M023"], scope: "同一注册批次的次日、第 3 / 7 / 30 天登录留存；各列仅汇总已成熟批次。" },
  { value: "value", label: "付费价值", ids: ["M059", "M064", "M058", "M088", "M067"], scope: "同一注册批次的注册当日充值表现；金额为 USD，不表示累计 LTV。" }
] as const;
export type ChannelQualityGroup = typeof CHANNEL_QUALITY_GROUPS[number]["value"];
export const CHANNEL_QUALITY_IDS: readonly string[] = CHANNEL_QUALITY_GROUPS.flatMap(group => [...group.ids]);
export const CHANNEL_QUALITY_WATERMARK = "2026-09-08";
export const channelQualityGroup = (value: string = "scale") => CHANNEL_QUALITY_GROUPS.find(group => group.value === value) ?? CHANNEL_QUALITY_GROUPS[0];
export const channelQualityUnit = (id: string) => ["M001", "M003"].includes(id) ? "次" : ["M008", "M038", "M059"].includes(id) ? "人" : id === "M058" ? "USD" : ["M067", "M088"].includes(id) ? "USD/人" : "%";
export function channelQualityValue(id: string, value: number | null) {
  if (value === null) return "—";
  const unit = channelQualityUnit(id);
  return unit === "%" ? `${(value * 100).toFixed(2)}%` : `${value.toLocaleString("zh-CN", { maximumFractionDigits: unit.startsWith("USD") ? 2 : 0 })} ${unit}`;
}

/** Isolated development observations. No live query, upstream field or credential enters this model. */
export interface ChannelQualityFact {
  date: string; channel: string; registered: number; visits: number; clicks: number;
  visitIp: readonly [number, number]; downloadIp: readonly [number, number]; distinctIpComplete: boolean;
  experienceClosed: boolean; launchUsers: number; pageUsers: number; effectiveUsers: number | null; secondUsers: number;
  retained: Record<number, number | null>; paidUsers: number; amountCents: number; currency: "USD";
}
export function channelQualityFixtures(range: DateRangeValue, mixed = false): ChannelQualityFact[] {
  return acquisitionDates(range).flatMap(date => {
    const day = Math.floor(Date.parse(date) / 86400000);
    return acquisitionRows("channel", { start: date, end: date }).map((row, index) => {
      const registered = row.values.M008!, visits = row.values.M001!, clicks = row.values.M003!;
      const launchUsers = Math.floor(registered * (.89 - index * .024));
      const pageUsers = Math.floor(launchUsers * (.82 + ((day + index) % 5) * .022));
      const effectiveUsers = Math.floor(pageUsers * (.71 - index * .018));
      const visitIpCount = Math.floor(visits * (.48 + index * .016));
      const downloadIpCount = Math.min(visitIpCount, Math.floor(clicks * (.68 + index * .012)));
      const ipStart = ((day % 7) + 7) % 7 * 450;
      const paidUsers = Math.floor(registered * (.055 + ((day + index) % 6) * .006));
      return { date, channel: row.name, registered, visits, clicks,
        visitIp: [ipStart, ipStart + visitIpCount], downloadIp: [ipStart, ipStart + downloadIpCount], distinctIpComplete: !(mixed && index === 4 && date === range.start),
        experienceClosed: date < CHANNEL_QUALITY_WATERMARK, launchUsers, pageUsers,
        effectiveUsers: mixed && index === 4 && date === range.start ? null : effectiveUsers,
        secondUsers: Math.floor(effectiveUsers * .53),
        retained: Object.fromEntries([1, 3, 7, 30].map(lag => [lag, Math.floor(registered * Math.max(.08, .44 - lag * .006 - index * .025 + (day % 4) * .009))])),
        paidUsers, amountCents: paidUsers * (1780 + index * 290 + day % 5 * 105), currency: "USD" as const };
    });
  });
}
const total = (rows: ChannelQualityFact[], read: (row: ChannelQualityFact) => number) => rows.reduce((sum, row) => sum + read(row), 0);
/** Union of synthetic IP membership intervals, not a sum of daily distinct counts. */
export function distinctChannelIps(intervals: readonly (readonly [number, number])[]) {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let result = 0, end = -Infinity;
  for (const [start, stop] of sorted) { result += Math.max(0, stop - Math.max(start, end)); end = Math.max(end, stop); }
  return result;
}
const retentionLag: Record<string, number> = { M020: 1, M021: 3, M022: 7, M023: 30 };
export interface ChannelQualityReading {
  value: number | null; status: "完整" | "部分" | "未成熟" | "缺失" | "分母为0";
  scope: string; mature: number; batches: number; basis?: CalculationBasis;
}
export function readChannelQuality(id: string, facts: ChannelQualityFact[], watermark = CHANNEL_QUALITY_WATERMARK): ChannelQualityReading {
  const lag = retentionLag[id], first = ["M033", "M037", "M038"].includes(id);
  const eligible = facts.filter(row => lag ? shiftDate(row.date, lag) <= watermark : first ? row.experienceClosed : row.date <= watermark);
  const dates = facts.length ? `${facts[0].date} 至 ${facts.at(-1)!.date}` : "无日期";
  const scope = `${facts[0]?.channel ?? "渠道"} · ${dates} · ${channelQualityGroup(CHANNEL_QUALITY_GROUPS.find(group => (group.ids as readonly string[]).includes(id))?.value).label} · 成熟 ${eligible.length}/${facts.length} 批 · 演示数据${channelQualityUnit(id).startsWith("USD") ? " · USD" : ""}`;
  const base = { scope, mature: eligible.length, batches: facts.length };
  if (!eligible.length) return { ...base, value: null, status: facts.length ? "未成熟" : "缺失" };
  const incomplete = eligible.length < facts.length;
  let numerator: number | null = null, denominator: number | undefined, numeratorName = "", denominatorName = "", numeratorUnit = "人", denominatorUnit = "人";
  switch (id) {
    case "M008": numerator = total(eligible, row => row.registered); break;
    case "M001": numerator = total(eligible, row => row.visits); break;
    case "M003": numerator = total(eligible, row => row.clicks); break;
    case "M005": numerator = total(eligible, row => row.clicks); denominator = total(eligible, row => row.visits); numeratorName = "落地页下载点击次数"; denominatorName = "落地页访问次数"; numeratorUnit = denominatorUnit = "次"; break;
    case "M006": case "M007": numerator = total(eligible, row => row.registered); denominator = total(eligible, row => { const interval = id === "M006" ? row.downloadIp : row.visitIp; return interval[1] - interval[0]; }); numeratorName = "注册用户数（区间排重）"; denominatorName = id === "M006" ? "下载 IP·天合计" : "落地页访问 IP·天合计"; denominatorUnit = "IP·天"; break;
    case "M099": numerator = eligible.some(row => !row.distinctIpComplete) ? null : distinctChannelIps(eligible.map(row => row.downloadIp)); denominator = distinctChannelIps(eligible.map(row => row.visitIp)); numeratorName = "区间去重下载 IP 数"; denominatorName = "区间去重访问 IP 数"; numeratorUnit = denominatorUnit = "IP"; break;
    case "M033": numerator = total(eligible, row => row.pageUsers); denominator = total(eligible, row => row.launchUsers); numeratorName = "首次体验到达视频页用户数"; denominatorName = "首次体验启动成功用户数"; break;
    case "M037": numerator = eligible.some(row => row.effectiveUsers === null) ? null : total(eligible, row => row.effectiveUsers!); denominator = total(eligible, row => row.registered); numeratorName = "新增用户有效观影人数"; denominatorName = "新增用户数"; break;
    case "M038": numerator = total(eligible, row => row.secondUsers); break;
    case "M020": case "M021": case "M022": case "M023": numerator = eligible.some(row => row.retained[lag] == null) ? null : total(eligible, row => row.retained[lag]!); denominator = total(eligible, row => row.registered); numeratorName = `${lag === 1 ? "次日" : `第 ${lag} 天`}登录的注册用户数`; denominatorName = "已成熟注册用户数"; break;
    case "M059": numerator = total(eligible, row => row.paidUsers); break;
    case "M058": numerator = total(eligible, row => row.amountCents) / 100; break;
    case "M064": numerator = total(eligible, row => row.paidUsers); denominator = total(eligible, row => row.registered); numeratorName = "新增付费用户数"; denominatorName = "新增用户数"; break;
    case "M088": case "M067": numerator = total(eligible, row => row.amountCents) / 100; denominator = total(eligible, row => id === "M088" ? row.registered : row.paidUsers); numeratorName = "注册当日充值金额"; denominatorName = id === "M088" ? "新增用户数" : "注册当日付费用户数"; numeratorUnit = "USD"; break;
    default: throw new Error(`Unsupported channel quality metric ${id}`);
  }
  const value = numerator === null || denominator === 0 ? null : denominator === undefined ? numerator : numerator / denominator;
  return { ...base, value, status: numerator === null ? "缺失" : denominator === 0 ? "分母为0" : incomplete ? "部分" : "完整",
    ...(denominator === undefined ? {} : { basis: { formula: acquisitionMetric(id).definition, scope, numerator: { name: numeratorName, value: numerator, unit: numeratorUnit }, denominator: { name: denominatorName, value: denominator, unit: denominatorUnit }, percentage: channelQualityUnit(id) === "%", result: value === null ? denominator === 0 ? "分母为0" : "缺失" : channelQualityValue(id, value) } }) };
}
export interface ChannelQualityRow { name: string; facts: ChannelQualityFact[]; previousFacts: ChannelQualityFact[]; metrics: Record<string, { current: ChannelQualityReading; previous?: ChannelQualityReading }> }
export function channelQualityRows(filters: AcquisitionFilters, mixed = false): ChannelQualityRow[] {
  if (!fixtureSupports(filters)) throw new Error("当前条件没有渠道质量演示结果");
  const facts = channelQualityFixtures(filters, mixed), previous = channelQualityFixtures(acquisitionBaseline(filters));
  return [...new Set(facts.map(row => row.channel))].map(name => {
    const own = facts.filter(row => row.channel === name), prior = previous.filter(row => row.channel === name);
    return { name, facts: own, previousFacts: prior, metrics: Object.fromEntries(CHANNEL_QUALITY_IDS.map(id => {
      const current = readChannelQuality(id, own);
      // The comparison uses the same observable cohort positions; a full prior period is not compared to a partial current one.
      const paired = prior.filter((_, index) => { const row = own[index]; return retentionLag[id] ? shiftDate(row.date, retentionLag[id]) <= CHANNEL_QUALITY_WATERMARK : ["M033", "M037", "M038"].includes(id) ? row.experienceClosed : true; });
      return [id, { current, ...(filters.comparison === "none" ? {} : { previous: readChannelQuality(id, paired) }) }];
    })) };
  });
}
export function channelQualityChange(id: string, current: number | null, previous: number | null | undefined) {
  if (current === null || previous == null || channelQualityUnit(id) !== "%" && previous === 0) return null;
  const change = channelQualityUnit(id) === "%" ? (current - previous) * 100 : (current - previous) / previous * 100;
  return { value: change, label: `${change > 0 ? "+" : ""}${change.toFixed(2)}${channelQualityUnit(id) === "%" ? " 个百分点" : "%"}` };
}
export function filterChannelQualityRows(rows: ChannelQualityRow[], search: string, id: string, descending: boolean) {
  return rows.filter(row => row.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).sort((a, b) => {
    const av = a.metrics[id]?.current.value ?? null, bv = b.metrics[id]?.current.value ?? null;
    if (av === null) return bv === null ? a.name.localeCompare(b.name, "zh-CN") : 1;
    if (bv === null) return -1;
    return (av - bv) * (descending ? -1 : 1) || a.name.localeCompare(b.name, "zh-CN");
  });
}
export function channelQualitySheets(filters: AcquisitionFilters, mixed = false): WorkbookSheet[] {
  const rows = channelQualityRows(filters, mixed), compared = filters.comparison !== "none";
  const headers: WorkbookCell[] = ["渠道", "指标组", "指标", "当前值", "单位", "对比值", "差值", "变化（%或百分点）", "当前状态", "对比状态", "当前成熟批次", "当前全部批次", "当前分子名称", "当前分子值", "当前分母名称", "当前分母值", "对比分子名称", "对比分子值", "对比分母名称", "对比分母值", "当前范围", "对比范围", "数据来源"];
  const summary: WorkbookCell[][] = [headers];
  for (const row of rows) for (const group of CHANNEL_QUALITY_GROUPS) for (const id of group.ids) {
    const { current, previous } = row.metrics[id], scale = channelQualityUnit(id) === "%" ? 100 : 1;
    summary.push([row.name, group.label, acquisitionMetric(id).name, current.value === null ? null : current.value * scale, channelQualityUnit(id), previous?.value == null ? null : previous.value * scale, current.value !== null && previous?.value != null ? (current.value - previous.value) * scale : null, channelQualityChange(id, current.value, previous?.value)?.value ?? null, current.status, previous?.status ?? "不对比", current.mature, current.batches, current.basis?.numerator.name ?? null, current.basis?.numerator.value ?? null, current.basis?.denominator.name ?? null, current.basis?.denominator.value ?? null, previous?.basis?.numerator.name ?? null, previous?.basis?.numerator.value ?? null, previous?.basis?.denominator.name ?? null, previous?.basis?.denominator.value ?? null, current.scope, previous?.scope ?? null, "演示数据"]);
  }
  const daily: WorkbookCell[][] = [["渠道", "周期", "业务/注册日期", "指标组", "指标", "结果", "单位", "状态", "分子指标", "分子值", "分子单位", "分母指标", "分母值", "分母单位", "观察截止日", "数据来源"]];
  for (const row of rows) for (const period of [{ label: "当前", facts: row.facts }, ...(compared ? [{ label: "对比", facts: row.previousFacts }] : [])]) for (const fact of period.facts) for (const group of CHANNEL_QUALITY_GROUPS) for (const id of group.ids) {
    const reading = readChannelQuality(id, [fact]);
    daily.push([row.name, period.label, fact.date, group.label, acquisitionMetric(id).name, reading.value === null ? null : reading.value * (channelQualityUnit(id) === "%" ? 100 : 1), channelQualityUnit(id), reading.status, reading.basis?.numerator.name ?? null, reading.basis?.numerator.value ?? null, reading.basis?.numerator.unit ?? null, reading.basis?.denominator.name ?? null, reading.basis?.denominator.value ?? null, reading.basis?.denominator.unit ?? null, CHANNEL_QUALITY_WATERMARK, "演示数据"]);
  }
  return [{ name: "03_增长效果_来源渠道", rows: summary }, { name: "08_渠道质量逐日依据", rows: daily }, { name: "09_渠道质量口径", rows: [["指标组", "指标", "定义", "适用范围"], ...CHANNEL_QUALITY_GROUPS.flatMap(group => group.ids.map(id => [group.label, acquisitionMetric(id).name, acquisitionMetric(id).definition, group.scope])), ["数据来源", "全部渠道质量", "独立合成观察事实，未接入真实渠道用户关联", `${acquisitionRangeLabel(filters)}；数据至 ${CHANNEL_QUALITY_WATERMARK}`], ["比较", "成熟批次", "当前/对比按相同可观察注册批次位置比较；未成熟与缺失不补0", "首次体验、注册留存、价值分别沿用各自窗口；付费价值仅注册当日 USD"]] }];
}
