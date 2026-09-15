import { describe, expect, test } from "bun:test";
import { readableWatchDuration } from "./watch-duration-presentation";

describe("观影时长直观读法只转换单位", () => {
  test("分钟转分秒，进位与小时保留", () => {
    expect(readableWatchDuration(12.5, "分钟")).toBe("12分 30秒");
    expect(readableWatchDuration(59.999, "分钟")).toBe("1小时");
    expect(readableWatchDuration(1.5, "小时")).toBe("1小时 30分");
    expect(readableWatchDuration(59.9, "秒")).toBe("1分");
  });
  test("真实0可读，无效或未知单位不生成时长", () => {
    expect(readableWatchDuration(0, "分钟")).toBe("0秒");
    for (const value of [-1, NaN, Infinity, Number.MAX_VALUE]) expect(readableWatchDuration(value, "分钟")).toBeNull();
    expect(readableWatchDuration(50, "人")).toBeNull();
  });
  test("人均时长转换保留每人分母，不扩大其他单位能力", () => {
    expect(readableWatchDuration(12.5, "分钟/人")).toBe("12分 30秒/人");
    expect(readableWatchDuration(30, "分钟/人")).toBe("30分/人");
    expect(readableWatchDuration(0, "分钟/人")).toBe("0秒/人");
    expect(readableWatchDuration(1.5, "小时/人")).toBe("1小时 30分/人");
    expect(readableWatchDuration(90, "秒/人")).toBe("1分 30秒/人");
    expect(readableWatchDuration(30, "分钟/次")).toBeNull();
  });
});
