import { z } from "zod";
import type { NewavDatasetId } from "./catalog";
import { getNewavDataset } from "./catalog";
import type { NewavClient } from "./client";

const looseNumber = z.union([z.number(), z.string(), z.null(), z.undefined()]).transform((value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
});

const channelDailyRowSchema = z.object({
  date: z.string(), code: z.string(), name: z.string().optional(), visitors: looseNumber, registNew: looseNumber,
  active: looseNumber, activeNew: looseNumber, activeOld: looseNumber, viewers: looseNumber, viewersNew: looseNumber,
  ipTotal: looseNumber, ipUniq: looseNumber, adClick: looseNumber, adClickUsers: looseNumber.optional(),
  rechargeNew: looseNumber, vipBuyers: looseNumber, convRate: looseNumber.optional()
}).loose();

export interface ChannelDailyRow {
  date: string;
  channelCode: string;
  channelName: string;
  visitors: number | null;
  newUsers: number | null;
  activeUsers: number | null;
  newActiveUsers: number | null;
  returningUsers: number | null;
  viewers: number | null;
  newViewers: number | null;
  visits: number | null;
  uniqueIps: number | null;
  adClicks: number | null;
  adClickUsers: number | null;
  newRevenue: number | null;
  vipBuyers: number | null;
}

function unwrap(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const data = Reflect.get(value, "data");
  return data && typeof data === "object" ? data : value;
}

export function normalizeChannelDaily(payload: unknown): { rows: ChannelDailyRow[]; rawTotals: Record<string, unknown> | null } {
  const value = unwrap(payload);
  const parsed = z.object({ rows: z.array(channelDailyRowSchema).default([]), totals: z.record(z.string(), z.unknown()).optional() }).loose().parse(value);
  return {
    rows: parsed.rows.map((row) => ({
      date: row.date,
      channelCode: row.code,
      channelName: row.name ?? row.code,
      visitors: row.visitors,
      newUsers: row.registNew,
      activeUsers: row.active,
      newActiveUsers: row.activeNew,
      returningUsers: row.activeOld,
      viewers: row.viewers,
      newViewers: row.viewersNew,
      visits: row.ipTotal,
      uniqueIps: row.ipUniq,
      adClicks: row.adClick,
      adClickUsers: row.adClickUsers ?? null,
      newRevenue: row.rechargeNew,
      vipBuyers: row.vipBuyers
    })),
    rawTotals: parsed.totals ?? null
  };
}

const sum = (rows: ChannelDailyRow[], key: keyof ChannelDailyRow) => rows.reduce((total, row) => total + (typeof row[key] === "number" ? row[key] : 0), 0);

export function aggregateChannelDaily(rows: ChannelDailyRow[]) {
  const dates = new Set(rows.map((row) => row.date));
  const visitors = sum(rows, "visitors");
  const newUsers = sum(rows, "newUsers");
  const activeUserDays = sum(rows, "activeUsers");
  return {
    visitors,
    newUsers,
    averageActiveUsers: dates.size ? activeUserDays / dates.size : null,
    activeUserDays,
    viewerUserDays: sum(rows, "viewers"),
    adClicks: sum(rows, "adClicks"),
    newRevenue: sum(rows, "newRevenue"),
    vipBuyers: sum(rows, "vipBuyers"),
    registrationRate: visitors ? newUsers / visitors : null
  };
}

function rowsFromUnknown(value: unknown): Array<Record<string, unknown>> {
  const unwrapped = unwrap(value);
  if (Array.isArray(unwrapped)) return unwrapped.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  if (!unwrapped || typeof unwrapped !== "object") return [];
  for (const key of ["rows", "items", "list", "series"]) {
    const candidate = Reflect.get(unwrapped, key);
    if (Array.isArray(candidate)) return candidate.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  }
  return [];
}

function summaryFromUnknown(value: unknown): Record<string, number | null> {
  const unwrapped = unwrap(value);
  if (!unwrapped || typeof unwrapped !== "object") return {};
  const candidate = Reflect.get(unwrapped, "totals") ?? Reflect.get(unwrapped, "summary") ?? unwrapped;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return {};
  return Object.fromEntries(Object.entries(candidate).filter(([, item]) => ["number", "string"].includes(typeof item)).map(([key, item]) => {
    const number = Number(item);
    return [key, Number.isFinite(number) ? number : null];
  }));
}

export interface NewavQueryInput {
  datasetId: NewavDatasetId;
  dateRange: [string, string];
  channelCode?: string;
}

export class NewavAdapter {
  constructor(private readonly client: NewavClient) {}

  async query(input: NewavQueryInput) {
    const definition = getNewavDataset(input.datasetId);
    if (!definition) throw new Error("NewAV 数据集不存在");
    const [from, to] = input.dateRange;
    const days = String(Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1));
    const params: Record<string, string> = {};
    if (definition.parameters.includes("from")) params.from = from;
    if (definition.parameters.includes("to")) params.to = to;
    if (definition.parameters.includes("date")) params.date = to;
    if (definition.parameters.includes("days")) params.days = input.datasetId === "renewal" ? "90" : days;
    if (definition.parameters.includes("grace")) params.grace = "7";
    if (definition.parameters.includes("code") && input.channelCode) params.code = input.channelCode;
    const payload = await this.client.request(definition.method, definition.path, params);
    if (input.datasetId === "channelDaily") {
      const normalized = normalizeChannelDaily(payload);
      return { definition, rows: normalized.rows, summary: aggregateChannelDaily(normalized.rows), warnings: normalized.rows.length ? [] : ["所选周期没有渠道日报数据"] };
    }
    return { definition, rows: rowsFromUnknown(payload), summary: summaryFromUnknown(payload), warnings: [] };
  }
}
