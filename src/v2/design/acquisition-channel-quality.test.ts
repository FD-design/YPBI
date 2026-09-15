import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEFAULT_ACQUISITION_FILTERS, acquisitionCards, acquisitionDates } from "./acquisition-preview-model";
import { acquisitionWorkbook } from "./acquisition-export";
import { acquisitionViewHref, DEFAULT_ACQUISITION_VIEW, readAcquisitionView, parseAcquisitionView } from "./acquisition-view-state";
import { CHANNEL_QUALITY_GROUPS, CHANNEL_QUALITY_IDS, channelQualityChange, channelQualityFixtures, channelQualityRows, channelQualitySheets, channelQualityUnit, channelQualityValue, distinctChannelIps, filterChannelQualityRows, readChannelQuality } from "./acquisition-channel-quality";

test("唯一渠道质量表的四组复用正式指标；注册当日价值不伪装LTV", () => {
  expect(CHANNEL_QUALITY_GROUPS.map(group => group.value)).toEqual(["scale", "experience", "retention", "value"]);
  expect(new Set(CHANNEL_QUALITY_IDS).size).toBe(CHANNEL_QUALITY_IDS.length);
  expect(CHANNEL_QUALITY_GROUPS[3].scope).toContain("注册当日");
  const rows = channelQualityRows(DEFAULT_ACQUISITION_FILTERS);
  expect(rows.map(row => row.name)).toEqual(["推广渠道 A", "推广渠道 B", "合作渠道 C", "直接访问", "未归类"]);
  for (const row of rows) for (const id of CHANNEL_QUALITY_IDS) {
    const reading = row.metrics[id].current;
    expect(reading.scope).toContain("演示数据");
    expect(row.metrics[id].previous).toBeUndefined();
    if (reading.basis && reading.value !== null) expect(reading.value).toBeCloseTo(reading.basis.numerator.value! / reading.basis.denominator.value!, 10);
  }
  expect(channelQualityUnit("M058")).toBe("USD");
  expect(channelQualityUnit("M088")).toBe("USD/人");
});

test("规模与首屏计数一致；比例来自真实合成输入而不是平均日率", () => {
  for (const range of [{ start: "2026-09-03", end: "2026-09-03" }, { start: "2026-09-02", end: "2026-09-08" }, { start: "2026-08-01", end: "2026-08-31" }]) {
    const filters = { ...DEFAULT_ACQUISITION_FILTERS, ...range }, rows = channelQualityRows(filters), cards = acquisitionCards(false, false, [], filters);
    for (const id of ["M001", "M003", "M008"]) {
      const result = cards.find(card => card.model.metric.id === id)!.model.result;
      if (result.status !== "available") throw Error("expected fixture");
      expect(rows.reduce((sum, row) => sum + row.metrics[id].current.value!, 0)).toBe(result.value.raw);
    }
    for (const row of rows) expect(row.metrics.M005.current.value).toBe(row.metrics.M003.current.value! / row.metrics.M001.current.value!);
  }
  const fact = channelQualityFixtures({ start: "2026-08-01", end: "2026-08-01" })[0];
  const facts = [{ ...fact, registered: 10, effectiveUsers: 9 }, { ...fact, date: "2026-08-02", registered: 100, effectiveUsers: 10 }];
  expect(readChannelQuality("M037", facts).value).toBe(19 / 110);
  const ratio = readChannelQuality("M033", facts);
  expect(ratio.basis?.denominator.name).toBe("首次体验启动成功用户数");
  expect(ratio.basis?.denominator.value).toBe(fact.launchUsers * 2);
});

test("区间IP去重使用成员并集，IP·天累计保持独立", () => {
  expect(distinctChannelIps([[0, 10], [5, 20], [22, 25]])).toBe(23);
  const fact = channelQualityFixtures({ start: "2026-08-01", end: "2026-08-01" })[0];
  const facts = [{ ...fact, visitIp: [0, 20] as const, downloadIp: [0, 5] as const }, { ...fact, date: "2026-08-02", visitIp: [0, 20] as const, downloadIp: [0, 5] as const }];
  expect(readChannelQuality("M099", facts).basis?.denominator.value).toBe(20);
  expect(readChannelQuality("M006", facts).basis?.denominator.value).toBe(10);
  expect(readChannelQuality("M007", facts).basis?.denominator.value).toBe(40);
});

test("留存成熟批次过滤分子与分母，当前与对比采用可观察位置", () => {
  const rows = channelQualityRows({ ...DEFAULT_ACQUISITION_FILTERS, comparison: "previous" });
  for (const row of rows) {
    expect(row.metrics.M020.current.mature).toBe(6);
    expect(row.metrics.M020.current.batches).toBe(7);
    expect(row.metrics.M020.previous?.mature).toBe(6);
    expect(row.metrics.M020.previous?.scope).toContain("2026-08-26 至 2026-08-31");
    expect(row.metrics.M021.current.mature).toBe(4);
    expect(row.metrics.M022.current.value).toBeNull();
    expect(row.metrics.M022.current.status).toBe("未成熟");
    expect(row.metrics.M022.previous?.value).toBeNull();
    expect(row.metrics.M020.current.basis?.denominator.value).toBe(row.facts.slice(0, 6).reduce((sum, fact) => sum + fact.registered, 0));
  }
  const long = channelQualityRows({ ...DEFAULT_ACQUISITION_FILTERS, start: "2026-08-01", comparison: "previous" });
  expect(long[0].metrics.M023.current.mature).toBe(9);
  expect(long[0].metrics.M023.previous?.mature).toBe(9);
});

