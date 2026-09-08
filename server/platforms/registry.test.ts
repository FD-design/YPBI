import { describe, expect, test } from "bun:test";
import { enabledSecondaryPlatformPids, platformRegistry } from "./registry";

describe("platformRegistry", () => {
  test("包含 HX 正式表中的 20 个平台且 PID 唯一", () => {
    expect(platformRegistry).toHaveLength(20);
    expect(new Set(platformRegistry.map((item) => item.pid)).size).toBe(20);
    expect(new Set(platformRegistry.map((item) => item.hxId)).size).toBe(20);
  });
  test("PH·Prem 与 Pornhub 使用不同 PID", () => {
    expect(platformRegistry.find((item) => item.name === "Pornhub")?.pid).toBe("PH");
    expect(platformRegistry.find((item) => item.name === "PH·Prem")?.pid).toBe("BZMH");
  });
  test("双后台归属与当前已复验路由保持一致", () => {
    expect(enabledSecondaryPlatformPids()).toEqual([
      "FBI", "BZMH", "TJS", "BPS", "HQW", "TJD", "MMV", "AF", "TFKJ", "JRTT", "YQ"
    ]);
    expect(platformRegistry.find((item) => item.pid === "PH")?.upstreamSite).toBe("primary");
  });
});
