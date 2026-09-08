import { describe, expect, test } from "bun:test";
import { escapeChartTooltipText, sanitizeChartTooltipHtml, secureChartTooltipFormatter, secureChartTooltipStringFormatter } from "./Chart";

describe("Chart tooltip text", () => {
  test("转义上游名称中的 HTML 与属性边界字符", () => {
    expect(escapeChartTooltipText('<img src=x onerror="alert(1)">\'&')).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&amp;"
    );
  });

  test("自定义 tooltip 只保留换行标记，不执行任意 HTML", () => {
    expect(sanitizeChartTooltipHtml('<img src=x onerror="alert(1)">名称<br/>数值')).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;名称<br/>数值"
    );
    expect(sanitizeChartTooltipHtml("名称<br class=x>数值")).toBe("名称&lt;br class=x&gt;数值");
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
