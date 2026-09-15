import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export type PlatformSiteId = "primary" | "secondary";

const platformCatalogItemSchema = z.object({
  id: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  pid: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/),
  name: z.string().trim().min(1).max(256),
  siteId: z.enum(["primary", "secondary"]),
  enabled: z.boolean(),
  order: z.number().int().min(0).max(10_000)
}).strict();

const platformCatalogFileSchema = z.object({
  schemaVersion: z.literal("platform-catalog/v1"),
  revision: z.number().int().positive(),
  updatedAt: z.iso.datetime({ offset: true }),
  items: z.array(platformCatalogItemSchema).min(1).max(1_000)
}).strict().superRefine((catalog, context) => {
  for (const key of ["id", "pid", "order"] as const) {
    const seen = new Set<string | number>();
    catalog.items.forEach((item, index) => {
      if (seen.has(item[key])) {
        context.addIssue({
          code: "custom",
          message: `平台目录 ${key} 不能重复：${item[key]}`,
          path: ["items", index, key]
        });
      }
      seen.add(item[key]);
    });
  }
});

export interface PlatformDefinition {
  id: string;
  /** 兼容遗留服务端响应；值始终由 id 派生，不是第二份配置。 */
  hxId: string;
  name: string;
  pid: string;
  siteId: PlatformSiteId;
  /** 兼容遗留服务端响应；值始终由 siteId 派生，不是第二份配置。 */
  upstreamSite: PlatformSiteId;
  enabled: boolean;
  order: number;
}

export interface PlatformCatalogMetadata {
  schemaVersion: "platform-catalog/v1";
  revision: number;
  updatedAt: string;
}

export function parsePlatformCatalogFile(source: unknown) {
  const parsed = platformCatalogFileSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`平台目录配置错误：${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

const catalogPath = fileURLToPath(new URL("./platform-catalog.v1.json", import.meta.url));
let rawCatalog: unknown;
try {
  rawCatalog = JSON.parse(readFileSync(catalogPath, "utf8"));
} catch (error) {
  throw new Error("平台目录无法读取或不是有效 JSON", { cause: error });
}
const catalog = parsePlatformCatalogFile(rawCatalog);

export const platformCatalogMetadata: Readonly<PlatformCatalogMetadata> = Object.freeze({
  schemaVersion: catalog.schemaVersion,
  revision: catalog.revision,
  updatedAt: catalog.updatedAt
});

export const platformRegistry: readonly Readonly<PlatformDefinition>[] = Object.freeze(
  catalog.items.map((item) => Object.freeze({
    ...item,
    hxId: item.id,
    upstreamSite: item.siteId
  }))
);

export function findEnabledPlatformByPid<T extends Pick<PlatformDefinition, "pid" | "enabled">>(
  platforms: readonly T[],
  pid: string
) {
  return platforms.find((platform) => platform.pid === pid && platform.enabled);
}

export function getPlatformByPid(pid: string) {
  return platformRegistry.find((platform) => platform.pid === pid);
}

export function getEnabledPlatformByPid(pid: string) {
  return findEnabledPlatformByPid(platformRegistry, pid);
}

export function enabledPlatformsForSite(siteId: PlatformSiteId) {
  return platformRegistry
    .filter((platform) => platform.enabled && platform.siteId === siteId)
    .sort((left, right) => left.order - right.order);
}

export function enabledSecondaryPlatformPids() {
  return enabledPlatformsForSite("secondary").map((platform) => platform.pid);
}
