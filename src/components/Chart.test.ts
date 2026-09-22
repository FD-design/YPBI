import { describe, expect, test } from "bun:test";
import { axisSeriesTooltip, chartTooltipPosition, escapeChartTooltipText, sanitizeChartTooltipHtml, secureChartTooltipFormatter, secureChartTooltipStringFormatter } from "./Chart";
import { groupedTrendTooltip } from "./chart-tooltip-content";
import { changeValueHtml } from "./ui/change-presentation";

describe("Chart tooltip text", () => {
  test("宽提示在窄屏、滚动后的图表和屏幕边缘保持视口内", () => {
    for (const bounds of [{ left: 13, top: 388 }, { left: 300, top: -150 }]) {
      for (const point of [[0, 0], [130, 160], [350, 270]]) {
        const position = chartTooltipPosition(point, [320, 336], bounds, [390, 1000]);
        expect(position[0] + bounds.left).toBeGreaterThanOrEqual(16);
        expect(position[0] + bounds.left + 320).toBeLessThanOrEqual(374);
        expect(position[1] + bounds.top).toBeGreaterThanOrEqual(16);
        expect(position[1] + bounds.top + 336).toBeLessThanOrEqual(984);
      }
    }
    expect(chartTooltipPosition([200, 100], [320, 336], { left: 100, top: 100 }, [1280, 1000])).toEqual([212, 112]);
  });
  test("同日分类提示按图例顺序排列，格式化内容、名称和颜色均安全", () => {
    const input = [{ seriesIndex: 1, seriesName: "渠道 B", value: 500, color: "#12abef", name: "2026-09-08" }, { seriesIndex: 0, seriesName: '<img src=x>', value: 0, color: 'red;position:fixed', name: "2026-09-08" }];
    const html = axisSeriesTooltip(input, { order: "seriesAsc", valueFormatter: value => `${value} 人 <script>` });
    expect(html.indexOf("&lt;img")).toBeLessThan(html.indexOf("渠道 B"));
    expect(html).toContain("0 人 &lt;script&gt;");
    expect(html).toContain("background:#12abef");
    expect(html).not.toContain("position:fixed");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(input[0].seriesName).toBe("渠道 B");
  });

  test("分组提示突出当前日期和总体，当前组列对齐且对比期独立分区", () => {
    const html = secureChartTooltipFormatter(() => groupedTrendTooltip({
      date: "2026-09-08",
      overall: { value: "100 次", state: "完整" },
      groups: [
        { label: "Android · 新用户", value: "0 次", share: 0, state: "完整", color: "#285fe8" },
        { label: "iOS · 老用户", value: "未产出", state: "未产出", color: "#007a8a" }
      ],
      comparison: {
        date: "2026-09-01",
        overall: { value: "92 次" },
        groups: [
          { label: "Android · 新用户", value: "8 次", color: "#285fe8" },
          { label: "iOS · 老用户", value: "84 次", color: "#007a8a" }
        ]
      }
    }))();
    expect(html).toContain('<div class="grouped-trend-tooltip">');
    expect(html).toContain("2026-09-08");
    expect(html).toContain("总体</span><b>100 次</b>");
    expect(html).toContain("0 次");
    expect(html).toContain("占总体 0.00%");
    expect(html.indexOf("Android · 新用户")).toBeLessThan(html.indexOf("iOS · 老用户"));
    expect(html).toContain('<section class="grouped-trend-tooltip__comparison">');
    expect(html).toContain("2026-09-01");
    expect(html.match(/未产出/g)).toHaveLength(1);
    expect(html).not.toContain("完整");
  });

  test("分组提示只放行共享渲染器生成的结构，动态文字转义且非法颜色回退", () => {
    const html = secureChartTooltipFormatter(() => groupedTrendTooltip({
      date: '<img src=x onerror="alert(1)">',
      groups: [{ label: '渠道"><script>alert(1)</script>', value: '8 次 <b>伪值</b>', color: "red;position:fixed", state: '<svg onload="alert(1)">' }]
    }))();
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;伪值&lt;/b&gt;");
    expect(html).toContain("background:#4f7cff");
    expect(html).not.toContain("position:fixed");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(secureChartTooltipFormatter(() => ({ html: '<img src=x onerror="alert(1)">' }))()).not.toContain("<img");
  });
  test("转义上游名称中的 HTML 与属性边界字符", () => {
    expect(escapeChartTooltipText('<img src=x onerror="alert(1)">\'&')).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&amp;"
    );
  });

  test("自定义 tooltip 不执行任意 HTML", () => {
    expect(sanitizeChartTooltipHtml('<img src=x onerror="alert(1)">名称<br/>数值')).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;名称<br/>数值"
    );
    expect(sanitizeChartTooltipHtml("名称<br class=x>数值")).toBe("名称&lt;br class=x&gt;数值");
  });

  test("共享涨跌标记经过真实净化链后保留颜色且不会双重转义", () => {
    for (const value of [1, -1, 0, null]) {
      const markup = changeValueHtml(value, '2,170 人 & <img onerror="alert(1)">');
      expect(secureChartTooltipFormatter(() => markup)()).toBe(markup);
    }
    for (const unsafe of [
      '<span data-change-direction="up" style="color:red">123</span>',
      '<span data-change-direction="up" style="color:var(--color-change-up-on-emphasis)" onclick="alert(1)">123</span>',
      '<span data-change-direction="up" style="color:var(--color-change-down-on-emphasis)">123</span>'
    ]) expect(sanitizeChartTooltipHtml(unsafe)).not.toContain("<span");
  });

  test("同步自定义 formatter 的真实返回路径会经过净化", () => {
    const formatter = secureChartTooltipFormatter(() => '<svg onload="alert(1)"></svg><br>安全行');
    expect(formatter()).toBe("&lt;svg onload=&quot;alert(1)&quot;&gt;&lt;/svg&gt;<br/>安全行");
  });

  test("异步 formatter callback 的 HTML 同样经过净化", () => {
    let rendered = "";
    const formatter = secureChartTooltipFormatter((_params, ticket, callback) => {
      callback(ticket, '<img src=x onerror="alert(1)"><br/>结果');
    });
    formatter([], "ticket-1", (_ticket: string, value: string) => { rendered = value; });
    expect(rendered).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;<br/>结果");
  });

  test("字符串 tooltip 模板不会在净化后再由 ECharts 注入运行时字段", () => {
    const formatter = secureChartTooltipStringFormatter('<img src=x onerror="alert(1)">{b}<br>结果');
    expect(formatter()).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;{b}<br/>结果");
  });
});
