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
  /**
   * Opaque account-security revision used only to invalidate secondary
   * maintenance sessions after a password, status or role change.
   */
  securityVersion?: string;
}

export type IdentityResolution =
  | { status: "authenticated"; principal: Principal }
  | { status: "unauthenticated" }
  | { status: "unavailable"; reason?: string };

export interface IdentityProvider {
  /**
   * Only return `authenticated` after the configured identity policy has resolved
   * the user and their permissions. The V2 boundary still validates this value
   * at runtime and requires the `bi:read` permission.
   */
  resolve(context: IdentityRequestContext): Promise<IdentityResolution>;
}

/**
 * Safe fallback for environments without a configured identity provider. V2
 * endpoints remain closed instead of degrading to anonymous access.
 */
export class UnavailableIdentityProvider implements IdentityProvider {
  async resolve(): Promise<IdentityResolution> {
    return { status: "unavailable", reason: "尚未配置身份来源" };
  }
}
