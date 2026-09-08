import { runAuthMigrations } from "../persistence/migrations/runner";
import {
  type BiSessionCookieConfiguration,
  resolveSessionCookieConfiguration
} from "./cookies";
import { PostgresAuthRepository } from "./postgres-auth.repository";
import { BiAccountAdminService, BiAuthService, type AuthServiceOptions } from "./service";
import { SessionIdentityProvider } from "./session-identity-provider";
import { createAuthMaintenanceDatabase, createAuthRuntimeDatabase } from "./database";

export interface PostgresAuthModuleOptions extends AuthServiceOptions {
  sessionCookie?: BiSessionCookieConfiguration;
}

export async function createPostgresAuthModule(databaseUrl: string, options: PostgresAuthModuleOptions) {
  const { sessionCookie, ...authServiceOptions } = options;
  const cookieConfiguration = resolveSessionCookieConfiguration(sessionCookie);
  const migrationSql = createAuthMaintenanceDatabase(databaseUrl);
  try {
    await runAuthMigrations(migrationSql);
  } finally {
    await migrationSql.end().catch(() => undefined);
  }
  const sql = createAuthRuntimeDatabase(databaseUrl);
  try {
    const repository = new PostgresAuthRepository(sql);
    const authService = await BiAuthService.create(repository, authServiceOptions);
    return {
      authService,
      identityProvider: new SessionIdentityProvider(authService, cookieConfiguration),
      authPluginOptions: { authService, sessionCookie: cookieConfiguration },
      accountAdminService: new BiAccountAdminService(repository, authServiceOptions.scryptParameters),
      health: async () => { await sql`select 1`; },
      close: async () => sql.end()
    };
  } catch (error) {
    await sql.end().catch(() => undefined);
    throw error;
  }
}

export { biAuthPlugin } from "./plugin";
export type { BiAuthPluginOptions } from "./plugin";
