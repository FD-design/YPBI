import { expect, test } from "bun:test";
import { readWatchAttemptDay } from "./watch-daily.adapter";

const date = "2026-09-12";
const buckets = () => Array.from({ length: 288 }, (_, index) => ({ pid: "PH", sumDate: new Date(Date.parse(date + "T00:00:00+08:00") + index * 300000).toISOString(),
  graphDate: `${String(Math.floor(index / 12)).padStart(2, "0")}:${String(index % 12 * 5).padStart(2, "0")}`, watchCount: 3 as unknown }));
const read = (rows: unknown[]) => readWatchAttemptDay({ get: async (_path, params) => {
  expect(params).toEqual({ pid: "PH", startDate: date + " 00:00:00", endDate: date + " 23:59:59" });
  return { msg: rows };
} }, "PH", date);

test("完整五分钟桶可无序累计，零次数和整数字符串保持有效", async () => {
  expect(await read(buckets().reverse())).toEqual({ state: "available", value: 864 });
  expect(await read(buckets().map(row => ({ ...row, watchCount: "0" })))).toEqual({ state: "available", value: 0 });
});
test("空日与缺桶保持不同，部分桶不推算完整日", async () => {
  expect(await read([])).toEqual({ state: "no_record", value: null });
  expect(await read(buckets().slice(1))).toEqual({ state: "no_value", value: null });
});
test("错平台、跨日、重复桶、非五分钟点、标签冲突与超量拒绝", async () => {
  for (const changes of [{ pid: "FBI" }, { sumDate: "2026-09-12T16:00:00Z" }, { sumDate: "2026-09-11T16:01:00Z" }, { graphDate: "00:05" }]) {
    const rows = buckets(); rows[0] = { ...rows[0], ...changes };
    await expect(read(rows)).rejects.toMatchObject({ code: "DAILY_SOURCE_CONFLICT" });
  }
  const rows = buckets(); rows[1] = { ...rows[0] };
  await expect(read(rows)).rejects.toMatchObject({ code: "DAILY_SOURCE_CONFLICT" });
  await expect(read([...buckets(), buckets()[0]])).rejects.toMatchObject({ code: "DAILY_SOURCE_CONFLICT" });
});
test("缺次数不补零，非法计数或累计溢出不产出值", async () => {
  for (const raw of [undefined, null, " "]) {
    const rows = buckets(); rows[0].watchCount = raw;
    expect(await read(rows)).toEqual({ state: "no_value", value: null });
  }
  for (const raw of [-1, 1.5, false, "1e3", Number.MAX_SAFE_INTEGER]) {
    const rows = buckets(); rows[0].watchCount = raw;
    expect(await read(rows)).toEqual({ state: "invalid_value", value: null });
  }
});
