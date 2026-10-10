import { expect, test } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardActions, DashboardQueryFields } from "./DashboardToolbar";
import { LiveDashboardContext, type LiveDashboardReading } from "./LiveDashboardContext";

function reading(retry: () => void, apply = () => {}): LiveDashboardReading {
  return {
    query: { boardId: "5.8", pid: "PH", dateRange: ["2026-07-01", "2026-07-01"] },
    metricIds: ["M020"], state: { status: "loading" }, platformName: "隔离测试", canExport: false, retry,
    controls: { date: null, scope: null, comparison: null, dirty: false, acceptsSharedRange: () => true, apply, export() {} }
  };
}

function captureAction() {
  let click: (() => void) | undefined;
  function SingleChild({ children }: { children: ReactNode }) {
    expect(Array.isArray(children)).toBe(false);
    expect(isValidElement(children)).toBe(true);
    return children;
  }
  function ButtonCapture({ children }: { children: ReactElement<{ onClick?: () => void }> }) {
    expect(Array.isArray(children)).toBe(false);
    expect(children.type).toBe("button");
    click = children.props.onClick;
    return null;
  }
  return {
    node: (onClick?: () => void) => <SingleChild><ButtonCapture><button onClick={onClick}>操作</button></ButtonCapture></SingleChild>,
    click: () => { expect(click).toBeFunction(); click!(); }
  };
}

test("正式刷新穿过单子元素包装，只执行一次真实重试且不触发演示回调", () => {
  const calls: string[] = [], action = captureAction();
  renderToStaticMarkup(<LiveDashboardContext.Provider value={reading(() => calls.push("retry"))}>
    <DashboardActions refresh={action.node(() => calls.push("demo"))} />
  </LiveDashboardContext.Provider>);
  action.click();
  expect(calls).toEqual(["retry"]);
});

test("正式应用保留原条件同步，再执行真实应用", () => {
  const calls: string[] = [], action = captureAction();
  renderToStaticMarkup(<LiveDashboardContext.Provider value={reading(() => {}, () => calls.push("apply"))}>
    <DashboardQueryFields date={null} apply={action.node(() => calls.push("sync"))} />
  </LiveDashboardContext.Provider>);
  action.click();
  expect(calls).toEqual(["sync", "apply"]);
});

test("没有真实读取上下文时保留演示刷新", () => {
  const calls: string[] = [], action = captureAction();
  renderToStaticMarkup(<LiveDashboardContext.Provider value={null}>
    <DashboardActions refresh={action.node(() => calls.push("demo"))} />
  </LiveDashboardContext.Provider>);
  action.click();
  expect(calls).toEqual(["demo"]);
});

test("无原回调的原生按钮仍绑定正式重试", () => {
  const calls: string[] = [], action = captureAction();
  renderToStaticMarkup(<LiveDashboardContext.Provider value={reading(() => calls.push("retry"))}>
    <DashboardActions refresh={action.node()} />
  </LiveDashboardContext.Provider>);
  action.click();
  expect(calls).toEqual(["retry"]);
});
