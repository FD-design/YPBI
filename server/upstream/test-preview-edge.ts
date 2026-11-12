const edgeDenialCodes = [1006, 1007, 1008, 1009, 1010, 1012, 1020, 1106] as const;
const cloudflareRayPattern = /^[0-9A-Fa-f]{16}-[A-Z]{3}$/;
const maxErrorBodyBytes = 8 * 1024;
const errorBodyTimeoutMs = 500;
const maxAppErrorMessages = 8;
const maxAppErrorMessageLength = 1024;

type EdgeDenialCode = typeof edgeDenialCodes[number];

export type TestPreviewDeniedResponse =
  | { readonly kind: "cloudflare_edge"; readonly code: EdgeDenialCode; readonly rayId: string }
  | { readonly kind: "upstream_auth" | "upstream_ip_restricted"; readonly code: 2002; readonly rayId?: string }
  | { readonly kind: "unclassified"; readonly rayId?: string; readonly denialTemplate?: "nginx_default_403" };

async function readBoundedText(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<string | undefined> {
  const reader = body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  let finished = false;
  try {
    signal.addEventListener("abort", cancel, { once: true });
    const bytes = new Uint8Array(maxErrorBodyBytes);
    let size = 0;
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (signal.aborted) return;
      if (done) {
        finished = true;
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
      }
      if (size + value.byteLength > bytes.byteLength) return;
      bytes.set(value, size);
      size += value.byteLength;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!finished) cancel();
    reader.releaseLock();
  }
}

function readCloudflareRayId(headers: Headers) {
  if (headers.get("server")?.toLowerCase() !== "cloudflare") return;
  const rayId = headers.get("cf-ray");
  if (rayId && cloudflareRayPattern.test(rayId)) return rayId;
}

function collectElementText(rewriter: HTMLRewriter, selector: string) {
  const texts: string[] = [];
  rewriter.on(selector, {
    element() { texts.push(""); },
    text(chunk) {
      const index = texts.length - 1;
      texts[index] += chunk.text;
    }
  });
  return texts;
}

function normalizeHtmlText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function readCloudflareHtmlCode(html: string, rayId: string, responseUrl: string): EdgeDenialCode | undefined {
  // Remove inert and raw-text content before collecting visible template fields.
  const visibleHtml = new HTMLRewriter()
    .on("script, style, template, noscript, textarea", { element(element) { element.remove(); } })
    .transform(html);
  const rewriter = new HTMLRewriter();
  const titles = collectElementText(rewriter, "title");
  const wrappers = collectElementText(rewriter, "#cf-wrapper");
  const details = collectElementText(rewriter, "#cf-wrapper #cf-error-details");
  const headings = collectElementText(rewriter, "h1");
  const detailHeadings = collectElementText(rewriter, "#cf-wrapper #cf-error-details h1");
  const subtitles = collectElementText(rewriter, "#cf-wrapper #cf-error-details h2");
  const footers = collectElementText(rewriter, "#cf-wrapper .cf-error-footer, #cf-wrapper #cf-error-footer");
  const footerEmphasis: string[] = [];
  let rayFollowsLabel = false;
  rewriter.on("#cf-wrapper .cf-error-footer strong, #cf-wrapper #cf-error-footer strong", {
    element() {
      footerEmphasis.push("");
      rayFollowsLabel = normalizeHtmlText(footers.at(-1) ?? "").endsWith("Cloudflare Ray ID:");
    },
    text(chunk) {
      footerEmphasis[footerEmphasis.length - 1] += chunk.text;
    }
  });
  rewriter.transform(visibleHtml);

  if (wrappers.length !== 1 || details.length !== 1 || titles.length !== 1 || headings.length !== 1
    || detailHeadings.length !== 1 || footers.length !== 1
    || subtitles.filter(text => normalizeHtmlText(text) === "Access denied").length !== 1) return;

  const title = /^Access denied \| ([A-Za-z0-9.-]{1,253}) used Cloudflare to restrict access \| \1 \| Cloudflare$/
    .exec(normalizeHtmlText(titles[0]));
  if (!title || (responseUrl && new URL(responseUrl).hostname !== title[1].toLowerCase())) return;

  const heading = /^Error ([0-9]{4})$/.exec(normalizeHtmlText(detailHeadings[0]));
  const code = edgeDenialCodes.find(candidate => String(candidate) === heading?.[1]);
  if (code === undefined) return;

  const footer = normalizeHtmlText(footers[0]);
  const labeledRay = /(?:^|\s)Cloudflare Ray ID: ([0-9A-Fa-f]{16})(?=$|[^0-9A-Za-z])/.exec(footer);
  const expectedRay = rayId.slice(0, 16).toLowerCase();
  if (footer.match(/Cloudflare Ray ID:/g)?.length !== 1 || footerEmphasis.length !== 1 || !rayFollowsLabel
    || labeledRay?.[1].toLowerCase() !== expectedRay || normalizeHtmlText(footerEmphasis[0]).toLowerCase() !== expectedRay) return;
  return code;
}

