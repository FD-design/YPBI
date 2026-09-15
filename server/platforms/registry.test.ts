import { describe, expect, test } from "bun:test";
import {
  enabledSecondaryPlatformPids,
  findEnabledPlatformByPid,
  parsePlatformCatalogFile,
  platformCatalogMetadata,
  platformRegistry,
  type PlatformDefinition
} from "./registry";

describe("platformRegistry", () => {
  test("从版本化目录加载 HX 正式表中的 20 个平台且关键字段唯一", () => {
    expect(platformCatalogMetadata).toEqual({
      schemaVersion: "platform-catalog/v1",
      revision: 1,
      updatedAt: "2026-09-08T20:04:26+08:00"
    });
    expect(platformRegistry).toHaveLength(20);
    expect(new Set(platformRegistry.map((item) => item.pid)).size).toBe(20);
    expect(new Set(platformRegistry.map((item) => item.id)).size).toBe(20);
    expect(new Set(platformRegistry.map((item) => item.order)).size).toBe(20);
    expect(platformRegistry.every((item) => item.id === item.hxId && item.siteId === item.upstreamSite)).toBe(true);
  });
  test("PH·Prem 与 Pornhub 使用不同 PID", () => {
    expect(platformRegistry.find((item) => item.name === "Pornhub")?.pid).toBe("PH");
    expect(platformRegistry.find((item) => item.name === "PH·Prem")?.pid).toBe("BZMH");
  });
  test("双后台归属与当前已复验路由保持一致", () => {
    expect(enabledSecondaryPlatformPids()).toEqual([
      "FBI", "BZMH", "TJS", "BPS", "HQW", "TJD", "MMV", "AF", "TFKJ", "JRTT", "YQ"
    ]);
    expect(platformRegistry.find((item) => item.pid === "PH")?.siteId).toBe("primary");
  });
  test("停用与未知 PID 都不会被解析为可查询平台", () => {
    const disabled = {
      ...platformRegistry[0],
      enabled: false
    } satisfies PlatformDefinition;
    expect(findEnabledPlatformByPid([disabled], disabled.pid)).toBeUndefined();
    expect(findEnabledPlatformByPid(platformRegistry, "UNKNOWN")).toBeUndefined();
  });
  test("启动解析拒绝重复 PID，避免目录歧义", () => {
    const items = platformRegistry.slice(0, 2).map(({ id, pid, name, siteId, enabled, order }) => ({
      id,
      pid: "PH",
      name,
      siteId,
      enabled,
      order
    }));
    expect(() => parsePlatformCatalogFile({
      schemaVersion: "platform-catalog/v1",
      revision: 1,
      updatedAt: "2026-09-08T20:04:26+08:00",
      items
    })).toThrow("平台目录 pid 不能重复：PH");
  });
});
