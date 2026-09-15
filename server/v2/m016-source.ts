import { z } from "zod";
import type { V2MetricWatermark } from "../../contracts/bi-v2";
import type { UpstreamClient } from "../upstream/client";
import { toBeijingDate } from "../upstream/date";
import { P_DAY_SUM_API } from "../upstream/overview.adapter";
import { pagedUpstreamResponseSchema } from "../upstream/schemas";

const rawM016RowSchema = z.object({
  pid: z.string().trim().min(1),
  sumDate: z.string().trim().min(1),
  loginUserCount: z.unknown().optional()
}).loose();

const businessDateSchema = z.iso.date();
const localDateTimePattern = /^\d{4}-\d{2}-\d{2}(?:[ T](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?)?$/;
const offsetDateTimePattern = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/i;

export class M016SourceDataError extends Error {
  constructor(public readonly reason: "invalid_envelope" | "invalid_row" | "invalid_total" | "truncated_page") {
    super("M016 上游响应不满足只读查询契约");
    this.name = "M016SourceDataError";
  }
}

function parseM016Value(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" && typeof value !== "string") throw new M016SourceDataError("invalid_row");
  const normalized = typeof value === "string" ? value.trim() : value;
  if (normalized === "") return null;
  const numeric = typeof normalized === "number" ? normalized : Number(normalized);
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw new M016SourceDataError("invalid_row");
  return numeric;
}

function parseM016BusinessDate(value: string) {
  if (!localDateTimePattern.test(value) && !offsetDateTimePattern.test(value)) {
    throw new M016SourceDataError("invalid_row");
  }
  const businessDate = offsetDateTimePattern.test(value) ? toBeijingDate(value) : value.slice(0, 10);
  if (!businessDateSchema.safeParse(businessDate).success) throw new M016SourceDataError("invalid_row");
  return businessDate;
}

function parseOptionalTotal(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string") throw new M016SourceDataError("invalid_total");
  const normalized = typeof value === "string" ? value.trim() : value;
  if (normalized === "") return null;
  const numeric = typeof normalized === "number" ? normalized : Number(normalized);
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw new M016SourceDataError("invalid_total");
  return numeric;
}

export interface M016SourceRow {
  businessDate: string;
  pid: string;
  value: number | null;
}

export interface M016SourceResult {
  rows: M016SourceRow[];
  watermark: V2MetricWatermark | null;
}

export interface M016Source {
  queryDailyActiveUsers(input: { pid: string; dateRange: readonly [string, string] }): Promise<M016SourceResult>;
}

export class PDaySumM016Source implements M016Source {
  constructor(private readonly client: UpstreamClient) {}

  async queryDailyActiveUsers(input: { pid: string; dateRange: readonly [string, string] }): Promise<M016SourceResult> {
    const payload = await this.client.get(P_DAY_SUM_API, {
      page: "1",
      count: "500",
      pid: input.pid,
      sumDateStart: `${input.dateRange[0]} 00:00:00`,
      sumDateEnd: `${input.dateRange[1]} 23:59:59`
    });
    let envelope: z.infer<typeof pagedUpstreamResponseSchema>;
    try {
      envelope = pagedUpstreamResponseSchema.parse(payload);
    } catch {
      throw new M016SourceDataError("invalid_envelope");
    }
    const totalCount = parseOptionalTotal(envelope.msg.totalCount);
    const legacyTotal = parseOptionalTotal(envelope.msg.total);
    if (totalCount !== null && legacyTotal !== null && totalCount !== legacyTotal) {
      throw new M016SourceDataError("invalid_total");
    }
    const total = totalCount ?? legacyTotal;
    if (total !== null && total !== envelope.msg.pageData.length) {
      throw new M016SourceDataError(total > envelope.msg.pageData.length ? "truncated_page" : "invalid_total");
    }
    const rows = envelope.msg.pageData.map((item) => {
      let row: z.infer<typeof rawM016RowSchema>;
      try {
        row = rawM016RowSchema.parse(item);
      } catch {
        throw new M016SourceDataError("invalid_row");
      }
      return {
        businessDate: parseM016BusinessDate(row.sumDate),
        pid: row.pid,
        value: parseM016Value(row.loginUserCount)
      };
    });
    return { rows, watermark: null };
  }
}
