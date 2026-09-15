import { FUNNEL_SAMPLE_EVENTS } from "./analysis-sample-capabilities";
import catalog from "./generated/event-catalog-preview.json";
import pages from "./generated/function-catalog-preview.json";
import { shiftDate } from "../../components/ui/date-range-model";
import type { AnalysisConfig, AnalysisFilter, AnalysisItem, FilterOperator } from "./personal-workspace-model";
import type { AnalysisSeries } from "./personal-query-preview";

// Isolated DEV capability declaration. Labels and types always come from the authority projection.
export const SAMPLE_EVENTS = new Set(["app_launch", "page_view", "page_stay", "search_query_submit", ...FUNNEL_SAMPLE_EVENTS]);
const common = ["platform", "network", "is_login", "source_channel"];
const extra: Record<string, string[]> = { page_view: ["page_name"], page_stay: ["page_name", "stay_duration_ms", "exit_reason"], search_query_submit: ["keyword_source_type", "search_scope", "keyword_id"] };
export const numericField = (field: { type: string }) => ["integer", "decimal", "number"].includes(field.type);
export function eventFields(id: string) {
  const available = [...common, ...(extra[id] ?? [])];
  return SAMPLE_EVENTS.has(id) ? (catalog.items.find(item => item.id === id)?.fields ?? []).filter(field => available.includes(field.id)) : [];
}
export function commonFields(config: AnalysisConfig) {
  if (config.kind === "metrics" || config.items.some(item => !item.ref)) return [];
  return eventFields(config.items[0].ref).filter(field => config.items.every(item => eventFields(item.ref).some(candidate => candidate.id === field.id && candidate.type === field.type)));
}
export const groupFields = (config: AnalysisConfig) => commonFields(config).filter(field => !numericField(field));
export function fieldOptions(id: string, fieldId: string) {
  const field = eventFields(id).find(f => f.id === fieldId);
  if (field?.enums.length) return field.enums.map(v => ({ value: v.value, label: v.label }));
  if (field?.type === "boolean") return [{ value: "true", label: "是" }, { value: "false", label: "否" }];
  if (fieldId === "page_name") return pages.items.slice(0, 8).map(page => ({ value: page.id, label: page.name }));
  if (fieldId === "source_channel") return [1, 2, 3].map(n => ({ value: `sample_channel_${n}`, label: `示例渠道 ${n}` }));
  if (fieldId === "keyword_id") return Array.from({ length: 24 }, (_, n) => ({ value: `sample_keyword_${n + 1}`, label: `示例关键词 ${n + 1}` }));
  return [];
}
export function fieldLabel(id: string, field: string, value?: unknown) {
  const definition = eventFields(id).find(f => f.id === field);
  return value === undefined ? definition?.name ?? field : value === null ? "无值" : fieldOptions(id, field).find(option => option.value === String(value))?.label ?? String(value);
}
export const operators = (type: string): { value: FilterOperator; label: string }[] => {
  const set: { value: FilterOperator; label: string }[] = [{ value: "in", label: "等于 / 属于" }, { value: "not_in", label: "不等于 / 不属于" }];
  if (["integer", "decimal", "number"].includes(type)) set.push({ value: "gt", label: "大于" }, { value: "gte", label: "大于等于" }, { value: "lt", label: "小于" }, { value: "lte", label: "小于等于" }, { value: "between", label: "介于" });
  else if (type !== "boolean") set.push({ value: "contains", label: "包含" }, { value: "not_contains", label: "不包含" });
  return [...set, { value: "exists", label: "有值" }, { value: "missing", label: "无值" }];
};
export function filterIssue(filters: AnalysisFilter[], fields: ReturnType<typeof eventFields>) {
  for (const filter of filters) {
    const field = fields.find(f => f.id === filter.field);
    if (!field) return "存在未支持的筛选属性，请删除或重新选择。";
    if (!operators(field.type).some(op => op.value === filter.operator)) return `${field.name}不支持该操作符。`;
    if (["exists", "missing"].includes(filter.operator)) continue;
    if (!filter.values.length || filter.values.some(v => !v.trim())) return `${field.name}：请填写筛选值。`;
    if (numericField(field) && filter.values.some(v => !Number.isFinite(Number(v)))) return `${field.name}需要有效数字。`;
    if (["gt", "gte", "lt", "lte"].includes(filter.operator) && filter.values.length !== 1) return `${field.name}的大小比较只接受一个值。`;
    if (["in", "not_in"].includes(filter.operator) && field.enums.length && filter.values.some(v => !field.enums.some(e => e.value === v))) return `${field.name}存在失效枚举，请重新选择。`;
    if (field.type === "boolean" && filter.values.some(v => !["true", "false"].includes(v))) return `${field.name}需要是或否。`;
    if (filter.operator === "between" && (filter.values.length !== 2 || Number(filter.values[0]) > Number(filter.values[1]))) return "区间需要按从小到大填写两个值。";
  }
  return null;
}
export function eventConfigurationIssue(config: AnalysisConfig) {
  if ((config.filters?.length ?? 0) > 5) return "最多5条全局条件。";
  if (config.items.some(item => (item.filters?.length ?? 0) > 5)) return "每个分析项最多5条局部条件。";
  const dimensions = [config.group, config.secondaryGroup].filter((v): v is string => Boolean(v && v !== "none"));
  if (config.kind === "funnels" && dimensions.length > 1) return "漏斗最多支持一个分组维度。";
  if (new Set(dimensions).size !== dimensions.length) return "两个分组维度不能相同。";
  if (dimensions.some(id => !groupFields(config).some(field => field.id === id))) return "分组必须由全部分析项共同支持。";
  const globalIssue = filterIssue(config.filters ?? [], commonFields(config));
  if (globalIssue) return globalIssue;
  for (const item of config.items) {
    const issue = filterIssue(item.filters ?? [], eventFields(item.ref));
    if (issue) return issue;
    if (item.measure === "property" && (!item.aggregation || !eventFields(item.ref).some(field => field.id === item.property && numericField(field)))) return "请选择可用数值属性及聚合方式。";
  }
  return null;
}
export function retargetEventItem(item: AnalysisItem, ref: string, version: string) {
  const before = eventFields(item.ref), after = eventFields(ref);
  const removed = (item.filters ?? []).filter(filter => {
    const oldField = before.find(field => field.id === filter.field);
    return !after.some(field => field.id === filter.field && field.type === oldField?.type) || !!filterIssue([filter], after);
  });
  const propertyValid = !item.property || after.some(field => field.id === item.property && numericField(field));
  const next: AnalysisItem = { ...item, ref, version, filters: (item.filters ?? []).filter(filter => !removed.includes(filter)) };
  if (!propertyValid) { delete next.property; delete next.aggregation; if (next.measure === "property") next.measure = "count"; }
  return { next, removed: [...removed.map(filter => fieldLabel(item.ref, filter.field)), ...(!propertyValid ? [fieldLabel(item.ref, item.property!)] : [])] };
}
export function drillEventConfig(config: AnalysisConfig, values: Record<string, string | number | boolean | null>, field: string): AnalysisConfig {
  const existing = config.filters ?? [];
  for (const filter of existing) if (filter.field in values && !matchesFilter({ id: "", subject: "", date: "", timestamp: 0, values }, filter)) throw new Error("所选分组与已有筛选冲突，请先调整条件。");
  const fixed: AnalysisFilter[] = Object.entries(values).map(([id, value]) => ({ key: `drill:${id}`, field: id, operator: value === null ? "missing" : "in", values: value === null ? [] : [String(value)] }));
  const next = { ...structuredClone(config), group: field, secondaryGroup: "none", filters: [...existing.filter(filter => !(filter.field in values)), ...fixed] };
  const issue = eventConfigurationIssue(next);
  if (issue) throw new Error(issue);
  return next;
}
export interface SampleEventFact { id: string; subject: string; date: string; timestamp: number; values: Record<string, string | number | boolean | null> }
export function sampleEventFacts(event: string, start: string, end: string): SampleEventFact[] {
  const facts: SampleEventFact[] = [], count = Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
  for (let i = 0; i < count; i++) {
    const date = shiftDate(start, i), day = Math.floor(Date.parse(date) / 86400000);
    for (let user = 0; user < 48; user++) {
      if ((user + day) % 5 === 0) continue;
      const occurrences = (event === "page_view" || event === "page_stay" ? 3 : 1) + (user + day) % 3;
      for (let n = 0; n < occurrences; n++) {
        const choose = (field: string) => { const values = fieldOptions(event, field); return values.length ? values[(user + day + n) % values.length].value : null; };
        facts.push({ id: `${event}:${date}:${user}:${n}`, subject: `sample-person-${user}`, date, timestamp: Date.parse(`${date}T00:00:00+08:00`) + ((user * 7 + n * 3) % 24) * 3600000,
          values: { platform: ["android", "ios", "web"][user % 3], network: choose("network"), is_login: user % 7 !== 0, source_channel: user % 11 === 0 ? null : `sample_channel_${1 + user % 3}`, page_name: choose("page_name"), stay_duration_ms: (user + n + day) % 17 * 1500, exit_reason: choose("exit_reason"), keyword_source_type: choose("keyword_source_type"), search_scope: choose("search_scope"), keyword_id: choose("keyword_id") } });
      }
    }
  }
  return facts;
}
export function matchesFilter(fact: SampleEventFact, filter: AnalysisFilter) {
  const value = fact.values[filter.field], missing = value === null || value === undefined;
  if (filter.operator === "exists") return !missing;
  if (filter.operator === "missing") return missing;
  if (missing) return false;
  const text = String(value), n = Number(value), [a, b] = filter.values.map(Number);
  switch (filter.operator) {
    case "in": return filter.values.includes(text);
    case "not_in": return !filter.values.includes(text);
    case "contains": return filter.values.some(v => text.includes(v));
    case "not_contains": return filter.values.every(v => !text.includes(v));
    case "gt": return n > a; case "gte": return n >= a; case "lt": return n < a; case "lte": return n <= a; case "between": return n >= a && n <= b;
  }
}
export function aggregateFacts(facts: SampleEventFact[], item: AnalysisItem) {
  if (item.measure === "count") return facts.length;
  const users = new Set(facts.map(f => f.subject)).size;
  if (item.measure === "users") return users;
  if (item.measure === "average") return users ? facts.length / users : null;
  const values = facts.map(f => f.values[item.property!]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (!values.length) return null;
  switch (item.aggregation) { case "sum": return values.reduce((s, v) => s + v, 0); case "avg": return values.reduce((s, v) => s + v, 0) / values.length; case "min": return Math.min(...values); case "max": return Math.max(...values); default: return null; }
}
export const numberDisplay = (value: number | null) => value === null ? "—" : value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
export function bucketDate(date: string, grain: AnalysisConfig["grain"], hour = 0) {
  if (grain === "total") return "区间合计";
  if (grain === "month") return date.slice(0, 7);
  if (grain === "week") { const weekday = new Date(`${date}T00:00:00Z`).getUTCDay(); return shiftDate(date, -((weekday + 6) % 7)); }
  if (grain === "hour") return `${date} ${String(hour).padStart(2, "0")}:00`;
  return date;
}
export function eventItemSeries(config: AnalysisConfig, item: AnalysisItem): { series: AnalysisSeries[]; totals: AnalysisSeries[] } {
  const days = Math.round((Date.parse(config.range.end) - Date.parse(config.range.start)) / 86400000) + 1;
  const dimensions = [config.group, config.secondaryGroup].filter((v): v is string => Boolean(v && v !== "none"));
  const label = item.alias?.trim() || `${catalog.items.find(e => e.id === item.ref)?.name} · ${item.measure === "count" ? "总次数" : item.measure === "users" ? "触发用户数" : item.measure === "average" ? "人均触发次数" : `${fieldLabel(item.ref, item.property!)}${{sum:"求和",avg:"平均值",max:"最大值",min:"最小值"}[item.aggregation!]}`}`;
  const unit = item.measure === "count" ? "次" : item.measure === "users" ? "人" : item.measure === "average" ? "次/人" : "ms";
  const currentBuckets=[...new Set(Array.from({length:days},(_,i)=>Array.from({length:config.grain==="hour"?24:1},(_,hour)=>bucketDate(shiftDate(config.range.start,i),config.grain,hour))).flat())];
  const periods = (config.comparison ? [false, true] : [false]).map(previous => {
    const offset = previous ? -days : 0;
    const facts = sampleEventFacts(item.ref, shiftDate(config.range.start, offset), shiftDate(config.range.end, offset)).filter(fact => [...(config.filters ?? []), ...(item.filters ?? [])].every(filter => matchesFilter(fact, filter)));
    const groups = new Map<string, Record<string, string | number | boolean | null>>();
    for (const fact of facts) { const values = Object.fromEntries(dimensions.map(id => [id, fact.values[id] ?? null])); groups.set(JSON.stringify(values), values); }
    if (!dimensions.length) groups.set("{}", {});
    const buckets = [...new Set(Array.from({length: days}, (_, i) => Array.from({length: config.grain === "hour" ? 24 : 1}, (_, hour) => bucketDate(shiftDate(config.range.start, i + offset), config.grain, hour))).flat())];
    function series(values: Record<string, string | number | boolean | null>, suffix: string): AnalysisSeries {
      const subset = facts.filter(fact => Object.entries(values).every(([key, value]) => (fact.values[key] ?? null) === value));
      const raw = aggregateFacts(subset, item);
      const byBucket = new Map<string, SampleEventFact[]>();
      for (const fact of subset) { const key = bucketDate(fact.date, config.grain, new Date(fact.timestamp + 8 * 3600000).getUTCHours()); byBucket.set(key, [...(byBucket.get(key) ?? []), fact]); }
      return { key: `${item.key}:${JSON.stringify(values)}:${previous}:${suffix}`, itemKey: item.key, groupValues: values, name: `${label}${Object.entries(values).map(([id, value]) => ` · ${fieldLabel(item.ref,id,value)}`).join("")}${previous ? " · 对比期" : ""}`, unit, summary: numberDisplay(raw), summaryRaw: raw, note: "合成事件事实 · 区间独立计算 · 样例身份覆盖率100%", previous,
        points: buckets.map((date,index) => {
          const value = aggregateFacts(byBucket.get(date) ?? [], item);
          const included = Array.from({length:days},(_,i)=>shiftDate(config.range.start,i+offset)).filter(day => bucketDate(day,config.grain,Number(date.slice(11,13))||0)===date);
          const start=included[0],end=included.at(-1)!;
          const actualDate=config.grain==="hour"?start+date.slice(10):start===end?start:start+" 至 "+end;
          return {date:previous ? currentBuckets[index] ?? `对比期额外时段 ${index+1}` : date,actualDate,value,display:numberDisplay(value),state:value===null?"无有效样本":"合成样例"};
        }) };
    }
    return { series: [...groups.values()].map(values => series(values, "group")), total: series({}, "total") };
  });
  return { series: periods.flatMap(p => p.series), totals: periods.map(p => p.total) };
}
