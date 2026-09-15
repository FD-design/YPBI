import { z } from "zod";
import { UpstreamError, type UpstreamClient } from "./client";
import { REALTIME_API } from "./realtime.adapter";

export type WatchAttemptDay = { state: "available" | "no_record" | "no_value" | "invalid_value"; value: number | null };
const envelope = z.object({ msg: z.array(z.object({ pid: z.string(), sumDate: z.iso.datetime({ offset: true }), graphDate: z.string() }).loose()).max(288) }).loose();

/** A complete Beijing business day consists of 288 distinct five-minute buckets. */
export async function readWatchAttemptDay(client: Pick<UpstreamClient, "get">, pid: string, date: string): Promise<WatchAttemptDay> {
  const parsed = envelope.safeParse(await client.get(REALTIME_API, { pid, startDate: date + " 00:00:00", endDate: date + " 23:59:59" }));
  if (!parsed.success) throw new UpstreamError("DAILY_SOURCE_CONFLICT", "观影统计结构异常", 502);
  const rows = parsed.data.msg;
  if (!rows.length) return { state: "no_record", value: null };
  const start = Date.parse(date + "T00:00:00+08:00");
  const timestamps = new Set<number>();
  for (const row of rows) {
    const timestamp = Date.parse(row.sumDate), offset = timestamp - start;
    const minutes = offset / 60000;
    const expectedLabel = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    if (row.pid !== pid || offset < 0 || offset >= 86400000 || offset % 300000 !== 0 || row.graphDate !== expectedLabel || timestamps.has(timestamp)) {
      throw new UpstreamError("DAILY_SOURCE_CONFLICT", "观影统计平台、日期或时间桶冲突", 502);
    }
    timestamps.add(timestamp);
  }
  if (rows.length !== 288) return { state: "no_value", value: null };
  let sum = 0;
  for (const row of rows) {
    const raw = row.watchCount;
    if (raw == null || typeof raw === "string" && raw.trim() === "") return { state: "no_value", value: null };
    if (typeof raw !== "number" && typeof raw !== "string" || typeof raw === "string" && !/^\d+$/.test(raw.trim())) return { state: "invalid_value", value: null };
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(sum + value)) return { state: "invalid_value", value: null };
    sum += value;
  }
  return { state: "available", value: sum };
}
