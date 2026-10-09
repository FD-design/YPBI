import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { verifyStaticDelivery } from "./verify-static-delivery.mjs";

const html = '<!doctype html><script type="module" src="/assets/index-current.js"></script><link rel="stylesheet" href="/assets/index-current.css">';
function fixture({ cacheControl = "no-cache", missingStatus = 404, assetHtml = false, entryMismatch = false } = {}) {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    const missing = url.pathname.includes("__ypbi_missing");
    if (missing && missingStatus === 404) return new Response("Not found", { status: 404 });
    const asset = url.pathname.startsWith("/assets/") && !missing && !assetHtml;
    return new Response(asset ? "/* asset */" : entryMismatch && url.pathname === "/admin/data-sources" ? html.replace("index-current.js", "index-stale.js") : html, {
      status: 200,
      headers: { "content-type": asset ? url.pathname.endsWith(".css") ? "text/css" : "text/javascript" : "text/html; charset=utf-8", "cache-control": cacheControl, etag: '"test"' }
    });
  };
  return { request, calls };
}

test("checks root, deep links, entry, CSS and missing asset without credentials or redirects", async () => {
  const f = fixture();
  const result = await verifyStaticDelivery("https://bi.example", f.request);
  assert.equal(result.passed, true);
  assert.equal(result.results.length, 6);
  assert.ok(f.calls.every(({ options }) => options.credentials === "omit" && options.redirect === "error" && options.cache === "no-store" && !options.headers));
  assert.ok(f.calls.every(({ url }) => url.origin === "https://bi.example" && !url.pathname.startsWith("/api/")));
});

test("rejects absent/long HTML caching, SPA fallback for missing assets, HTML scripts and inconsistent entries", async () => {
  for (const options of [{ cacheControl: "" }, { cacheControl: "public, max-age=86400" }, { missingStatus: 200 }, { assetHtml: true }, { entryMismatch: true }]) {
    assert.equal((await verifyStaticDelivery("https://bi.example", fixture(options).request)).passed, false, JSON.stringify(options));
  }
  assert.equal((await verifyStaticDelivery("https://bi.example", fixture({ cacheControl: "no-store" }).request)).passed, true);
});

test("unavailable pages fail closed and credential-bearing origins are refused before a request", async () => {
  assert.equal((await verifyStaticDelivery("https://bi.example", async () => { throw new Error("offline"); })).passed, false);
  for (const url of ["https://user:secret@bi.example", "https://bi.example/?token=secret", "file:///tmp/"]) {
    await assert.rejects(verifyStaticDelivery(url, () => { throw new Error("must not request"); }), /Provide an HTTP/);
  }
});

test("candidate Caddy routes isolate assets from SPA fallback and revalidate page responses", async () => {
  const config = await readFile(new URL("../deploy/config-driven-bi-Caddyfile", import.meta.url), "utf8");
  const assets = config.match(/handle \/assets\/\* \{([\s\S]*?)\n    \}/)?.[1];
  assert.ok(assets);
  assert.match(assets, /file_server/);
  assert.doesNotMatch(assets, /try_files|rewrite/);
  const fallback = config.match(/handle \{([\s\S]*?)\n    \}/)?.[1];
  assert.match(fallback, /header Cache-Control "no-cache"/);
  assert.match(fallback, /try_files \{path\} \/index\.html/);
});
