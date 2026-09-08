const V2_SEMANTIC_ROOTS = ["/dashboards", "/analysis", "/data", "/admin"] as const;

export function shouldUseV2Experience(location: Pick<Location, "pathname" | "search">) {
  if (location.pathname === "/") {
    return new URLSearchParams(location.search).get("experience") === "next";
  }
  return V2_SEMANTIC_ROOTS.some((root) => location.pathname === root || location.pathname.startsWith(`${root}/`));
}
