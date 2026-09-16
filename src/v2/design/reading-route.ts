/** Local authenticated readers retain their route when exercising an existing demo module. */
export function preserveAuthenticatedReadingRoute(previewHref: string) {
  if (typeof window === "undefined") return previewHref;
  const current = new URL(window.location.href);
  if (current.pathname !== "/dashboards/public" || current.searchParams.has("design")) return previewHref;
  const next = new URL(previewHref, current.origin);
  if (next.pathname !== "/dashboards/public") return previewHref;
  current.searchParams.delete("design");
  for (const key of ["board", "view"]) { const value = next.searchParams.get(key); if (value) current.searchParams.set(key, value); }
  return current.pathname + current.search;
}
