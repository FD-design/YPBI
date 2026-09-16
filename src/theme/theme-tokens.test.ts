import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CHART_PALETTE } from "./tokens.ts";
import { changeDirection, changeValueHtml } from "../components/ui/change-presentation.ts";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

function cssToken(name: string) {
  const match = css.match(new RegExp(`--${name}:\\s*([^;]+);`));
  assert.ok(match, `tokens.css 缺少 --${name}`);
  return match[1].trim().toUpperCase();
}

test("ECharts Canvas 色板投影与 CSS 设计 Token 保持一致", () => {
  const cssPalette = CHART_PALETTE.map((_, index) => cssToken(`chart-series-${index + 1}`));
  assert.deepEqual([...CHART_PALETTE], cssPalette);
});

test("页面、表面和边框颜色只在 CSS 权威源中定义", () => {
  assert.equal(cssToken("color-page-bg"), "#F3F6FB");
  assert.equal(cssToken("color-surface"), "#FFFFFF");
  assert.equal(cssToken("color-border"), "#E1E6EE");
});

test("轻量动效只使用合成属性、共用时长且减少动态效果默认关闭", () => {
  const motion = readFileSync(new URL("../v2/motion.css", import.meta.url), "utf8");
  const loading = readFileSync(new URL("../components/ui/loading-indicator.css", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../v2/v2.css", import.meta.url), "utf8");
  const reduced = shell.slice(shell.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /animation: none !important/);
  assert.match(reduced, /transition: none !important/);
  assert.doesNotMatch(reduced, /(?:animation|transition)-duration:/);
  for (const source of [motion, loading]) {
    assert.match(source, /prefers-reduced-motion: no-preference/);
    assert.doesNotMatch(source, /transition:\s*all|will-change:|animation-fill-mode:|animation-delay:/);
    for (const frame of source.matchAll(/(?:from|to)\s*\{([^}]*)\}/g)) {
      const properties = frame[1].split(";").map(part => part.split(":")[0].trim()).filter(Boolean);
      assert.ok(properties.every(property => ["opacity", "transform"].includes(property)));
    }
  }
  assert.equal(cssToken("motion-fast"), "120MS");
  assert.equal(cssToken("motion-default"), "180MS");
  assert.equal(cssToken("motion-overlay"), "240MS");
  assert.equal(cssToken("motion-loading-cycle"), "900MS");
});

test("现代 UI 样式不绕过 Token 直接声明颜色", () => {
  const styleFiles = [
    new URL("../components/ui/primitives.css", import.meta.url),
    new URL("../v2/v2.css", import.meta.url),
    new URL("../v2/design/core-overview-design-fixture.css", import.meta.url),
    new URL("../v2/design/v1-chart-states-fixture.css", import.meta.url),
    new URL("../v2/features/dashboards/dashboard-metric-card.css", import.meta.url),
    new URL("../v2/features/dashboards/metric-summary.css", import.meta.url)
  ];
  for (const file of styleFiles) {
    const source = readFileSync(file, "utf8");
    const rawColors = source.match(/#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(/gi) ?? [];
    assert.deepEqual(rawColors, [], `${file.pathname} 必须使用 tokens.css 中的语义颜色`);
  }
});

test("单值摘要的主数值和辅助数值均显著大于指标名，单位采用小号正文", () => {
  const label = parseFloat(cssToken("font-size-metric-label"));
  for (const token of ["font-size-metric-value", "font-size-metric-supporting"]) {
    assert.ok(parseFloat(cssToken(token)) >= label * 1.8);
  }
  assert.ok(parseFloat(cssToken("font-size-body-sm")) < label);
  assert.equal(parseFloat(cssToken("font-size-metric-comparison")), 11);
  assert.ok(parseFloat(cssToken("font-size-metric-comparison")) < parseFloat(cssToken("font-size-body-sm")));
});

test("涨跌色在白色卡片与深色提示上均满足正文对比度，未知不伪造方向", () => {
  const luminance = (hex: string) => {
    const channels = hex.slice(1).match(/../g)!.map((part) => parseInt(part, 16) / 255)
      .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  for (const direction of ["up", "down", "flat"]) {
    for (const [suffix, background] of [["", "color-surface"], ["-on-emphasis", "chart-tooltip-bg"]]) {
      const values = [luminance(cssToken(`color-change-${direction}${suffix}`)), luminance(cssToken(background))].sort((a, b) => b - a);
      assert.ok((values[0] + 0.05) / (values[1] + 0.05) >= 4.5, `${direction}${suffix} 需要可读对比度`);
    }
  }
  assert.equal(changeDirection(0), "flat");
  assert.equal(changeDirection(-0), "flat");
  assert.equal(changeDirection(-1), "down");
  assert.equal(changeDirection(1), "up");
  for (const value of [null, undefined, NaN, Infinity, -Infinity]) assert.equal(changeDirection(value), null);
  assert.doesNotMatch(changeValueHtml(1, '<img src=x onerror="alert(1)">'), /<img/);
});