function isAppErrorMessage(value: unknown): value is string {
  return typeof value === "string" && value.length <= maxAppErrorMessageLength && value.trim().length > 0;
}

function isNginxForbiddenPage(html: string): boolean {
  const page = html.trim().replace(/>\s+</g, "><");
  const prefix = "<html><head><title>403 Forbidden</title></head><body><center><h1>403 Forbidden</h1></center><hr>";
  if (!page.startsWith(prefix)) return false;
  const footer = page.slice(prefix.length);
  return /^<center>nginx(?:\/[0-9]+(?:\.[0-9]+)*)?<\/center><\/body><\/html>(?:<!-- a padding to disable MSIE and Chrome friendly error page -->)*$/.test(footer);
}

/** Project fixed provenance for this response without retaining the body. */
export async function inspectTestPreviewDeniedResponse(
  response: Response,
  signal: AbortSignal
): Promise<TestPreviewDeniedResponse> {
  if (signal.aborted || response.status !== 403) return { kind: "unclassified" };
  const rayId = readCloudflareRayId(response.headers);
  const correlation = rayId ? { rayId } : {};
  const unclassified = { kind: "unclassified", ...correlation } as const;

  const headerCode = response.headers.get("cf-error-type");
  const codeFromHeader = edgeDenialCodes.find(code => String(code) === headerCode);
  if (rayId && codeFromHeader !== undefined) return { kind: "cloudflare_edge", code: codeFromHeader, rayId };

  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const htmlResponse = mediaType === "text/html" || mediaType === "application/xhtml+xml";
  const jsonResponse = mediaType === "application/json" || mediaType === "application/problem+json";
  if (!jsonResponse && (!htmlResponse || !rayId)) return unclassified;
  if (!response.body || response.bodyUsed || response.body.locked) return unclassified;

  try {
    const readSignal = AbortSignal.any([signal, AbortSignal.timeout(errorBodyTimeoutMs)]);
    const body = await readBoundedText(response.body, readSignal);
    if (readSignal.aborted || body === undefined) return unclassified;
    if (htmlResponse && rayId) {
      const code = readCloudflareHtmlCode(body, rayId, response.url);
      if (code !== undefined) return { kind: "cloudflare_edge", code, rayId };
      return isNginxForbiddenPage(body) ? { ...unclassified, denialTemplate: "nginx_default_403" } : unclassified;
    }

    const payload = JSON.parse(body) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return unclassified;
    const error = payload as Record<string, unknown>;
    if (error.cloudflare_error === true) {
      const code = edgeDenialCodes.find(candidate => candidate === error.error_code);
      if (code !== undefined && rayId && typeof error.ray_id === "string"
        && error.ray_id.toLowerCase() === rayId.slice(0, 16).toLowerCase()) {
        return { kind: "cloudflare_edge", code, rayId };
      }
      return unclassified;
    }

    if (!Object.hasOwn(error, "code") || !Object.hasOwn(error, "err") || (error.code !== 2002 && error.code !== "2002")) {
      return unclassified;
    }
    const messages = typeof error.err === "string" ? [error.err] : error.err;
    if (!Array.isArray(messages) || !messages.length || messages.length > maxAppErrorMessages
      || !messages.every(isAppErrorMessage)) return unclassified;

    const kind = messages.some(message => /ip\s*限制/i.test(message)) ? "upstream_ip_restricted" : "upstream_auth";
    return { kind, code: 2002, ...correlation };
  } catch {
    return unclassified;
  }
}
