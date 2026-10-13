import { expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  collectDashboardSections, dashboardSectionMutationRelevant, scrollToDashboardSection,
  DashboardSectionNavigation, DashboardSectionNavigationControls
} from "./DashboardSectionNavigation";

class ElementStub {
  nodeType = 1;
  parentElement: ElementStub | null = null;
  children: ElementStub[] = [];
  attributes = new Map<string, string>();
  style = { display: "block", visibility: "visible" };
  isConnected = true;
  scrolls: ScrollIntoViewOptions[] = [];
  focusOptions: FocusOptions[] = [];
  listeners = new Map<string, () => void>();
  scans = 0;
  ownerDocument = { defaultView: { getComputedStyle: (element: ElementStub) => element.style } };
  constructor(public tagName: string, public classes = "", public textContent = "") {}
  get hidden() { return this.hasAttribute("hidden"); }
  hasAttribute(name: string) { return this.attributes.has(name); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  matches(selectors: string): boolean {
    return selectors.split(",").some(selector => {
      if (selector.startsWith(".")) return this.classes.split(" ").includes(selector.slice(1));
      if (selector === '[role="dialog"]') return this.getAttribute("role") === "dialog";
      return this.tagName === selector.toUpperCase();
    });
  }
  closest(selectors: string): ElementStub | null {
    return this.matches(selectors) ? this : this.parentElement?.closest(selectors) ?? null;
  }
  querySelectorAll(selectors: string): ElementStub[] {
    this.scans++;
    return this.children.flatMap(child => [...(child.matches(selectors) ? [child] : []), ...child.querySelectorAll(selectors)]);
  }
  querySelector(selectors: string) { return this.querySelectorAll(selectors)[0] ?? null; }
  contains(element: ElementStub): boolean { return element === this || this.children.some(child => child.contains(element)); }
  append(...elements: ElementStub[]) {
    for (const element of elements) { element.parentElement = this; this.children.push(element); }
    return this;
  }
  scrollIntoView(options: ScrollIntoViewOptions) { this.scrolls.push(options); }
  focus(options: FocusOptions) { this.focusOptions.push(options); }
  addEventListener(name: string, callback: () => void) { this.listeners.set(name, callback); }
  removeEventListener(name: string, callback: () => void) { if (this.listeners.get(name) === callback) this.listeners.delete(name); }
}
const html = (element: ElementStub) => element as unknown as HTMLElement;
const title = (text: string, panel = false) => new ElementStub("H2", panel ? "dashboard-panel__title" : "dashboard-section-title", text);
const section = (text: string) => new ElementStub("SECTION").append(title(text));
const mutation = (type: MutationRecordType, target: ElementStub, addedNodes: ElementStub[] = [], removedNodes: ElementStub[] = []) =>
  ({ type, target: html(target), addedNodes, removedNodes } as unknown as MutationRecord);

test("清单读取实际主标题的DOM顺序并排除嵌套重复区块", () => {
  const first = section(" 第一块 \n 主结果 "), nested = new ElementStub("ARTICLE").append(title("内部图表", true));
  first.append(nested);
  const page = new ElementStub("DIV", "v2-page").append(first, new ElementStub("ARTICLE").append(title("第二块", true)), section("第三块"));
  const result = collectDashboardSections(html(page));
  expect(result.map(item => item.label)).toEqual(["第一块 主结果", "第二块", "第三块"]);
  expect(result[0].element).toBe(html(first.children[0]));
  first.children[0].textContent = "改名后的主结果";
  expect(collectDashboardSections(html(page))[0].label).toBe("改名后的主结果");
});

test("卡片、dialog、关闭details和各类隐藏祖先不进入主要区块清单", () => {
  const page = new ElementStub("DIV", "v2-page").append(section("可见"));
  for (const wrapper of [new ElementStub("DIV", "dashboard-metric-card"), new ElementStub("DIALOG"), new ElementStub("DIV"),
    new ElementStub("DETAILS"), new ElementStub("DIV"), new ElementStub("DIV"), new ElementStub("DIV"), new ElementStub("DIV"), new ElementStub("DIV")]) {
    page.append(wrapper.append(section("排除")));
  }
  page.children[3].setAttribute("role", "dialog");
  page.children[5].setAttribute("hidden", "");
  page.children[6].setAttribute("aria-hidden", "true");
  page.children[7].setAttribute("inert", "");
  page.children[8].style.display = "none";
  page.children[9].style.visibility = "hidden";
  expect(collectDashboardSections(html(page)).map(item => item.label)).toEqual(["可见"]);
  page.children[4].setAttribute("open", "");
  expect(collectDashboardSections(html(page)).map(item => item.label)).toEqual(["可见", "排除"]);
});

test("仅标题与区块结构变化触发重扫，数值文本与表格行更新不触发", () => {
  const region = section("结果"), heading = region.children[0], cell = new ElementStub("TD", "", "12");
  region.append(new ElementStub("TABLE").append(cell));
  expect(dashboardSectionMutationRelevant(mutation("characterData", heading))).toBe(true);
  expect(dashboardSectionMutationRelevant(mutation("childList", region, [section("新块")]))).toBe(true);
  expect(dashboardSectionMutationRelevant(mutation("childList", region, [], [section("旧块")]))).toBe(true);
  expect(dashboardSectionMutationRelevant(mutation("attributes", region))).toBe(true);
  expect(dashboardSectionMutationRelevant(mutation("characterData", cell))).toBe(false);
  expect(dashboardSectionMutationRelevant(mutation("childList", cell, [new ElementStub("SPAN", "", "13")]))).toBe(false);
  expect(dashboardSectionMutationRelevant(mutation("attributes", cell))).toBe(false);
  const dialog = new ElementStub("DIALOG").append(title("详情"));
  expect(dashboardSectionMutationRelevant(mutation("childList", dialog, [section("详情内部块")]))).toBe(false);
  heading.classes = "";
  expect(dashboardSectionMutationRelevant(mutation("attributes", heading), [{ label: "结果", element: html(heading) }])).toBe(true);
});

test("定位尊重减少动态效果并恢复临时焦点属性，不触碰现有tabindex", () => {
  const heading = title("主结果"), cleanup = scrollToDashboardSection(html(heading), true);
  expect(heading.scrolls).toEqual([{ block: "start", inline: "nearest", behavior: "instant" }]);
  expect(heading.focusOptions).toEqual([{ preventScroll: true }]);
  expect(heading.getAttribute("tabindex")).toBe("-1");
  heading.listeners.get("blur")!();
  expect(heading.hasAttribute("tabindex")).toBe(false);
  expect(heading.listeners.size).toBe(0);
  cleanup();
  heading.setAttribute("tabindex", "0");
  scrollToDashboardSection(html(heading), false)();
  expect(heading.scrolls.at(-1)?.behavior).toBe("smooth");
  expect(heading.getAttribute("tabindex")).toBe("0");
  heading.isConnected = false;
  scrollToDashboardSection(html(heading), false)();
  expect(heading.scrolls).toHaveLength(2);
});

const items = ["主结果", "效率与留存", "经营明细"].map((label, i) => ({ id: `section-${i}`, label }));
test("不足三个主区块无导航，桌面使用文字按钮且不写链接", () => {
  const render = (values: typeof items) => renderToStaticMarkup(React.createElement(DashboardSectionNavigationControls, { items: values, mobile: false, value: "", onNavigate() {} }));
  expect(render(items.slice(0, 2))).toBe("");
  const markup = render(items);
  expect(markup.match(/<button /g)).toHaveLength(3);
  expect(markup).toContain('aria-label="本页区块"');
  expect(markup).toContain('dashboard-section-navigation__label">定位区块');
  expect(markup).toContain("ui-button--ghost ui-button--sm");
  expect(markup).not.toContain("href=");
  expect(markup).not.toContain("ui-menu-select");
});

test("手机仅复用MenuSelect并从同一清单显示所选区块", () => {
  const markup = renderToStaticMarkup(React.createElement(DashboardSectionNavigationControls, { items, mobile: true, value: items[2].id, onNavigate() {} }));
  expect(markup.match(/<button /g)).toHaveLength(1);
  expect(markup).toContain("ui-menu-select--compact");
  expect(markup).toContain("定位区块：经营明细");
  expect(markup).not.toContain("ui-button--ghost");
});

test("SSR无挂载页面时不生成猜测的区块或浏览器依赖", () => {
  expect(renderToStaticMarkup(React.createElement(DashboardSectionNavigation, { headerRef: { current: null } }))).toBe("");
});

test("观察器合并标题更新，MenuSelect焦点恢复后再定位，卸载完整清理", () => {
  const page = new ElementStub("DIV", "v2-page"), header = new ElementStub("HEADER"), first = section("第一块");
  page.append(header, first, section("第二块"), section("第三块"));
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>(), mediaListeners = new Set<() => void>();
  const view = { getComputedStyle: (element: ElementStub) => element.style,
    requestAnimationFrame(callback: FrameRequestCallback) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
    matchMedia: () => ({ matches: false, addEventListener: (_: string, callback: () => void) => mediaListeners.add(callback), removeEventListener: (_: string, callback: () => void) => mediaListeners.delete(callback) }) };
  for (const element of [page, header, ...page.querySelectorAll("section,article,.dashboard-section-title")]) element.ownerDocument = { defaultView: view };
  let notify!: MutationCallback, disconnected = false, options: MutationObserverInit | undefined;
  const priorObserver = globalThis.MutationObserver;
  globalThis.MutationObserver = class {
    constructor(callback: MutationCallback) { notify = callback; }
    observe(_: Node, next: MutationObserverInit) { options = next; }
    disconnect() { disconnected = true; }
  } as unknown as typeof MutationObserver;
  const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const priorDispatcher = internals.H, effects: (() => (() => void) | void)[] = [];
  const next = () => { const current = [...frames]; frames.clear(); current.forEach(([, callback]) => callback(0)); };
  let cleanup: (() => void) | void;
  try {
    internals.H = { useState: (initial: unknown) => [initial, () => {}], useRef: (current: unknown) => ({ current }), useEffect: (effect: () => (() => void) | void) => effects.push(effect) };
    const rendered = DashboardSectionNavigation({ headerRef: { current: html(header) } });
    internals.H = priorDispatcher;
    cleanup = effects[0]();
    const initialScans = page.scans;
    notify([mutation("characterData", new ElementStub("TD", "", "1"))], {} as MutationObserver);
    expect(frames.size).toBe(0);
    first.children[0].textContent = "新标题";
    notify([mutation("characterData", first.children[0]), mutation("characterData", first.children[0])], {} as MutationObserver);
    expect(frames.size).toBe(1);
    next();
    expect(page.scans).toBe(initialScans + 1);
    rendered.props.onNavigate("section-0");
    next(); // Shared menu's trigger restoration can run in this frame.
    expect(first.children[0].scrolls).toHaveLength(0);
    next();
    expect(first.children[0].scrolls).toHaveLength(1);
    expect(first.children[0].getAttribute("tabindex")).toBe("-1");
    rendered.props.onNavigate("section-1");
    expect(frames.size).toBe(1);
    cleanup?.();
    cleanup = undefined;
    expect(disconnected).toBe(true);
    expect(mediaListeners.size).toBe(0);
    expect(frames.size).toBe(0);
    expect(first.children[0].hasAttribute("tabindex")).toBe(false);
    expect(options?.attributeFilter).toEqual(["hidden", "aria-hidden", "inert", "open", "class", "style"]);
  } finally {
    cleanup?.();
    internals.H = priorDispatcher;
    globalThis.MutationObserver = priorObserver;
  }
});
