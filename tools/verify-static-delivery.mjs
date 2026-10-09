import { pathToFileURL } from "node:url";

const pages = ["/", "/admin/data-sources", "/dashboards/public?board=5.2&pid=PH&start=2020-01-01&end=2020-01-01"];
const missingAsset = "/assets/__ypbi_missing_static_probe__.js";

export async function verifyStaticDelivery(baseUrl, request = fetch) {
  const base = new URL(baseUrl);
  if (!/^https?:$/.test(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new Error("Provide an HTTP(S) origin without credentials, path, query or hash.");
  }
  const results = [];
  const failures = [];
  const assets = new Set();
  let expectedEntry;
  async function read(path) {
    const response = await request(new URL(path, base), { cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(5_000) });
    const body = await response.text();
    const result = { path, status: response.status, contentType: response.headers.get("content-type") ?? "", cacheControl: response.headers.get("cache-control") ?? "", etag: response.headers.get("etag") ?? "" };
    results.push(result);
    return { ...result, body };
  }
  for (const path of pages) {
    try {
      const response = await read(path);
      if (response.status !== 200 || !/^text\/html(?:;|$)/i.test(response.contentType)) failures.push(`${path}: expected HTTP 200 text/html`);
      if (!/(?:^|,)\s*(?:no-cache|no-store)\s*(?:,|$)/i.test(response.cacheControl)) failures.push(`${path}: HTML must revalidate (Cache-Control: no-cache or no-store)`);
      const scripts = [...response.body.matchAll(/<script\b[^>]*>/gi)]
        .filter(([tag]) => /\btype\s*=\s*["']module["']/i.test(tag))
        .map(([tag]) => tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1]).filter(Boolean);
      if (scripts.length !== 1) failures.push(`${path}: expected one production module entry`);
      if (expectedEntry && scripts[0] !== expectedEntry) failures.push(`${path}: HTML entry differs from root`);
      expectedEntry ??= scripts[0];
      const styles = [...response.body.matchAll(/<link\b[^>]*>/gi)]
        .filter(([tag]) => /\brel\s*=\s*["'](?:stylesheet|modulepreload)["']/i.test(tag))
        .map(([tag]) => tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1]).filter(Boolean);
      for (const source of [...scripts, ...styles]) {
        const asset = new URL(source, base);
        if (asset.origin !== base.origin || !/^\/assets\/[^/]+-[\w-]+\.(?:js|css)$/.test(asset.pathname) || asset.search || asset.hash) {
          failures.push(`${path}: asset must be a same-origin hashed JS/CSS path`);
        } else assets.add(asset.pathname);
      }
    } catch { failures.push(`${path}: request failed`); }
  }
  for (const path of assets) {
    try {
      const response = await read(path);
      const contentType = path.endsWith(".css") ? /^text\/css(?:;|$)/i : /^(?:text|application)\/javascript(?:;|$)/i;
      if (response.status !== 200 || !contentType.test(response.contentType) || /^\s*(?:<!doctype\s+html|<html)/i.test(response.body)) {
        failures.push(`${path}: expected HTTP 200 with matching asset content type, not HTML`);
      }
    } catch { failures.push(`${path}: request failed`); }
  }
  try {
    const response = await read(missingAsset);
    if (response.status !== 404) failures.push(`${missingAsset}: expected HTTP 404, not SPA fallback`);
  } catch { failures.push(`${missingAsset}: request failed`); }
  return { passed: failures.length === 0, results, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await verifyStaticDelivery(process.argv[2]);
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
