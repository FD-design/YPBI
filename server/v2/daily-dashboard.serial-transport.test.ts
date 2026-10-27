import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { loadEnv } from "../config/env";
import { UpstreamClient } from "../upstream/client";
import { runWithUpstreamRequestProfile } from "../upstream/request-profile";
import { DailyDashboardService } from "./daily-dashboard.service";

test("serialized real transport preserves primary, secondary and queued preview credentials and values", async () => {
  const observed: Array<{ host: string; user: string | null; token: string | null; pid: string }> = [];
  const date = "2020-01-01";
  const now = () => new Date("2026-10-27T00:00:00Z");
  const values: Record<string, number> = { "fixture-primary": 7, "fixture-secondary": 11, "fixture-a": 13, "fixture-b": 17 };
  let active = 0, peak = 0;
  const client = new UpstreamClient({ ...loadEnv({ NODE_ENV: "test",
    UPSTREAM_API_BASE_URL: "https://primary.invalid", UPSTREAM_USER_NAME: "fixture-primary", UPSTREAM_X_TOKEN: "fixture-primary-token",
    UPSTREAM_SECONDARY_API_BASE_URL: "https://secondary.invalid", UPSTREAM_SECONDARY_USER_NAME: "fixture-secondary", UPSTREAM_SECONDARY_X_TOKEN: "fixture-secondary-token",
    UPSTREAM_CREDENTIALS_FILE: `/private/tmp/ypbi-serial-absent-${randomUUID()}.json`
  }), REQUEST_TIMEOUT_MS: 1000 }, async (input, init) => {
    const url = new URL(input.toString()), headers = new Headers(init?.headers);
    const user = headers.get("name"), pid = url.searchParams.get("pid")!;
    observed.push({ host: url.hostname, user, token: headers.get("x-token"), pid });
    active++; peak = Math.max(peak, active);
    try {
      await new Promise(resolve => setTimeout(resolve, 2));
      const value = values[user ?? ""];
      return Response.json(url.pathname.endsWith("/metrics") ? { code: 200, msg: {
        metricVersion: "bi-v1", generatedAt: now().toISOString(), watermark: null,
        rows: !url.searchParams.has("dimensionFilters") && url.searchParams.get("metricCodes")?.split(",").includes("M059") ? [{
          metricCode: "M059", businessDate: date, dimensions: { pid }, value, numerator: value, denominator: 0,
          unit: "count", dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "synthetic-v1"
        }] : []
      } } : { code: 200, msg: { pageData: [], totalData: [], totalCount: 0 }, data: [] });
    } finally { active--; }
  }, { maxActiveRequests: 1 });
  const service = new DailyDashboardService(client, now, undefined, { sourceReadTimeoutMs: 1000 });
  const read = (pid: string) => service.execute({ boardId: "5.10", pid, dateRange: [date, date] });
  const preview = (userName: string, token: string) => runWithUpstreamRequestProfile({ environment: "test", baseUrl: "https://preview.invalid",
    userName, token, cachePartition: userName }, () => read("PH"));
  const results = await Promise.all([read("PH"), preview("fixture-a", "fixture-a-token"), preview("fixture-b", "fixture-b-token"), read("FBI")]);
  expect(peak).toBe(1);
  expect(active).toBe(0);
  expect(results.map(result => result.data.series.find(series => series.metric.id === "M059")!.points[0].value)).toEqual([7, 13, 17, 11]);
  expect(observed.length).toBeGreaterThan(4);
  for (const request of observed) {
    const expected = request.user === "fixture-a" ? ["preview.invalid", "fixture-a-token", "PH"]
      : request.user === "fixture-b" ? ["preview.invalid", "fixture-b-token", "PH"]
      : request.user === "fixture-secondary" ? ["secondary.invalid", "fixture-secondary-token", "FBI"]
      : ["primary.invalid", "fixture-primary-token", "PH"];
    expect([request.host, request.token, request.pid]).toEqual(expected);
  }
  const count = observed.length;
  const again = await Promise.all([read("PH"), preview("fixture-a", "fixture-a-token"), preview("fixture-b", "fixture-b-token"), read("FBI")]);
  expect(again.map(result => result.data.series.find(series => series.metric.id === "M059")!.points[0].value)).toEqual([7, 13, 17, 11]);
  expect(observed).toHaveLength(count);
});
