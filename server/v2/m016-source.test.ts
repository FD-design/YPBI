import { describe, expect, test } from "bun:test";
import type { UpstreamClient } from "../upstream/client";
import { P_DAY_SUM_API } from "../upstream/overview.adapter";
import { M016SourceDataError, PDaySumM016Source } from "./m016-source";

function sourceForRows(pageData: unknown[], total?: unknown) {
  return new PDaySumM016Source({
    get: async () => ({ code: 200, msg: { pageData, ...(total === undefined ? {} : { total }) } })
  } as unknown as UpstreamClient);
}

describe("PDaySumM016Source", () => {
  test("按固定分页与所选 PID、业务日期调用唯一候选接口", async () => {
    let capturedApi: unknown;
    let capturedParams: unknown;
    const source = new PDaySumM016Source({
      get: async (api: unknown, params: unknown) => {
        capturedApi = api;
        capturedParams = params;
        return { code: 200, msg: { pageData: [], total: 0 } };
      }
    } as unknown as UpstreamClient);

    await source.queryDailyActiveUsers({ pid: "PH", dateRange: ["2026-09-01", "2026-09-03"] });
    expect(capturedApi).toBe(P_DAY_SUM_API);
    expect(capturedParams).toEqual({
      page: "1",
      count: "500",
      pid: "PH",
      sumDateStart: "2026-09-01 00:00:00",
      sumDateEnd: "2026-09-03 23:59:59"
    });
  });

  test("只把 loginUserCount 映射为 M016，并按北京时间归一业务日", async () => {
    const source = sourceForRows([{
            pid: "PH",
            sumDate: "2026-09-01T16:00:00.000Z",
            loginUserCount: "21",
            registerUserCount: 999,
            newUserCount: 999,
            watchUserCount: 999,
            totalChargeUserCount: 999,
            diamondChargeAmt: 999,
            androidLoginUserCount: 999,
            iosLoginUserCount: 999,
            androidNewUserCount: 999,
            iosNewUserCount: 999,
            channelRegisterCount: 999,
            channelInternalRegisterCount: 999,
            totalClickedCount: 999,
            totalClickedPerson: 999,
            newUserTotalClickedCount: 999,
            newUserTotalClickedPerson: 999,
            newUserDiamondChargeAmt: 999,
            newUserChargeUserCount: 999,
            channelNewUserChargeAmt: 999,
            channelInternalNewUserChargeAmt: 999
          }], "1");
    const result = await source.queryDailyActiveUsers({
      pid: "PH",
      dateRange: ["2026-09-02", "2026-09-02"]
    });
    expect(result).toEqual({
      rows: [{ businessDate: "2026-09-02", pid: "PH", value: 21 }],
      watermark: null
    });
  });

  test("不会根据最大数据日期、总数或未确认字段推断可信水位", async () => {
    const source = new PDaySumM016Source({
      get: async () => ({
        code: 200,
        msg: {
          pageData: [{
            pid: "PH",
            sumDate: "2026-09-03",
            loginUserCount: 21,
            completeThrough: "2026-09-03"
          }],
          total: 1,
          completeThrough: "2026-09-03",
          observedAt: "2026-09-04T00:10:00+08:00"
        }
      })
    } as unknown as UpstreamClient);

    const result = await source.queryDailyActiveUsers({
      pid: "PH",
      dateRange: ["2026-09-01", "2026-09-03"]
    });
    expect(result.watermark).toBeNull();
  });

  test("空值与空白字符串保持 no_value，不制造真实 0", async () => {
    for (const loginUserCount of [null, undefined, "", "   "]) {
      const result = await sourceForRows([{ pid: "PH", sumDate: "2026-09-01", loginUserCount }])
        .queryDailyActiveUsers({ pid: "PH", dateRange: ["2026-09-01", "2026-09-01"] });
      expect(result.rows[0].value).toBeNull();
    }
  });

  test("损坏、非整数、负数与超出安全整数的值均拒绝", async () => {
    for (const loginUserCount of ["abc", "Infinity", Infinity, -1, 1.2, "9007199254740992"]) {
      await expect(sourceForRows([{ pid: "PH", sumDate: "2026-09-01", loginUserCount }])
        .queryDailyActiveUsers({ pid: "PH", dateRange: ["2026-09-01", "2026-09-01"] }))
        .rejects.toBeInstanceOf(M016SourceDataError);
    }
  });

  test("非法日期和带尾随内容的日期均拒绝", async () => {
    for (const sumDate of ["2026-09-01junk", "2026-02-30", "2026-09-01T25:00:00Z"]) {
      await expect(sourceForRows([{ pid: "PH", sumDate, loginUserCount: 1 }])
        .queryDailyActiveUsers({ pid: "PH", dateRange: ["2026-09-01", "2026-09-01"] }))
        .rejects.toBeInstanceOf(M016SourceDataError);
    }
  });

  test("分页 total 与首屏行数不一致时拒绝把截断误报为缺失", async () => {
    await expect(sourceForRows([{ pid: "PH", sumDate: "2026-09-01", loginUserCount: 1 }], 2)
      .queryDailyActiveUsers({ pid: "PH", dateRange: ["2026-09-01", "2026-09-01"] }))
      .rejects.toMatchObject({ reason: "truncated_page" } satisfies Partial<M016SourceDataError>);
  });

  test("total 小于实际行数时按损坏响应拒绝", async () => {
    await expect(sourceForRows([{ pid: "PH", sumDate: "2026-09-01", loginUserCount: 1 }], 0)
      .queryDailyActiveUsers({ pid: "PH", dateRange: ["2026-09-01", "2026-09-01"] }))
      .rejects.toMatchObject({ reason: "invalid_total" } satisfies Partial<M016SourceDataError>);
  });

  test("真实接口 totalCount 保留分页截断校验，不把总行数当作数据完整水位", async () => {
    for (const totalCount of [1, "1"]) {
      const source = new PDaySumM016Source({ get: async () => ({ code: 200, msg: {
        totalCount, pageData: [{ pid: "PH", sumDate: "2026-09-11", loginUserCount: 0 }]
      } }) } as unknown as UpstreamClient);
      expect(await source.queryDailyActiveUsers({ pid: "PH", dateRange: ["2026-09-11", "2026-09-11"] }))
        .toEqual({ rows: [{ pid: "PH", businessDate: "2026-09-11", value: 0 }], watermark: null });
    }
    for (const [totals, reason] of [
      [{ totalCount: 2 }, "truncated_page"],
      [{ totalCount: 0 }, "invalid_total"],
      [{ totalCount: 1, total: 2 }, "invalid_total"],
      [{ totalCount: true }, "invalid_total"],
      [{ totalCount: "invalid" }, "invalid_total"]
    ] as const) {
      const source = new PDaySumM016Source({ get: async () => ({ code: 200, msg: {
        ...totals, pageData: [{ pid: "PH", sumDate: "2026-09-11", loginUserCount: 1 }]
      } }) } as unknown as UpstreamClient);
      await expect(source.queryDailyActiveUsers({ pid: "PH", dateRange: ["2026-09-11", "2026-09-11"] }))
        .rejects.toMatchObject({ reason });
    }
  });
});
