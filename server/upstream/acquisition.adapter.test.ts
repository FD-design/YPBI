import { describe, expect, test } from "bun:test";
import { AcquisitionAdapter } from "./acquisition.adapter";

const query = {
  modelId: "acquisition_conversion", analysisType: "table", metricIds: ["visits"], dimensionIds: ["date", "platform"],
  eventIds: [], platformMode: "single", platformIds: ["PH"], dateRange: ["2026-07-14", "2026-07-15"] as [string, string],
  filters: {}, limit: 50
} as const;

describe("AcquisitionAdapter", () => {
  test("按平台日期合并渠道访问下载并关联新增用户", async () => {
    const special = { cnzz: async () => ({ total: 2, rows: [
      { date: "2026-07-14", platformId: "PH", channel: "A", visits: 100, downloads: 20 },
      { date: "2026-07-14", platformId: "PH", channel: "B", visits: 50, downloads: 10 }
    ] }) } as any;
    const overview = { queryDaySum: async () => [{ date: "2026-07-14", platform: "Pornhub", newUsers: 24 }] } as any;
    const rows = await new AcquisitionAdapter(special, overview).query(query as any, "PH");
    expect(rows).toEqual([{ date: "2026-07-14", platform: "Pornhub", visits: 150, downloads: 30, newUsers: 24 }]);
  });

  test("CNZZ没有记录时返回空数组而不是伪造0", async () => {
    const special = { cnzz: async () => ({ total: 0, rows: [] }) } as any;
    const overview = { queryDaySum: async () => [{ date: "2026-07-14", platform: "Pornhub", newUsers: 24 }] } as any;
    expect(await new AcquisitionAdapter(special, overview).query(query as any, "PH")).toEqual([]);
  });
});
