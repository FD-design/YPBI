export function shouldUseV2Experience(
  location: Pick<Location, "pathname" | "search">,
  options: { allowClassic: boolean } = { allowClassic: false }
) {
  const explicitlyClassic = location.pathname === "/" && new URLSearchParams(location.search).get("ui") === "v13";
  return !(options.allowClassic && explicitlyClassic);
}