test("真实0、缺失、未成熟和0分母分离；收入与人数独立计算", () => {
  const fact = channelQualityFixtures({ start: "2026-08-01", end: "2026-08-01" })[0];
  expect(readChannelQuality("M037", [{ ...fact, effectiveUsers: 0 }]).value).toBe(0);
  expect(readChannelQuality("M037", [{ ...fact, effectiveUsers: null }]).status).toBe("缺失");
  expect(readChannelQuality("M037", [{ ...fact, registered: 0, effectiveUsers: 0 }]).status).toBe("分母为0");
  expect(readChannelQuality("M033", [{ ...fact, experienceClosed: false }]).status).toBe("未成熟");
  expect(readChannelQuality("M067", [{ ...fact, amountCents: 0, paidUsers: 0 }]).value).toBeNull();
  const facts = [{ ...fact, registered: 10, paidUsers: 1, amountCents: 10000 }, { ...fact, date: "2026-08-02", registered: 20, paidUsers: 3, amountCents: 30000 }];
  expect(readChannelQuality("M088", facts).value).toBe(400 / 30);
  expect(readChannelQuality("M067", facts).value).toBe(100);
  expect(readChannelQuality("M064", facts).value).toBe(4 / 30);
  expect(channelQualityChange("M020", .3, .2)?.label).toBe("+10.00 个百分点");
  expect(channelQualityChange("M058", 20, 0)).toBeNull();
  expect(channelQualityValue("M058", 0)).toBe("0 USD");
  const mixed = channelQualityRows(DEFAULT_ACQUISITION_FILTERS, true);
  expect(mixed.at(-1)!.metrics.M037.current.value).toBeNull();
  expect(mixed.at(-1)!.metrics.M099.current.value).toBeNull();
  expect(mixed.at(-1)!.metrics.M006.current.value).not.toBeNull();
  expect(mixed[0].metrics.M037.current.value).not.toBeNull();
});

test("搜索排序和局部阅读状态可恢复，非法指标组失败关闭", () => {
  const rows = channelQualityRows(DEFAULT_ACQUISITION_FILTERS);
  expect(filterChannelQualityRows(rows, "推广", "M008", true)).toHaveLength(2);
  expect(filterChannelQualityRows(rows, "不存在", "M008", true)).toHaveLength(0);
  const sorted = filterChannelQualityRows(rows, "", "M020", false);
  expect(sorted[0].metrics.M020.current.value!).toBeLessThanOrEqual(sorted.at(-1)!.metrics.M020.current.value!);
  const view = { ...DEFAULT_ACQUISITION_VIEW, detail: { ...DEFAULT_ACQUISITION_VIEW.detail, sections: { ...DEFAULT_ACQUISITION_VIEW.detail.sections, channel: { ...DEFAULT_ACQUISITION_VIEW.detail.sections.channel, qualityGroup: "retention", sort: { id: "M022", descending: false }, search: "推广" } } } };
  expect(readAcquisitionView(new URL(acquisitionViewHref(view), "http://localhost").search)).toEqual(view);
  expect(parseAcquisitionView(JSON.stringify({ ...view, detail: { ...view.detail, sections: { ...view.detail.sections, channel: { ...view.detail.sections.channel, qualityGroup: "unknown" } } } }))).toBeNull();
});

test("完整导出只有一张渠道表，保留全部指标与未成熟日；逐行不复制公式", () => {
  const filters = { ...DEFAULT_ACQUISITION_FILTERS, comparison: "previous" };
  const sheets = channelQualitySheets(filters), all = acquisitionWorkbook(filters, false, []);
  expect(sheets[0].rows).toHaveLength(1 + 5 * CHANNEL_QUALITY_IDS.length);
  expect(sheets[1].rows).toHaveLength(1 + 5 * CHANNEL_QUALITY_IDS.length * acquisitionDates(filters).length * 2);
  expect(sheets[1].rows.flat()).toContain("未成熟");
  expect(sheets[0].rows[0]).not.toContain("公式");
  expect(sheets[0].rows[0]).toContain("对比分母值");
  expect(sheets[1].rows[0]).toContain("分母单位");
  expect(sheets[0].rows.every(row => row.length === sheets[0].rows[0].length)).toBe(true);
  expect(sheets[1].rows.every(row => row.length === sheets[1].rows[0].length)).toBe(true);
  expect(sheets[1].rows[0]).not.toContain("公式");
  expect(all.filter(sheet => sheet.name.includes("来源渠道"))).toHaveLength(1);
  expect(all.some(sheet => sheet.name.includes("渠道结算"))).toBe(true);
  expect(all.some(sheet => sheet.name.includes("下载目标"))).toBe(true);
  expect(all.some(sheet => sheet.name.includes("获客类型"))).toBe(true);
  expect(() => channelQualityRows({ ...filters, channel: "a" })).toThrow();
});

test("只在原来源渠道表增强；真实类型分支、首屏六卡和原定位保留", () => {
  const page = readFileSync(new URL("./AcquisitionPreview.tsx", import.meta.url), "utf8");
  const visuals = readFileSync(new URL("./AcquisitionVisuals.tsx", import.meta.url), "utf8");
  const model = readFileSync(new URL("./acquisition-channel-quality.ts", import.meta.url), "utf8");
  expect(page.match(/<ChannelQuality /g)).toHaveLength(1);
  expect(page).toContain('const channelQuality = dimension === "channel"');
  expect(page).toContain('{section("channel")}{section("target")}{section("type")}');
  expect(page).toContain('dimension==="type"');
  expect(page).toContain('renderCards(ACQUISITION_IDS.slice(0, 6))');
  expect(visuals).not.toContain('label="落地页趋势指标"');
  expect(visuals).toContain('onLocate("channel")');
  expect(visuals).toContain('onLocate("target")');
  expect(model).not.toMatch(/useLiveDashboard|fetch\(|localStorage|sessionStorage/);
});
