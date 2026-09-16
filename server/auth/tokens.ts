import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function createOpaqueToken() {
  return randomBytes(32).toString("base64url");
}

export function hashOpaqueToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function safeTokenEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function deriveCsrfToken(sessionToken: string, secret: string | Buffer) {
  return createHmac("sha256", secret)
    .update("ypbi-csrf-v1\0", "utf8")
    .update(sessionToken, "utf8")
    .digest("base64url");
}
