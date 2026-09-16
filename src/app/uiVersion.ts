export type UiVersion = "classic" | "v13";

export function resolveUiVersion(search: string, configuredVersion?: string): UiVersion {
  const requested = new URLSearchParams(search).get("ui");
  if (requested === "classic" || requested === "v13") return requested;
  return configuredVersion === "classic" ? "classic" : "v13";
}

export function withUiVersion(path: string, version: UiVersion) {
  const url = new URL(path, "https://ypbi.local");
  url.searchParams.set("ui", version);
  return `${url.pathname}${url.search}`;
}
