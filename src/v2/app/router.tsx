import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";

export const NAVIGATION_EVENT = "ypbi-v2:navigation";

export interface BrowserLocationSnapshot {
  pathname: string;
  search: string;
  hash: string;
  key: string;
}

function currentSnapshot(): BrowserLocationSnapshot {
  const { pathname, search, hash } = window.location;
  return { pathname, search, hash, key: `${pathname}${search}${hash}` };
}

let cachedSnapshot = currentSnapshot();

function getSnapshot() {
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (cachedSnapshot.key !== current) cachedSnapshot = currentSnapshot();
  return cachedSnapshot;
}

function subscribe(onStoreChange: () => void) {
  window.addEventListener("popstate", onStoreChange);
  window.addEventListener(NAVIGATION_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("popstate", onStoreChange);
    window.removeEventListener(NAVIGATION_EVENT, onStoreChange);
  };
}

export function useBrowserLocation() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function navigate(to: string, options: { replace?: boolean; preserveScroll?: boolean; historyState?: unknown } = {}) {
  const target = new URL(to, window.location.origin);
  if (target.origin !== window.location.origin) {
    window.location.assign(target.href);
    return;
  }
  const next = `${target.pathname}${target.search}${target.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) return;
  if (options.replace) window.history.replaceState(options.historyState ?? null, "", next);
  else window.history.pushState(options.historyState ?? null, "", next);
  if (!options.preserveScroll) window.scrollTo({ top: 0, left: 0 });
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

export function ProductLink({ href, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || props.target === "_blank") return;
    const target = new URL(href, window.location.origin);
    if (target.origin !== window.location.origin) return;
    event.preventDefault();
    navigate(`${target.pathname}${target.search}${target.hash}`);
  };
  return <a {...props} href={href} onClick={handleClick} />;
}
