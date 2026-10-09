import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppErrorBoundary, AppFailure } from "./AppErrorBoundary";
import { createAssetRecovery, type AssetRecovery } from "../app/assetRecovery";

test("启动模块与看板懒加载失败沿用可操作的资源错误页", () => {
  const error = new TypeError("Failed to fetch dynamically imported module: /assets/ConnectedBoard-old.js");
  const recover: AssetRecovery = async () => false;
  const startupHtml = renderToStaticMarkup(<AppFailure error={error} recover={recover} />);
  const boundary = new AppErrorBoundary({ children: <div>看板</div>, recover });
  boundary.state = AppErrorBoundary.getDerivedStateFromError(error);
  expect(renderToStaticMarkup(boundary.render())).toBe(startupHtml);
  expect(startupHtml).toContain('role="alert"');
  expect(startupHtml).toContain("页面资源加载失败");
  expect(startupHtml).toContain("刷新页面");
  expect((boundary.render() as ReturnType<typeof AppFailure>).props.recover).toBe(recover);
});

test("真实运行错误仍显示渲染异常，正常内容完整保留", () => {
  const html = renderToStaticMarkup(<AppFailure error={new TypeError("Cannot read properties of undefined")} recover={async () => false} />);
  expect(html).toContain("前端渲染发生异常");
  expect(html).not.toContain("页面资源加载失败");
  expect(renderToStaticMarkup(<AppErrorBoundary recover={async () => false}><div>看板查询内容</div></AppErrorBoundary>)).toBe("<div>看板查询内容</div>");
});

test("错误页按钮调用手动资源恢复，成功导航不再执行普通 reload", async () => {
  const calls: unknown[][] = [];
  const error = new TypeError("Failed to fetch dynamically imported module: /assets/ConnectedBoard-old.js");
  const shell = AppFailure({ error, recover: async (...args) => { calls.push(args); return true; } });
  await shell.props.children.props.children[2].props.onClick();
  expect(calls).toEqual([[error, "manual"]]);
});

test("普通错误与无法恢复的资源错误只在用户点击时执行普通刷新", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let reloads = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { reload: () => { reloads++; } } } });
  try {
    for (const message of ["Cannot read properties of undefined", "Failed to fetch dynamically imported module: /assets/board-old.js"]) {
      let reads = 0;
      const recover = createAssetRecovery({
        entry: "https://bi.example/assets/index-old.js",
        href: () => "https://bi.example/dashboards/public?pid=PH#daily",
        storage: { getItem: () => null, setItem: () => {} },
        latestEntry: async () => { reads++; return null; },
        replace: () => { throw new Error("No verified asset entry"); },
        now: () => 1_000_000
      });
      const before = reloads;
      const error = new TypeError(message);
      expect(await recover(error)).toBe(false);
      const shell = AppFailure({ error, recover });
      expect(reloads).toBe(before);
      await shell.props.children.props.children[2].props.onClick();
      expect(reloads).toBe(before + 1);
      expect(reads).toBe(message.startsWith("Cannot") ? 0 : 2);
    }
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
