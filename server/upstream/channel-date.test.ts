import { describe, expect, test } from "bun:test";
import { legacyChannelDateParams } from "./channel-date";

describe("legacyChannelDateParams", () => {
  test.each([
    ["同日", "2026-10-12", "2026-10-12", "2026-10-13"],
    ["多日区间", "2026-10-10", "2026-10-12", "2026-10-13"],
    ["月底", "2026-09-30", "2026-09-30", "2026-10-01"],
    ["年末", "2026-12-31", "2026-12-31", "2027-01-01"],
    ["闰日前一天", "2024-02-28", "2024-02-28", "2024-02-29"],
    ["闰日", "2024-02-29", "2024-02-29", "2024-03-01"],
    ["平年二月末", "2026-02-28", "2026-02-28", "2026-03-01"],
    ["跨月区间", "2024-02-28", "2024-03-01", "2024-03-02"]
  ])("%s以所选末日次日零点作为排他结束边界", (_label, start, end, nextDay) => {
    const dateRange: [string, string] = [start!, end!];
    expect(legacyChannelDateParams(dateRange)).toEqual({
      sumDateBegin: `${start} 00:00:00`,
      sumDateEnd: `${nextDay} 00:00:00`
    });
    expect(dateRange).toEqual([start, end]);
  });
});
