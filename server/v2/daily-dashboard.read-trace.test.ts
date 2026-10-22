import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { DailyDashboardQuery } from "../../contracts/daily-dashboard";
import { loadEnv } from "../config/env";
import { UpstreamClient } from "../upstream/client";
import { runWithUpstreamRequestProfile } from "../upstream/request-profile";
import { DailyDashboardService, dailyDashboardScopeTag } from "./daily-dashboard.service";

type Logger = NonNullable<ConstructorParameters<typeof DailyDashboardService>[2]>;
type Entry = Parameters<Logger["info"]>[0];
const query: DailyDashboardQuery = { boardId: "5.2", pid: "PH", dateRange: ["2026-10-14", "2026-10-21"], projection: "operating_snapshot" };
const now = () => new Date("2026-10-22T09:00:00Z");
function fixture(failNew = false) {
  const env = loadEnv({ NODE_ENV: "test", UPSTREAM_API_BASE_URL: "https://fixture.invalid", UPSTREAM_USER_NAME: "private-fixture-name", UPSTREAM_X_TOKEN: "private-fixture-token", UPSTREAM_CREDENTIALS_FILE: `/private/tmp/bi-trace-absent-${randomUUID()}.json` });
  return new UpstreamClient(env, async input => {
    const url = new URL(input.toString());
    let body: unknown = { code: 200, msg: { pageData: [] } };
    if (url.pathname.endsWith("/metrics") || url.pathname.endsWith("/playback")) {
      if (failNew && url.searchParams.get("dimensionFilters") === '{"userCohort":"new"}') return new Response(JSON.stringify({ code: 500, err: "private server reason" }), { status: 500 });
      body = { code: 200, msg: { metricVersion: "bi-v1", generatedAt: now().toISOString(), watermark: null, rows: [] } };
    } else if (url.pathname.endsWith("pDaySum")) body = { code: 200, msg: { totalCount: 0, pageData: [] } };
    else if (url.pathname.includes("reletionsStatPlus")) body = { code: 200, data: [] };
    else if (url.pathname.endsWith("channelStatByTypeV2")) body = { code: 200, msg: { pageData: [], totalData: [] } };
    return new Response(JSON.stringify(body), { status: 200 });
  });
}
const normalized = (value: Awaited<ReturnType<DailyDashboardService["execute"]>>) => ({ ...value, data: { ...value.data, queryId: "query" } });

describe("operating private read trace wiring", () => {
  test("trace remains private and correlates physical failures with the correct metric group", async () => {
    const entries: Array<{ fields: Entry; message: string }> = [];
    const logger: Logger = { info: (fields, message) => { entries.push({ fields, message }); } };
    const result = await new DailyDashboardService(fixture(true), now, logger, { readTraceEnabled: true }).execute(query);
    const plain = await new DailyDashboardService(fixture(true), now).execute(query);
    expect(normalized(result)).toEqual(normalized(plain));
    expect(entries).toHaveLength(2);
    const record = entries.find(entry => entry.message === "daily dashboard read trace completed")!.fields;
    expect(record.queryId).toBe(result.data.queryId);
    expect(record.scopeTag).toBe(dailyDashboardScopeTag(query));
    expect(record.readTrace!.byGroup.new!.failedLogicalReadCount).toBe(1);
    expect(record.readTrace!.byGroup.new!.upstreamHttpStatusCounts).toEqual({ 500: 1 });
    expect(record.readTrace!.byGroup.new!.failureOriginCounts).toEqual({ http: 1 });
    expect(record.readTrace!.physicalReads.filter(read => read.upstreamHttpStatus === 500)).toHaveLength(1);
    expect(record.failedPoints!.find(point => point.metricId === "M016.new")!.pointIndexes).toEqual([0, 1, 2]);
    expect(result.data).not.toHaveProperty("readTrace");
    for (const secret of ["private-fixture-name", "private-fixture-token", "private server reason", "https://", "/api/", "PH", "2026-10-21", "dimensionFilters"]) expect(JSON.stringify(record)).not.toContain(secret);
  });

  test("logger failure does not change the public result", async () => {
    let count = 0;
    const result = await new DailyDashboardService(fixture(), now, { info: () => { count++; throw new Error("fixture logger failure"); } }, { readTraceEnabled: true }).execute(query);
    expect(count).toBe(2);
    expect(normalized(result)).toEqual(normalized(await new DailyDashboardService(fixture(), now).execute(query)));
  });

  test("scope correlation separates environment without logging scope inputs", async () => {
    expect(dailyDashboardScopeTag(query)).not.toBe(dailyDashboardScopeTag(query, "test"));
    const entries: Entry[] = [];
    const logger: Logger = { info: fields => { entries.push(fields); } };
    await runWithUpstreamRequestProfile({ environment: "test", cachePartition: "private-preview", baseUrl: "https://preview.invalid", userName: "private-preview-user", token: "private-preview-token" },
      () => new DailyDashboardService(fixture(), now, logger, { readTraceEnabled: true }).execute(query));
    expect(entries[1].scopeTag).toBe(dailyDashboardScopeTag(query, "test"));
    expect(JSON.stringify(entries)).not.toContain("private-preview");
  });
});
