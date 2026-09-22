import type { BiAuthPrincipal, BiRole } from "../../contracts/bi-auth";

const readerPermissions = [
  "bi:read",
  "bi:export",
  "bi:favorite:write",
  "bi:view-link:create",
  "bi:data-source-maintenance:enter"
] as const;

const analystPermissions = [
  ...readerPermissions,
  "bi:analysis:write",
  "bi:dashboard:write",
  "bi:metric-overview:write"
] as const;

export const permissionsByRole: Readonly<Record<BiRole, readonly string[]>> = {
  reader: readerPermissions,
  analyst: analystPermissions,
  maintainer: [
    ...analystPermissions,
    "bi:official-dashboard:write",
    "bi:maintenance-scope:write"
  ]
};

export interface PrincipalUser {
  id: string;
  username: string;
  displayName?: string;
  role: BiRole;
  mustChangePassword: boolean;
}

export function principalForUser(user: PrincipalUser): BiAuthPrincipal {
  return {
    subjectId: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    permissions: user.mustChangePassword
      ? ["bi:account:change-password"]
      : [...permissionsByRole[user.role]],
    pidScope: "all"
  };
}
