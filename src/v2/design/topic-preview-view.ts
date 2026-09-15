import { preserveAuthenticatedReadingRoute } from "./reading-route";
import { rangeError, type DateRangeValue } from "../../components/ui/date-range-model.ts";
export interface TopicScope { client: "overall" | "android" | "ios" | "web"; audience: "overall" | "new" | "existing" }
export const DEFAULT_TOPIC_SCOPE: TopicScope = { client: "overall", audience: "overall" };
export interface TopicReading { dimension: string; structureId: string; rankingId: string; search: string; descending: boolean; retentionWindow?: 1 | 3 | 7; scope?: TopicScope }
export const DEFAULT_TOPIC_READING: TopicReading = { dimension: "platform", structureId: "M026", rankingId: "M101", search: "", descending: true };
export interface TopicView { v: 1; active: DateRangeValue; cohort: DateRangeValue; failure: DateRangeValue; compared: boolean; mixed: boolean; reading?: TopicReading }
const range = { start: "2026-09-02", end: "2026-09-08" };
export const DEFAULT_TOPIC_VIEW: TopicView = { v: 1, active: range, cohort: range, failure: range, compared: false, mixed: false };
export function parseTopicView(text: string, board?: string, live = false): TopicView | null {
  if (text.length > 1800) return null;
  try {
    const value = JSON.parse(text);
    if (value.v !== 1 || typeof value.compared !== "boolean" || typeof value.mixed !== "boolean") return null;
    for (const key of ["active", "cohort", "failure"]) if (!value[key] || typeof value[key].start !== "string" || typeof value[key].end !== "string" || rangeError(value[key], live ? {today:new Date(Date.now()+8*3600000).toISOString().slice(0,10),maxDate:new Date(Date.now()+8*3600000).toISOString().slice(0,10),maxDays:366} : { today: "2026-09-10", minDate: "2026-03-13", maxDate: "2026-09-08", maxDays: 180 })) return null;
    const d = value.reading;
    if (d?.scope && (!["overall", "android", "ios", "web"].includes(d.scope.client) || !["overall", "new", "existing"].includes(d.scope.audience))) return null;
    if (d?.retentionWindow !== undefined && (board === "5.8" || ![1, 3, 7].includes(d.retentionWindow))) return null;
    if (d && (!["platform", "users", "channel", "acquisition", "cross"].includes(d.dimension) || !["M016", "M026", "M101", "M102", "M098", "M081", "M036"].includes(d.structureId) || !["M101", "M097", "M102", "M034", "M036"].includes(d.rankingId) || typeof d.search !== "string" || d.search.length > 120 || typeof d.descending !== "boolean")) return null;
    if (d && board === "5.8" && (d.structureId !== "M016" || !["platform", "users", "cross"].includes(d.dimension))) return null;
    if (d && board === "5.9" && (!["M026", "M101", "M102", "M081", "M036"].includes(d.structureId) || !["platform", "users", "cross", "channel", "acquisition"].includes(d.dimension))) return null;
    return { v: 1, active: { start: value.active.start, end: value.active.end }, cohort: { start: value.cohort.start, end: value.cohort.end }, failure: { start: value.failure.start, end: value.failure.end }, compared: value.compared, mixed: value.mixed, ...(d ? { reading: { dimension: d.dimension, structureId: d.structureId, rankingId: d.rankingId, search: d.search, descending: d.descending, ...(d.scope ? { scope: { client: d.scope.client, audience: d.scope.audience } } : {}), ...(d.retentionWindow !== undefined ? { retentionWindow: d.retentionWindow } : {}) } } : {}) };
  } catch { return null; }
}
export const topicHref = (board: "5.8" | "5.9", view: TopicView) => preserveAuthenticatedReadingRoute(`/dashboards/public?design=dashboard-center&board=${board}&view=${encodeURIComponent(JSON.stringify(view))}`);
