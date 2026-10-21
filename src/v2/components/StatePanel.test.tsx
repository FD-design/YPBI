import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RequestFailureDetails, ResourceFailurePanel } from "./StatePanel";
import type { V2RequestDiagnostics } from "../api/client";

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

test("上游业务码和HTTP分别显示，不从BI状态推算缺失字段", () => {
  const html = renderToStaticMarkup(<ResourceFailurePanel state={{ status: "failure", kind: "error",
    code: "QUERY_JOB_UPSTREAM_REJECTED", message: "查询未受理", requestId: "qa-request",
    upstreamBusinessCode: 400, upstreamHttpStatus: 200 }} onRetry={() => {}} />);
  expect(html).toContain("上游业务码：400");
  expect(html).toContain("上游 HTTP：200");
  expect(html).not.toContain("上游 HTTP：400");
  expect(renderToStaticMarkup(<RequestFailureDetails code="QUERY_JOB_UPSTREAM_REJECTED" />)).not.toContain("上游");
  expect(renderToStaticMarkup(<RequestFailureDetails upstreamBusinessCode={0} />)).toBe("<small>上游业务码：0</small>");
});

test("诊断展示拒绝非法数值且不读取额外原始错误字段", () => {
  const invalid = { upstreamBusinessCode: "400", upstreamHttpStatus: 99, message: "raw-source-error", headers: "secret" };
  expect(renderToStaticMarkup(<RequestFailureDetails {...invalid as unknown as V2RequestDiagnostics} />)).toBe("");
  expect(renderToStaticMarkup(<RequestFailureDetails upstreamBusinessCode={NaN} upstreamHttpStatus={200.5} />)).toBe("");
});
