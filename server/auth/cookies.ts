export interface BiSessionCookieConfiguration {
  readonly name: string;
  readonly secure: boolean;
}

export const PRODUCTION_BI_SESSION_COOKIE: BiSessionCookieConfiguration = Object.freeze({
  name: "__Host-ypbi_session",
  secure: true
});

export const LOCAL_BI_SESSION_COOKIE: BiSessionCookieConfiguration = Object.freeze({
  name: "ypbi_session",
  secure: false
});

// Compatibility alias for callers and tests that use the production cookie.
export const BI_SESSION_COOKIE = PRODUCTION_BI_SESSION_COOKIE.name;

const opaqueTokenPattern = /^[A-Za-z0-9_-]{43}$/;
const cookieNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function resolveSessionCookieConfiguration(
  configuration: BiSessionCookieConfiguration = PRODUCTION_BI_SESSION_COOKIE
): Readonly<BiSessionCookieConfiguration> {
  if (!configuration || typeof configuration.name !== "string" || !cookieNamePattern.test(configuration.name)) {
    throw new Error("BI session Cookie 名称不合法");
  }
  if (typeof configuration.secure !== "boolean") {
    throw new Error("BI session Cookie 的 secure 配置不合法");
  }
  if (/^__(?:Host|Secure)-/.test(configuration.name) && !configuration.secure) {
    throw new Error("带安全前缀的 BI session Cookie 必须启用 Secure");
  }
  return Object.freeze({ name: configuration.name, secure: configuration.secure });
}

export function readUniqueOpaqueCookie(cookieHeader: string | undefined, name: string) {
  if (!cookieHeader) return null;
  const values = cookieHeader.split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  if (values.length !== 1 || !opaqueTokenPattern.test(values[0])) return null;
  return values[0];
}

export function sessionCookie(
  token: string,
  ttlSeconds: number,
  configuration: BiSessionCookieConfiguration = PRODUCTION_BI_SESSION_COOKIE
) {
  const resolved = resolveSessionCookieConfiguration(configuration);
  const secureAttribute = resolved.secure ? "; Secure" : "";
  return `${resolved.name}=${token}; Path=/; Max-Age=${ttlSeconds}; HttpOnly${secureAttribute}; SameSite=Strict`;
}

export function clearAuthCookie(
  configuration: BiSessionCookieConfiguration = PRODUCTION_BI_SESSION_COOKIE
) {
  const resolved = resolveSessionCookieConfiguration(configuration);
  const secureAttribute = resolved.secure ? "; Secure" : "";
  return `${resolved.name}=; Path=/; Max-Age=0; HttpOnly${secureAttribute}; SameSite=Strict`;
}
