import { rangeError, type DateRangeValue } from "../../components/ui/date-range-model";

export interface PreviewQuery { range: DateRangeValue; compared: boolean; scope: "official_overall" }
export const DEFAULT_PREVIEW_QUERY: PreviewQuery = { range: { start: "2026-09-02", end: "2026-09-08" }, compared: false, scope: "official_overall" };
export const PREVIEW_QUERY_KEY = "ypbi.development-preview.query.v1";
let sessionQuery: PreviewQuery | null = null;
export function parsePreviewQuery(value: unknown): PreviewQuery | null {
  if (!value || typeof value !== "object") return null;
  const item = value as PreviewQuery;
  if (Object.keys(item).sort().join() !== "compared,range,scope" || item.scope !== "official_overall" || typeof item.compared !== "boolean"
    || !item.range || Object.keys(item.range).sort().join() !== "end,start" || typeof item.range.start !== "string" || typeof item.range.end !== "string"
    || rangeError(item.range, { today: "2026-09-10", maxDate: "2026-09-08", maxDays: 366 })) return null;
  return { range: { ...item.range }, compared: item.compared, scope: "official_overall" };
}
export function readPreviewQuery(): PreviewQuery {
  if (typeof window === "undefined") return structuredClone(DEFAULT_PREVIEW_QUERY);
  const historical = parsePreviewQuery(window.history.state?.[PREVIEW_QUERY_KEY]);
  if (historical) return historical;
  if (sessionQuery) return structuredClone(sessionQuery);
  try { return parsePreviewQuery(JSON.parse(sessionStorage.getItem(PREVIEW_QUERY_KEY) ?? "null")) ?? structuredClone(DEFAULT_PREVIEW_QUERY); }
  catch { return structuredClone(DEFAULT_PREVIEW_QUERY); }
}
export function savePreviewQuery(range: DateRangeValue, compared: boolean) {
  const value = parsePreviewQuery({ range: { start: range.start, end: range.end }, compared, scope: "official_overall" });
  if (!value) return;
  sessionQuery = value;
  window.history.replaceState({ ...window.history.state, [PREVIEW_QUERY_KEY]: value }, "");
  try { sessionStorage.setItem(PREVIEW_QUERY_KEY, JSON.stringify(value)); } catch { /* This tab retains applied state in memory and history. */ }
}
