import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppErrorBoundary, AppFailure } from "./AppErrorBoundary";

test("启动模块与看板懒加载失败沿用可操作的资源错误页", () => {
  const error = new TypeError("Failed to fetch dynamically imported module: /assets/ConnectedBoard-old.js");
  const startupHtml = renderToStaticMarkup(<AppFailure error={error} />);
  const boundary = new AppErrorBoundary({ children: <div>看板</div>, recover: async () => false });
  boundary.state = AppErrorBoundary.getDerivedStateFromError(error);
  expect(renderToStaticMarkup(boundary.render())).toBe(startupHtml);
  expect(startupHtml).toContain('role="alert"');
  expect(startupHtml).toContain("页面资源加载失败");
  expect(startupHtml).toContain("刷新页面");
});

test("真实运行错误仍显示渲染异常，正常内容完整保留", () => {
  const html = renderToStaticMarkup(<AppFailure error={new TypeError("Cannot read properties of undefined")} />);
  expect(html).toContain("前端渲染发生异常");
  expect(html).not.toContain("页面资源加载失败");
  expect(renderToStaticMarkup(<AppErrorBoundary recover={async () => false}><div>看板查询内容</div></AppErrorBoundary>)).toBe("<div>看板查询内容</div>");
});
