import type { AnalyticsQuery } from "../../contracts/analytics";
import { getPlatformByPid } from "../platforms/registry";
import type { OverviewAdapter } from "./overview.adapter";
import type { SpecialAdapter } from "./special.adapter";

export interface AcquisitionRow {
  date: string;
  platform: string;
  visits: number;
  downloads: number;
  newUsers: number;
}

export class AcquisitionAdapter {
  constructor(
    private readonly special: SpecialAdapter,
    private readonly overview: OverviewAdapter
  ) {}

  async query(query: AnalyticsQuery, platformId: string): Promise<AcquisitionRow[]> {
    const [cnzz, overviewRows] = await Promise.all([
      this.special.cnzz({ platformId, dateRange: query.dateRange, page: 1, pageSize: 500 }),
      this.overview.queryDaySum(query, platformId)
    ]);
    if (!cnzz.rows.length) return [];

    const newUsersByDate = new Map(overviewRows.map((row) => [row.date, row.newUsers ?? 0]));
    const grouped = new Map<string, { visits: number; downloads: number }>();
    cnzz.rows.forEach((row) => {
      const current = grouped.get(row.date) ?? { visits: 0, downloads: 0 };
      grouped.set(row.date, {
        visits: current.visits + row.visits,
        downloads: current.downloads + row.downloads
      });
    });
    const platform = getPlatformByPid(platformId)?.name ?? platformId;
    return [...grouped.entries()].map(([date, totals]) => ({
      date,
      platform,
      visits: totals.visits,
      downloads: totals.downloads,
      newUsers: newUsersByDate.get(date) ?? 0
    }));
  }
}
