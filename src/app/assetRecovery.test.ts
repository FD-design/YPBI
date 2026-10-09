import { describe, expect, test } from "bun:test";
import { createAssetRecovery, installBrowserAssetRecovery, isAssetLoadError, restoredRecoveryUrl } from "./assetRecovery";

const staleError = new TypeError("Failed to fetch dynamically imported module: https://bi.example/assets/ConnectedBoard-old.js");
const currentEntry = "https://bi.example/assets/index-old.js";
const latestEntry = "https://bi.example/assets/index-new.js";

function fixture() {
  const values = new Map<string, string>([["ypbi:data-environment:user", "test"]]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }
  };
  let href = "https://bi.example/dashboards/public?pid=PH&start=2026-10-01&label=a%20b&x=1&x=2#daily";
  let now = 1_000_000;
  let target: string | null = latestEntry;
  let reads = 0;
  const navigations: string[] = [];
  const environment = {
    entry: currentEntry as string | null,
    storage,
    href: () => href,
    latestEntry: async () => { reads++; return target; },
    replace: (url: string) => { navigations.push(url); },
    now: () => now
  };
  return {
    environment, values, navigations, storage,
    reads: () => reads,
    setHref: (value: string) => { href = value; },
    setTime: (value: number) => { now = value; },
    setTarget: (value: string | null) => { target = value; }
  };
}

