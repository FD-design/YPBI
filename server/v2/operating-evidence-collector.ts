import { createHash } from "node:crypto";
import { z } from "zod";
import { monthlyMetricMetadataSchema } from "../../contracts/monthly-query-scope";
import { BI_V1_PLAYBACK_API } from "../upstream/bi-v1.adapter";
import { BI_V1_METRICS_API, biV1MetricCodeSchema } from "../upstream/bi-v1.metrics-adapter";
import type { UpstreamClient } from "../upstream/client";
import { sourceReadErrorCode } from "./source-read-diagnostics";

export const OPERATING_EVIDENCE_MAX_CALLS = 160;
export const OPERATING_EVIDENCE_MAX_ROWS_PER_CALL = 3_000;
export const OPERATING_EVIDENCE_MAX_BYTES = 2 * 1024 * 1024;
// Reserve bounded request/envelope metadata for every admitted logical call.
const MAX_CALL_METADATA_BYTES = 4_096;
const MAX_RETAINED_ROW_BYTES = OPERATING_EVIDENCE_MAX_BYTES - OPERATING_EVIDENCE_MAX_CALLS * MAX_CALL_METADATA_BYTES;

type ValueKind = "missing" | "undefined" | "null" | "string" | "number" | "boolean" | "array" | "object" | "bigint" | "symbol" | "function";
export interface OperatingEvidenceFieldState {
  readonly state: "valid" | "missing" | "null" | "invalid" | "protected";
  readonly kind: ValueKind;
  readonly sha256?: string;
}
const PARAM_FIELDS = ["pid", "startDate", "endDate", "granularity", "metricCodes", "includeIncomplete", "dimensions", "dimensionFilters"] as const;
const DIMENSION_FIELDS = ["pid", "clientPlatform", "userCohort", "sourceType", "paymentMethod", "videoType"] as const;
const ROW_FIELDS = ["metricCode", "businessDate", "dimensions", "value", "numerator", "denominator", "unit", "dataStatus", "metricVersion", "ruleVersion"] as const;
const MONTHLY_ROW_FIELDS = ["month", "cutoffDate", "isComplete"] as const;
const MESSAGE_FIELDS = ["metricVersion", "generatedAt", "watermark", "rows"] as const;
type ParamField = typeof PARAM_FIELDS[number];
type DimensionField = typeof DIMENSION_FIELDS[number];
type RowField = typeof ROW_FIELDS[number];
type MonthlyRowField = typeof MONTHLY_ROW_FIELDS[number];
type MessageField = typeof MESSAGE_FIELDS[number];
type FieldStates<T extends string> = Readonly<Record<T, OperatingEvidenceFieldState>>;
type JsonScalar = string | number | boolean | null;

