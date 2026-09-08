export interface IdentityRequestContext {
  headers: Readonly<Record<string, string | string[] | undefined>>;
  ip: string;
  signal: AbortSignal;
}

export interface Principal {
  subjectId: string;
  displayName?: string;
  roles: readonly string[];
  permissions: readonly string[];
  pidScope: "all" | readonly string[];
}

export type IdentityResolution =
  | { status: "authenticated"; principal: Principal }
  | { status: "unauthenticated" }
  | { status: "unavailable"; reason?: string };

export interface IdentityProvider {
  /**
   * Only return `authenticated` after the external identity policy has resolved
   * the user and their permissions. The V2 boundary still validates this value
   * at runtime and requires the `bi:read` permission.
   */
  resolve(context: IdentityRequestContext): Promise<IdentityResolution>;
}

/**
 * Batch A intentionally has no production identity adapter. V2 endpoints therefore
 * fail closed until the real authentication source is confirmed and injected.
 */
export class UnavailableIdentityProvider implements IdentityProvider {
  async resolve(): Promise<IdentityResolution> {
    return { status: "unavailable", reason: "尚未配置正式身份来源" };
  }
}
