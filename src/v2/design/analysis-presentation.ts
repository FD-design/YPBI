import type { AnalysisResult } from "./personal-query-preview";

export function resultPresentation(result: AnalysisResult) {
  const { config } = result;
  const cross = !!config.secondaryGroup && config.secondaryGroup !== "none";
  const grouped = config.group !== "none";
  const item = config.items.find(item => item.key === config.mainItem) ?? config.items[0];
  const current = result.series.filter(series => !series.previous && (!series.itemKey || series.itemKey === item?.key));
  const ranked = [...current].sort((a, b) => (b.summaryRaw ?? -Infinity) - (a.summaryRaw ?? -Infinity) || a.key.localeCompare(b.key));
  // Single-valued event properties partition event records, not cross-platform people.
  const additive = config.kind === "events" && (item?.measure === "count" || item?.measure === "property" && item.aggregation === "sum");
  const pie = grouped && !cross && additive && current.length > 1 && current.length <= 8 && current.every(s => s.summaryRaw !== null && s.summaryRaw >= 0) && current.reduce((sum, s) => sum + (s.summaryRaw ?? 0), 0) > 0;
  return { cross, grouped, item, current, ranked, pie, pieReason: pie ? "分类互斥、全量分类、同一整体" : "饼图需单一互斥分组、可加总数值、完整分类且最多8类；人数去重和比例不作为构成。" };
}