export interface OperatingEvidenceParams {
  readonly pid?: string;
  readonly startDate?: string;
  /** The actual upstream end bound is exclusive. */
  readonly endDate?: string;
  readonly granularity?: "day" | "summary";
  readonly metricCodes?: string;
  readonly includeIncomplete?: "true" | "false";
  readonly dimensions?: string;
  readonly dimensionFilters?: Readonly<Partial<Record<"clientPlatform" | "userCohort" | "sourceType" | "paymentMethod", string>>>;
  readonly fieldState: FieldStates<ParamField>;
  readonly omittedFieldCount: number;
}
export interface OperatingEvidenceDimensions {
  readonly pid?: string;
  readonly clientPlatform?: string;
  readonly userCohort?: string;
  readonly sourceType?: string;
  readonly paymentMethod?: string;
  readonly videoType?: string;
  readonly fieldState: FieldStates<DimensionField>;
  readonly omittedFieldCount: number;
}
export interface OperatingEvidenceBusinessRow {
  readonly rowIndex: number;
  readonly scope: "in_scope";
  readonly dateScope: "dated" | "undated";
  readonly metricCode?: string;
  readonly businessDate?: string;
  readonly dimensions: OperatingEvidenceDimensions;
  readonly value?: number | null;
  readonly numerator?: number | null;
  readonly denominator?: number | null;
  readonly unit?: string;
  readonly dataStatus?: string;
  readonly metricVersion?: string;
  readonly ruleVersion?: string;
  readonly month?: string;
  readonly cutoffDate?: string;
  readonly isComplete?: boolean;
  readonly fieldState: FieldStates<RowField> & Readonly<Partial<Record<MonthlyRowField, OperatingEvidenceFieldState>>>;
  readonly omittedFieldCount: number;
}
type IdentityFailure = "row_invalid" | "request_scope_invalid" | "pid_missing" | "pid_invalid" | "pid_mismatch" | "date_invalid" | "date_out_of_range" | "metric_code_missing" | "metric_code_invalid" | "metric_code_out_of_scope";
export interface OperatingEvidenceUnidentifiedRow {
  readonly rowIndex: number;
  readonly scope: "scope_conflict";
  readonly reason: IdentityFailure;
  /** Only malformed identities receive typed diagnostics; other-PID/date rows are opaque. */
  readonly identityState?: Readonly<Partial<Record<"row" | "pid" | "businessDate" | "metricCode", OperatingEvidenceFieldState>>>;
}
export type OperatingEvidenceRow = OperatingEvidenceBusinessRow | OperatingEvidenceUnidentifiedRow;
export interface OperatingEvidenceResponse {
  readonly code?: number | string;
  readonly metricVersion?: string;
  readonly generatedAt?: string;
  readonly watermark?: string | null;
  readonly fieldState: FieldStates<"code" | MessageField | "envelope" | "msg">;
  readonly omittedFieldCount: number;
  readonly omittedMsgFieldCount: number;
  readonly rowCount: number | null;
  readonly retainedRowCount: number;
  readonly omittedRows: number | null;
  readonly truncated: boolean;
  readonly truncationReasons: readonly ("row_limit" | "response_bytes")[];
  readonly rows: readonly OperatingEvidenceRow[];
}
export interface OperatingEvidenceCall {
  readonly sequence: number;
  readonly source: "metrics" | "playback";
  readonly path: typeof BI_V1_METRICS_API | typeof BI_V1_PLAYBACK_API;
  readonly transportEvidence: "client_business_projection";
  readonly httpStatus: null;
  readonly cacheHit: null;
  readonly params: OperatingEvidenceParams;
  readonly state: "pending" | "fulfilled" | "rejected";
  readonly response: OperatingEvidenceResponse | null;
  readonly errorCode: ReturnType<typeof sourceReadErrorCode> | null;
}
export interface OperatingEvidenceSnapshot {
  readonly calls: readonly OperatingEvidenceCall[];
  readonly omittedCallCount: number;
}
export interface OperatingEvidenceCollectorOptions {
  readonly isProtectedText?: (value: string) => boolean;
}

