import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RequestFailureDetails } from "./StatePanel";

test("错误诊断只显示实际传入的代码与编号，缺少字段不造占位", () => {
  expect(renderToStaticMarkup(<RequestFailureDetails />)).toBe("");
  expect(renderToStaticMarkup(<RequestFailureDetails code="NETWORK_ERROR" />)).toBe("<small>错误代码：NETWORK_ERROR</small>");
  expect(renderToStaticMarkup(<RequestFailureDetails requestId="qa-request" />)).toBe("<small>请求编号：qa-request</small>");
  expect(renderToStaticMarkup(<RequestFailureDetails code="UPSTREAM_TIMEOUT" requestId="qa-timeout" />)).toContain("请求编号：qa-timeout");
});

test("错误诊断按普通文本转义，不执行返回字段的HTML", () => {
  const html = renderToStaticMarkup(<RequestFailureDetails code="<error>" requestId="<request>" />);
  expect(html).not.toContain("<error>");
  expect(html).toContain("&lt;error&gt;");
  expect(html).toContain("&lt;request&gt;");
});