describe("发布后资源版本恢复", () => {
  test("仅识别浏览器模块与 Vite CSS 加载错误，保留普通运行异常", () => {
    for (const message of [staleError.message, "error loading dynamically imported module: https://bi.example/assets/board.js", "Importing a module script failed.", "Unable to preload CSS for /assets/board-old.css"]) {
      expect(isAssetLoadError(new TypeError(message))).toBe(true);
    }
    for (const error of [new TypeError("Cannot read properties of undefined"), new SyntaxError("Unexpected token '<'"), new Error("Failed to fetch"), new Error("Module initialization failed"), staleError.message, null]) {
      expect(isAssetLoadError(error)).toBe(false);
    }
  });

  test("确认入口变化后只导航一次，保留原查询、hash 和测试会话", async () => {
    const f = fixture();
    const before = f.environment.href();
    const recover = createAssetRecovery(f.environment);
    expect(await recover(staleError)).toBe(true);
    expect(await recover(staleError)).toBe(true);
    expect(f.reads()).toBe(1);
    expect(f.navigations).toHaveLength(1);
    expect(f.navigations[0]).toContain("&__bi_asset_reload=");
    expect(restoredRecoveryUrl(f.navigations[0], f.storage)).toBe(before);
    expect(f.values.get("ypbi:data-environment:user")).toBe("test");
    expect(f.values.size).toBe(2);
  });

  test("并发的 preload 与错误边界共用同一次检查和导航", async () => {
    const f = fixture();
    let finish!: (value: string) => void;
    f.environment.latestEntry = () => new Promise<string>((resolve) => { finish = resolve; });
    const recover = createAssetRecovery(f.environment);
    const first = recover(staleError);
    const second = recover(staleError);
    expect(first).toBe(second);
    finish(latestEntry);
    expect(await first).toBe(true);
    expect(f.navigations).toHaveLength(1);
  });

  test("用户刷新可在自动检查无新版本后重新检查，同版本也只做一次绕缓存导航", async () => {
    const f = fixture();
    const before = f.environment.href();
    f.setTarget(currentEntry);
    const recover = createAssetRecovery(f.environment);
    expect(await recover(staleError)).toBe(false);
    expect(await recover(staleError, "manual")).toBe(true);
    expect(await recover(staleError, "manual")).toBe(true);
    expect(f.reads()).toBe(2);
    expect(f.navigations).toHaveLength(1);
    expect(f.navigations[0]).toContain("&__bi_asset_reload=");
    expect(restoredRecoveryUrl(f.navigations[0], f.storage)).toBe(before);
    expect(f.values.get("ypbi:data-environment:user")).toBe("test");
    expect(f.values.size).toBe(2);
  });

  test("用户刷新可重试冷却中的目标，但下一页仍禁止自动循环", async () => {
    const f = fixture();
    await createAssetRecovery(f.environment)(staleError);
    f.environment.entry = latestEntry;
    const recover = createAssetRecovery(f.environment);
    expect(await recover(staleError)).toBe(false);
    expect(await recover(staleError, "manual")).toBe(true);
    expect(await recover(staleError, "manual")).toBe(true);
    expect(f.navigations).toHaveLength(2);
    expect(f.navigations[1]).not.toBe(f.navigations[0]);
    expect(restoredRecoveryUrl(f.navigations[1], f.storage)).toBe(f.environment.href());
    expect(await createAssetRecovery(f.environment)(staleError)).toBe(false);
    expect(f.navigations).toHaveLength(2);
  });

  test("用户刷新与自动恢复重叠时共用检查且不重复导航", async () => {
    for (const manualFirst of [true, false]) {
      const f = fixture();
      let finish!: (value: string) => void;
      let reads = 0;
      f.environment.latestEntry = () => { reads++; return new Promise<string>((resolve) => { finish = resolve; }); };
      const recover = createAssetRecovery(f.environment);
      const first = recover(staleError, manualFirst ? "manual" : "automatic");
      const second = recover(staleError, manualFirst ? "automatic" : "manual");
      finish(latestEntry);
      expect(await first).toBe(true);
      expect(await second).toBe(true);
      expect(reads).toBe(1);
      expect(f.navigations).toHaveLength(1);
      expect(await recover(staleError, "manual")).toBe(true);
      expect(f.navigations).toHaveLength(1);
    }
  });

  test("HTML 没有新入口、获取失败或运行异常都不自动刷新", async () => {
    for (const target of [currentEntry, null]) {
      const f = fixture();
      f.setTarget(target);
      expect(await createAssetRecovery(f.environment)(staleError)).toBe(false);
      expect(f.navigations).toHaveLength(0);
    }
    const failed = fixture();
    failed.environment.latestEntry = async () => { throw new Error("offline"); };
    expect(await createAssetRecovery(failed.environment)(staleError)).toBe(false);
    const runtime = fixture();
    expect(await createAssetRecovery(runtime.environment)(new Error("render failed"))).toBe(false);
    expect(runtime.reads()).toBe(0);
    expect(runtime.navigations).toHaveLength(0);
  });

  test("用户刷新不把普通运行错误当资源错误，也不使用无法验证的入口", async () => {
    const runtime = fixture();
    expect(await createAssetRecovery(runtime.environment)(new Error("render failed"), "manual")).toBe(false);
    expect(runtime.reads()).toBe(0);
    expect(runtime.navigations).toHaveLength(0);
    for (const failure of ["empty", "offline"] as const) {
      const f = fixture();
      f.environment.latestEntry = async () => {
        if (failure === "offline") throw new Error("offline");
        return null;
      };
      expect(await createAssetRecovery(f.environment)(staleError, "manual")).toBe(false);
      expect(f.navigations).toHaveLength(0);
      expect(f.values.size).toBe(1);
    }
  });

  test("恢复后相同目标失败不会循环，跨版本冷却后可恢复下一次发布", async () => {
    const f = fixture();
    expect(await createAssetRecovery(f.environment)(staleError)).toBe(true);
    expect(await createAssetRecovery(f.environment)(staleError)).toBe(false);
    f.setTime(1_300_001);
    expect(await createAssetRecovery(f.environment)(staleError)).toBe(false);
    f.environment.entry = latestEntry;
    f.setTarget("https://bi.example/assets/index-next.js");
    expect(await createAssetRecovery(f.environment)(staleError)).toBe(true);
    expect(f.navigations).toHaveLength(2);
  });

  test("新加载入口仍缺文件时不因为原错误页面已消失而重复刷新", async () => {
    const f = fixture();
    await createAssetRecovery(f.environment)(staleError);
    f.environment.entry = latestEntry;
    f.setTime(1_300_001);
    expect(await createAssetRecovery(f.environment)(staleError)).toBe(false);
    expect(f.navigations).toHaveLength(1);
  });

  test("storage 不可读写时保留错误页，无法持久化重试保护时不自动刷新", async () => {
    for (const method of ["getItem", "setItem"] as const) {
      const f = fixture();
      f.storage[method] = () => { throw new Error("Storage blocked"); };
      expect(await createAssetRecovery(f.environment)(staleError)).toBe(false);
      expect(await createAssetRecovery(f.environment)(staleError, "manual")).toBe(false);
      expect(f.navigations).toHaveLength(0);
      expect(restoredRecoveryUrl(f.environment.href(), f.storage)).toBe(f.environment.href());
    }
    const f = fixture();
    f.storage.setItem = () => {};
    expect(await createAssetRecovery(f.environment)(staleError)).toBe(false);
    expect(f.navigations).toHaveLength(0);
  });

  test("清除自己的临时标记，保留同名业务参数、编码、重复参数和无查询深链", async () => {
    for (const href of ["https://bi.example/dashboards/public#daily", "https://bi.example/?__bi_asset_reload=business&label=a+b&x=%2F#daily"]) {
      const f = fixture();
      f.setHref(href);
      await createAssetRecovery(f.environment)(staleError);
      expect(restoredRecoveryUrl(f.navigations[0], f.storage)).toBe(href);
      expect(restoredRecoveryUrl(href, f.storage)).toBe(href);
    }
  });

  test("检查期间切换页面时恢复最新的查询和 hash", async () => {
    const f = fixture();
    f.environment.latestEntry = async () => {
      f.setHref("https://bi.example/dashboards/mine?pid=TT#payment");
      return latestEntry;
    };
    await createAssetRecovery(f.environment)(staleError);
    expect(restoredRecoveryUrl(f.navigations[0], f.storage)).toBe(f.environment.href());
  });

  test("无生产哈希入口时不触发恢复", async () => {
    const f = fixture();
    f.environment.entry = null;
    expect(await createAssetRecovery(f.environment)(staleError)).toBe(false);
    expect(f.reads()).toBe(0);
  });
});

