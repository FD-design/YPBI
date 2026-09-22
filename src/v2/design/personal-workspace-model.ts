import type { DateRangeValue } from "../../components/ui/date-range-model";

// Configuration-only memory for the isolated DEV review. It is not an account repository.
export type AnalysisKind = "metrics" | "events" | "funnels";
export type EventMeasure = "count" | "users" | "average" | "property";
export type FilterOperator = "in" | "not_in" | "contains" | "not_contains" | "gt" | "gte" | "lt" | "lte" | "between" | "exists" | "missing";
export interface AnalysisFilter { key: string; field: string; operator: FilterOperator; values: string[] }
export interface AnalysisItem { key: string; ref: string; version: string; measure: EventMeasure; alias?: string; filters?: AnalysisFilter[]; property?: string; aggregation?: "sum" | "avg" | "max" | "min" }
export interface AnalysisConfig {
  kind: AnalysisKind;
  items: AnalysisItem[];
  range: DateRangeValue;
  scope: string;
  comparison: boolean;
  group: string;
  secondaryGroup?: string;
  filters?: AnalysisFilter[];
  grain?: "hour" | "day" | "week" | "month" | "total";
  mainItem?: string;
  windowMinutes?: number;
}
export interface SavedAnalysis { id: string; revision: number; name: string; config: AnalysisConfig; updated: string }
export interface BoardComponent { id: string; sourceId: string; title: string; width: "half" | "full" }
export interface PersonalBoard { id: string; revision: number; name: string; components: BoardComponent[]; updated: string }
export interface QuickOverview { id: string; revision: number; name: string; metricIds: string[]; pid: string; updated: string }
export interface WorkspaceMemory { analyses: SavedAnalysis[]; boards: PersonalBoard[]; overviews: QuickOverview[] }
let analysisDraft: AnalysisConfig | null = null;
export function stageAnalysisDraft(config: AnalysisConfig) { analysisDraft = structuredClone(config); }
export function readAnalysisDraft(kind: AnalysisKind) { return analysisDraft?.kind === kind ? structuredClone(analysisDraft) : null; }
export function clearAnalysisDraft() { analysisDraft = null; }
let memory: WorkspaceMemory = { analyses: [], boards: [], overviews: [] };
const subscribers = new Set<() => void>();
export const subscribeWorkspace = (listener: () => void) => { subscribers.add(listener); return () => { subscribers.delete(listener); }; };
export const readWorkspace = () => memory;
export const localId = () => `local-${crypto.randomUUID()}`;
export const analysisFingerprint = (config: AnalysisConfig) => JSON.stringify(config);
export const emptyAnalysis = (kind: AnalysisKind): AnalysisConfig => ({ kind, items: Array.from({length:kind === "funnels" ? 2 : 1}, () => ({ key: localId(), ref: "", version: "", measure: "count" })), range: { start: "2026-09-02", end: "2026-09-08" }, scope: "overall", comparison: false, group: "none" });
export function validName(name: string) { return name.trim().length > 0 && name.trim().length <= 60; }
export function saveWorkspaceObject<K extends keyof WorkspaceMemory>(kind: K, object: WorkspaceMemory[K][number]) {
  if (!validName(object.name)) throw new Error("名称须为1～60个字符。");
  const current = memory[kind].find(item => item.id === object.id);
  if (current && current.revision !== object.revision) throw new Error("方案已更新，请重新打开后再保存。");
  const next = structuredClone({ ...object, name: object.name.trim(), revision: object.revision + 1, updated: new Date().toISOString() });
  memory = { ...memory, [kind]: current ? memory[kind].map(item => item.id === object.id ? next : item) : [...memory[kind], next] };
  subscribers.forEach(listener => listener());
  return next;
}
export function removePersonalObject(kind: "boards" | "overviews", id: string) {
  memory = { ...memory, [kind]: memory[kind].filter(item => item.id !== id) };
  subscribers.forEach(listener => listener());
}
export function addAnalysisToBoard(sourceId: string, boardId: string) {
  const source = memory.analyses.find(item => item.id === sourceId), board = memory.boards.find(item => item.id === boardId);
  if (!source || !board) throw new Error("来源或看板已失效，请重新选择。");
  const component: BoardComponent = { id: localId(), sourceId, title: "", width: "half" };
  saveWorkspaceObject("boards", { ...board, components: [...board.components, component] });
  return component.id;
}

export function personalHref(path: string, id?: string) {
  const authenticated = typeof window !== "undefined" && !new URLSearchParams(window.location.search).has("design");
  const params = new URLSearchParams(authenticated ? { local: "workspace" } : { design: "personal-workspace" });
  if (id) params.set("object", id);
  return path + "?" + params;
}