const metricCodes = new Set<string>(biV1MetricCodeSchema.options);
const DIMENSION_VALUES: Readonly<Record<Exclude<DimensionField, "pid">, readonly string[]>> = {
  clientPlatform: ["android", "ios", "web"],
  userCohort: ["new", "old"],
  sourceType: ["natural", "internal_channel"],
  paymentMethod: ["ali_pay", "wx_pay", "usdt_pay", "unknown"],
  videoType: ["default", "short", "long", "short_video", "long_video", "短视频", "长视频"]
};
const units = new Set(["count", "ratio", "count_per_user", "seconds", "currency"]);
const statuses = new Set(["READY", "PROCESSING", "NOT_MATURE", "SOURCE_INCOMPLETE", "FAILED"]);
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });
type PlainObject = Record<string, unknown>;
const isObject = (value: unknown): value is PlainObject => value !== null && typeof value === "object" && !Array.isArray(value);
function field(object: unknown, name: string): { present: boolean; value: unknown } {
  if (!isObject(object)) return { present: false, value: undefined };
  const descriptor = Object.getOwnPropertyDescriptor(object, name);
  return descriptor && "value" in descriptor ? { present: true, value: descriptor.value } : { present: false, value: undefined };
}
function kind(value: unknown): ValueKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
function invalidState(value: unknown, present: boolean, state: OperatingEvidenceFieldState["state"] = "invalid"): OperatingEvidenceFieldState {
  if (!present) return { state: "missing", kind: "missing" };
  const valueKind = kind(value);
  const digestible = state !== "protected" && (valueKind === "string" || valueKind === "number" || valueKind === "boolean" || valueKind === "bigint");
  return { state: value === null && state !== "protected" ? "null" : state, kind: valueKind,
    ...(digestible ? { sha256: createHash("sha256").update(`${valueKind}\u0000${String(value)}`).digest("hex") } : {}) };
}
function omittedFields(object: unknown, allowed: readonly string[]) {
  return isObject(object) ? Object.keys(object).filter(key => !allowed.includes(key)).length : 0;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** A request-local observer of business fields returned by UpstreamClient, before adapter parsing. */
export function createOperatingEvidenceCollector(client: Pick<UpstreamClient, "get">, options: OperatingEvidenceCollectorOptions = {}): {
  client: Pick<UpstreamClient, "get">;
  finish(): OperatingEvidenceSnapshot;
} {
  type MutableCall = Omit<OperatingEvidenceCall, "state" | "response" | "errorCode"> & {
    state: OperatingEvidenceCall["state"]; response: OperatingEvidenceResponse | null; errorCode: OperatingEvidenceCall["errorCode"];
  };
  const calls: MutableCall[] = [];
  let omittedCallCount = 0, retainedRowBytes = 0;
  let finished: OperatingEvidenceSnapshot | undefined;
  const protectedText = (value: string) => {
    try { return options.isProtectedText?.(value) === true; }
    catch { return true; }
  };
  const invalid = (value: unknown, present: boolean) => invalidState(value, present,
    typeof value === "string" && protectedText(value) ? "protected" : "invalid");
  const select = <T extends JsonScalar>(object: unknown, name: string, valid: (value: unknown) => value is T, nullable = false) => {
    const source = field(object, name);
    if (source.present && typeof source.value === "string" && protectedText(source.value)) {
      return { state: invalidState(source.value, true, "protected") };
    }
    if (source.present && source.value === null && nullable) return { value: null, state: { state: "null", kind: "null" } as OperatingEvidenceFieldState };
    if (source.present && valid(source.value)) return { value: source.value, state: { state: "valid", kind: kind(source.value) } as OperatingEvidenceFieldState };
    return { state: invalid(source.value, source.present) };
  };
  const string = (predicate: (value: string) => boolean) => (value: unknown): value is string => typeof value === "string" && predicate(value);
  const date = string(value => value.length === 10 && isoDate.safeParse(value).success);
  const dimensionFilterValues = (raw: unknown): raw is string => {
    if (typeof raw !== "string" || raw.length > 1_024) return false;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isObject(parsed) && Object.entries(parsed).every(([key, value]) =>
        ["clientPlatform", "userCohort", "sourceType", "paymentMethod"].includes(key)
        && typeof value === "string" && !protectedText(value) && DIMENSION_VALUES[key as Exclude<DimensionField, "pid" | "videoType">].includes(value));
    } catch { return false; }
  };
  const projectParams = (params: Record<string, string>): OperatingEvidenceParams => {
    const predicates: Record<ParamField, (value: unknown) => value is string> = {
      pid: string(value => /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(value)),
      startDate: date, endDate: date,
      granularity: string(value => value === "day" || value === "summary"),
      metricCodes: string(value => value.length <= 512 && value.length > 0 && value.split(",").every(code => metricCodes.has(code) && !protectedText(code))),
      includeIncomplete: string(value => value === "true" || value === "false"),
      dimensions: string(value => value.length <= 128 && value.split(",").every(name => DIMENSION_FIELDS.includes(name as DimensionField) && name !== "pid" && !protectedText(name))),
      dimensionFilters: dimensionFilterValues
    };
    const values: Record<string, unknown> = {};
    const states = {} as Record<ParamField, OperatingEvidenceFieldState>;
    for (const name of PARAM_FIELDS) {
      const selected = select(params, name, predicates[name]);
      if (name === "dimensionFilters") {
        const raw = field(params, name);
        if (typeof raw.value === "string" && raw.value.length <= 1_024) {
          try {
            const parsed: unknown = JSON.parse(raw.value);
            if (isObject(parsed) && Object.values(parsed).some(value => typeof value === "string" && protectedText(value))) {
              states[name] = { state: "protected", kind: "string" };
              continue;
            }
          } catch { /* The field selector retains the invalid JSON diagnosis. */ }
        }
      }
      states[name] = selected.state;
      if (typeof selected.value === "string") values[name] = name === "dimensionFilters" ? JSON.parse(selected.value) as unknown : selected.value;
    }
    return { ...values, fieldState: states, omittedFieldCount: omittedFields(params, PARAM_FIELDS) };
  };
  const projectDimensions = (dimensions: unknown): OperatingEvidenceDimensions => {
    const values: Record<string, string> = {};
    const states = {} as Record<DimensionField, OperatingEvidenceFieldState>;
    for (const name of DIMENSION_FIELDS) {
      const selected = select(dimensions, name, name === "pid"
        ? string(value => /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(value))
        : string(value => DIMENSION_VALUES[name].includes(value)));
      states[name] = selected.state;
      if (typeof selected.value === "string") values[name] = selected.value;
    }
    return { ...values, fieldState: states, omittedFieldCount: omittedFields(dimensions, DIMENSION_FIELDS) };
  };
  const projectRow = (raw: unknown, rowIndex: number, params: OperatingEvidenceParams): OperatingEvidenceRow => {
    const conflict = (reason: IdentityFailure, identityState?: OperatingEvidenceUnidentifiedRow["identityState"]): OperatingEvidenceUnidentifiedRow => ({ rowIndex, scope: "scope_conflict", reason, ...(identityState ? { identityState } : {}) });
    if (!isObject(raw)) return conflict("row_invalid", { row: invalid(raw, true) });
    if (!params.pid || !params.startDate || !params.endDate || !params.metricCodes || params.startDate >= params.endDate) return conflict("request_scope_invalid");
    const dimensionsSource = field(raw, "dimensions");
    const pid = select(dimensionsSource.value, "pid", string(value => /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(value)));
    if (pid.state.state === "missing") return conflict("pid_missing", { pid: pid.state });
    if (typeof pid.value !== "string") return conflict("pid_invalid", { pid: pid.state });
    if (pid.value !== params.pid) return conflict("pid_mismatch");
    const businessDate = select(raw, "businessDate", date);
    if (businessDate.state.state !== "missing" && typeof businessDate.value !== "string") return conflict("date_invalid", { businessDate: businessDate.state });
    if (typeof businessDate.value === "string" && (businessDate.value < params.startDate || businessDate.value >= params.endDate)) return conflict("date_out_of_range");
    const code = select(raw, "metricCode", string(value => metricCodes.has(value)));
    if (code.state.state === "missing") return conflict("metric_code_missing", { metricCode: code.state });
    if (typeof code.value !== "string") return conflict("metric_code_invalid", { metricCode: code.state });
    if (!params.metricCodes.split(",").includes(code.value)) return conflict("metric_code_out_of_scope");
    const values: Record<string, JsonScalar> = { metricCode: code.value };
    const states = { metricCode: code.state, businessDate: businessDate.state,
      dimensions: isObject(dimensionsSource.value) ? { state: "valid", kind: "object" } : invalid(dimensionsSource.value, dimensionsSource.present)
    } as Record<RowField, OperatingEvidenceFieldState> & Partial<Record<MonthlyRowField, OperatingEvidenceFieldState>>;
    if (typeof businessDate.value === "string") values.businessDate = businessDate.value;
    for (const name of ["value", "numerator", "denominator"] as const) {
      const selected = select(raw, name, (value): value is number => typeof value === "number" && Number.isFinite(value), true);
      states[name] = selected.state;
      if (selected.value !== undefined) values[name] = selected.value;
    }
    const predicates = {
      unit: string(value => units.has(value)), dataStatus: string(value => statuses.has(value)),
      metricVersion: string(value => value === "bi-v1"), ruleVersion: string(value => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value))
    };
    for (const name of ["unit", "dataStatus", "metricVersion", "ruleVersion"] as const) {
      const selected = select(raw, name, predicates[name]);
      states[name] = selected.state;
      if (typeof selected.value === "string") values[name] = selected.value;
    }
    if (code.value === "M018") {
      const metadataPredicates = {
        month: string(value => monthlyMetricMetadataSchema.shape.month.safeParse(value).success),
        cutoffDate: date,
        isComplete: (value: unknown): value is boolean => typeof value === "boolean"
      };
      for (const name of MONTHLY_ROW_FIELDS) {
        const selected = select<string | boolean>(raw, name, metadataPredicates[name]);
        // Monthly metadata diagnostics expose only type and state. Malformed
        // or protected source text must not produce plaintext or a digest.
        const { sha256: _digest, ...state } = selected.state;
        states[name] = state;
        if (selected.value !== undefined) values[name] = selected.value;
      }
    }
    return { rowIndex, scope: "in_scope", dateScope: businessDate.state.state === "missing" ? "undated" : "dated", ...values,
      dimensions: projectDimensions(dimensionsSource.value), fieldState: states,
      omittedFieldCount: omittedFields(raw, code.value === "M018" ? [...ROW_FIELDS, ...MONTHLY_ROW_FIELDS] : ROW_FIELDS) };
  };
  const projectResponse = (payload: unknown, params: OperatingEvidenceParams): OperatingEvidenceResponse => {
    const msg = field(payload, "msg"), rawRows = field(msg.value, "rows");
    const code = select(payload, "code", (value): value is number | string => typeof value === "number" && Number.isFinite(value) || value === "200");
    const version = select(msg.value, "metricVersion", string(value => value === "bi-v1"));
    const generatedAt = select(msg.value, "generatedAt", string(value => value.length <= 64 && isoDateTime.safeParse(value).success));
    const watermark = select(msg.value, "watermark", string(value => value.length <= 64 && (isoDate.safeParse(value).success || isoDateTime.safeParse(value).success)), true);
    const rowCount = Array.isArray(rawRows.value) ? rawRows.value.length : null;
    const rows: OperatingEvidenceRow[] = [];
    const truncationReasons: ("row_limit" | "response_bytes")[] = [];
    if (Array.isArray(rawRows.value)) {
      const admitted = Math.min(rawRows.value.length, OPERATING_EVIDENCE_MAX_ROWS_PER_CALL);
      for (let index = 0; index < admitted; index++) {
        const row = projectRow(rawRows.value[index], index, params);
        const bytes = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
        if (retainedRowBytes + bytes > MAX_RETAINED_ROW_BYTES) { truncationReasons.push("response_bytes"); break; }
        retainedRowBytes += bytes;
        rows.push(row);
      }
      if (rawRows.value.length > OPERATING_EVIDENCE_MAX_ROWS_PER_CALL) truncationReasons.push("row_limit");
    }
    const values: Record<string, JsonScalar> = {};
    if (code.value !== undefined) values.code = code.value;
    if (typeof version.value === "string") values.metricVersion = version.value;
    if (typeof generatedAt.value === "string") values.generatedAt = generatedAt.value;
    if (watermark.value !== undefined) values.watermark = watermark.value;
    return { ...values, fieldState: {
      envelope: isObject(payload) ? { state: "valid", kind: "object" } : invalid(payload, true),
      msg: isObject(msg.value) ? { state: "valid", kind: "object" } : invalid(msg.value, msg.present),
      code: code.state, metricVersion: version.state, generatedAt: generatedAt.state, watermark: watermark.state,
      rows: Array.isArray(rawRows.value) ? { state: "valid", kind: "array" } : invalid(rawRows.value, rawRows.present)
    }, omittedFieldCount: omittedFields(payload, ["code", "msg"]), omittedMsgFieldCount: omittedFields(msg.value, MESSAGE_FIELDS),
    rowCount, retainedRowCount: rows.length, omittedRows: rowCount === null ? null : rowCount - rows.length,
    truncated: truncationReasons.length > 0, truncationReasons, rows };
  };
  const safeCall = (path: string, params: Record<string, string>): MutableCall | undefined => {
    if (finished || path !== BI_V1_METRICS_API && path !== BI_V1_PLAYBACK_API) return undefined;
    if (calls.length >= OPERATING_EVIDENCE_MAX_CALLS) { omittedCallCount++; return undefined; }
    try {
      const call: MutableCall = { sequence: calls.length + omittedCallCount + 1, source: path === BI_V1_METRICS_API ? "metrics" : "playback", path,
        transportEvidence: "client_business_projection", httpStatus: null, cacheHit: null, params: projectParams(params), state: "pending", response: null, errorCode: null };
      // This protects the metadata reserve if its allowlisted shape is extended later.
      if (Buffer.byteLength(JSON.stringify(call), "utf8") > MAX_CALL_METADATA_BYTES - 1_536) { omittedCallCount++; return undefined; }
      calls.push(call);
      return call;
    } catch { omittedCallCount++; return undefined; }
  };
  return {
    client: { get: async (path, params, inboundToken, consumerSignal) => {
      const call = safeCall(path, params);
      let payload: unknown;
      try { payload = await client.get(path, params, inboundToken, consumerSignal); }
      catch (error) {
        if (call && !finished) { call.state = "rejected"; call.errorCode = sourceReadErrorCode(error); }
        throw error;
      }
      if (call && !finished) {
        call.state = "fulfilled";
        try { call.response = projectResponse(payload, call.params); }
        catch { call.errorCode = "unknown"; }
      }
      return payload;
    } },
    finish() {
      if (!finished) {
        // Only objects created above are frozen; the upstream payload is never retained or mutated.
        finished = deepFreeze({ calls: [...calls], omittedCallCount });
      }
      return finished;
    }
  };
}
