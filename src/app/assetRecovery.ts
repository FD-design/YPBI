const STORAGE_KEY = "ypbi:asset-recovery";
const RELOAD_PARAMETER = "__bi_asset_reload";
const RELOAD_COOLDOWN_MS = 5 * 60_000;

interface RecoveryAttempt {
  target: string;
  at: number;
  token: string;
}

interface RecoveryEnvironment {
  entry: string | null;
  storage: Pick<Storage, "getItem" | "setItem">;
  href: () => string;
  latestEntry: (href: string) => Promise<string | null>;
  replace: (href: string) => void;
  now: () => number;
}

export function isAssetLoadError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("message" in error) || typeof error.message !== "string") return false;
  return /^(Failed to fetch dynamically imported module(?:\s*:|$)|error loading dynamically imported module(?:\s*:|\s+https?:|$)|Importing a module script failed\.?$|Unable to preload CSS for\s+\S+)/i.test(error.message);
}

function readAttempt(storage: RecoveryEnvironment["storage"]): RecoveryAttempt | null {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const attempt = JSON.parse(raw) as Partial<RecoveryAttempt> | null;
    return attempt && typeof attempt.target === "string" && typeof attempt.at === "number" && Number.isFinite(attempt.at)
      && typeof attempt.token === "string" && /^[a-z0-9]+$/.test(attempt.token) ? attempt as RecoveryAttempt : null;
  } catch {
    return null;
  }
}

function withReloadMarker(href: string, token: string): string {
  const hashAt = href.indexOf("#");
  const page = hashAt < 0 ? href : href.slice(0, hashAt);
  const hash = hashAt < 0 ? "" : href.slice(hashAt);
  return `${page}${page.includes("?") ? "&" : "?"}${RELOAD_PARAMETER}=${token}${hash}`;
}

export function restoredRecoveryUrl(href: string, storage: RecoveryEnvironment["storage"]): string {
  try {
    const attempt = readAttempt(storage);
    if (!attempt) return href;
    const hashAt = href.indexOf("#");
    const page = hashAt < 0 ? href : href.slice(0, hashAt);
    const hash = hashAt < 0 ? "" : href.slice(hashAt);
    const suffix = `${RELOAD_PARAMETER}=${attempt.token}`;
    if (page.endsWith(`&${suffix}`) || page.endsWith(`?${suffix}`)) return page.slice(0, -suffix.length - 1) + hash;
  } catch {
    // Storage may be unavailable; application startup must still proceed.
  }
  return href;
}

export function createAssetRecovery(environment: RecoveryEnvironment) {
  let pending: Promise<boolean> | undefined;
  return (error: unknown): Promise<boolean> => {
    if (!isAssetLoadError(error) || !environment.entry) return Promise.resolve(false);
    if (pending) return pending;
    pending = (async () => {
      try {
        const previous = readAttempt(environment.storage);
        if (previous && environment.now() - previous.at < RELOAD_COOLDOWN_MS) return false;
        const target = await environment.latestEntry(environment.href());
        if (!target || target === environment.entry || target === previous?.target) return false;
        const at = environment.now();
        const attempt: RecoveryAttempt = { target, at, token: at.toString(36) };
        environment.storage.setItem(STORAGE_KEY, JSON.stringify(attempt));
        if (environment.storage.getItem(STORAGE_KEY) !== JSON.stringify(attempt)) return false;
        environment.replace(withReloadMarker(environment.href(), attempt.token));
        return true;
      } catch {
        return false;
      }
    })();
    return pending;
  };
}

function documentEntry(document: Document, href: string): string | null {
  const scripts = document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]');
  if (scripts.length !== 1) return null;
  const entry = new URL(scripts[0].getAttribute("src")!, href);
  return entry.origin === new URL(href).origin && /\/assets\/[^/]+-[\w-]+\.js$/.test(entry.pathname) ? entry.href : null;
}

export function installBrowserAssetRecovery() {
  const storage = {
    getItem: (key: string) => window.sessionStorage.getItem(key),
    setItem: (key: string, value: string) => window.sessionStorage.setItem(key, value)
  };
  const href = restoredRecoveryUrl(window.location.href, storage);
  if (href !== window.location.href) window.history.replaceState(window.history.state, "", href);
  const recover = createAssetRecovery({
    entry: documentEntry(document, href),
    storage,
    href: () => window.location.href,
    latestEntry: async (currentHref) => {
      const response = await fetch(currentHref, { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(5_000) });
      if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) return null;
      return documentEntry(new DOMParser().parseFromString(await response.text(), "text/html"), currentHref);
    },
    replace: (nextHref) => window.location.replace(nextHref),
    now: Date.now
  });
  window.addEventListener("vite:preloadError", (event: Event & { payload?: unknown }) => {
    // Vite also reports module evaluation errors here; preserve its rejection for the error UI.
    void recover(event.payload);
  });
  return recover;
}