async function withBrowserEnvironment(run: (f: ReturnType<typeof fixture>, browser: EventTarget, fetches: RequestInit[]) => Promise<void>, responseEntry = latestEntry, contentType = "text/html") {
  const f = fixture();
  const fetches: RequestInit[] = [];
  const browser = Object.assign(new EventTarget(), {
    location: { href: f.environment.href(), replace: f.environment.replace },
    history: { state: null, replaceState: () => {} },
    sessionStorage: f.storage
  });
  const moduleDocument = (entry: string) => ({ querySelectorAll: (selector: string) => {
    expect(selector).toBe('script[type="module"][src]');
    return [{ getAttribute: () => entry }];
  } });
  const globals = {
    window: browser,
    document: moduleDocument(currentEntry),
    DOMParser: class { parseFromString(source: string) { return moduleDocument(source); } },
    fetch: async (_href: string, init: RequestInit) => {
      fetches.push(init);
      return new Response(responseEntry, { headers: { "content-type": contentType } });
    }
  };
  const originals = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  try {
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    await run(f, browser, fetches);
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test("Vite 加载失败检查不使用缓存，保留原错误传播和同源凭据", async () => {
  await withBrowserEnvironment(async (f, browser, fetches) => {
    const recover = installBrowserAssetRecovery();
    const event = Object.assign(new Event("vite:preloadError", { cancelable: true }), { payload: staleError });
    browser.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(await recover(staleError)).toBe(true);
    expect(fetches).toHaveLength(1);
    expect(fetches[0].cache).toBe("no-store");
    expect(fetches[0].credentials).toBe("same-origin");
    expect(fetches[0].signal).toBeInstanceOf(AbortSignal);
    expect(f.navigations).toHaveLength(1);
  });
});

test("Vite 传递真实模块运行异常时不检查版本，也不阻止错误进入边界", async () => {
  await withBrowserEnvironment(async (f, browser, fetches) => {
    const recover = installBrowserAssetRecovery();
    const error = new ReferenceError("missingVariable is not defined");
    const event = Object.assign(new Event("vite:preloadError", { cancelable: true }), { payload: error });
    browser.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(await recover(error)).toBe(false);
    expect(fetches).toHaveLength(0);
    expect(f.navigations).toHaveLength(0);
  });
});

test("非 HTML 响应与跨域入口不能触发自动版本恢复", async () => {
  for (const [entry, contentType] of [[latestEntry, "application/json"], ["https://other.example/assets/index-new.js", "text/html"]]) {
    await withBrowserEnvironment(async (f) => {
      const recover = installBrowserAssetRecovery();
      expect(await recover(staleError)).toBe(false);
      expect(await recover(staleError, "manual")).toBe(false);
      expect(f.navigations).toHaveLength(0);
    }, entry, contentType);
  }
});

test("浏览器手动刷新使用同源无缓存版本检查，版本相同也添加恢复标记", async () => {
  await withBrowserEnvironment(async (f, _browser, fetches) => {
    const recover = installBrowserAssetRecovery();
    expect(await recover(staleError)).toBe(false);
    expect(await recover(staleError, "manual")).toBe(true);
    expect(fetches).toHaveLength(2);
    expect(fetches.every(request => request.cache === "no-store" && request.credentials === "same-origin")).toBe(true);
    expect(f.navigations).toHaveLength(1);
    expect(restoredRecoveryUrl(f.navigations[0], f.storage)).toBe(f.environment.href());
  }, currentEntry);
});
