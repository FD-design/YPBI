import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const filePinSchema = z.object({
  path: z.string().min(1).max(256),
  contentSha256: sha256Schema
}).strict();
const validationArtifactSchema = z.object({
  metricId: z.string().regex(/^(?:M|DM)\d{3}$/),
  status: z.enum(["passed", "failed", "expired"]),
  evidence: filePinSchema,
  comparison: filePinSchema
}).strict();
const releaseAdmissionSchema = z.object({
  schemaVersion: z.literal("metric-release-admission/v1"),
  snapshot: filePinSchema,
  registry: filePinSchema,
  platformCatalog: filePinSchema,
  validationArtifacts: z.array(validationArtifactSchema).max(1_000)
}).strict();

const requiredPaths = Object.freeze({
  snapshot: "server/v2/generated/metric-definitions.json",
  registry: "server/v2/config/metric-mapping-registry.v1.json",
  platformCatalog: "server/platforms/platform-catalog.v1.json"
});
const evidencePrefix = "server/v2/validation/evidence/";
const maximumAdmissionFileBytes = 1_048_576;

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function resolveTrustedFile(repositoryRoot: string, relativePath: string, label: string) {
  if (
    path.isAbsolute(relativePath)
    || relativePath.includes("\\")
    || path.posix.normalize(relativePath) !== relativePath
    || relativePath.startsWith("../")
  ) throw new Error(`${label}不是安全的仓库相对路径`);
  const absoluteRoot = path.resolve(repositoryRoot);
  const rootStat = fs.lstatSync(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("指标发布准入仓库根目录必须是真实目录");
  const realRoot = fs.realpathSync(absoluteRoot);
  const absolutePath = path.resolve(absoluteRoot, relativePath);
  if (!absolutePath.startsWith(`${absoluteRoot}${path.sep}`)) throw new Error(`${label}越过仓库根目录`);
  const stat = fs.lstatSync(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label}必须是普通非符号链接文件`);
  if (stat.size > maximumAdmissionFileBytes) throw new Error(`${label}超过准入校验大小上限`);
  const realPath = fs.realpathSync(absolutePath);
  if (!realPath.startsWith(`${realRoot}${path.sep}`)) throw new Error(`${label}真实路径越过仓库根目录`);
  return absolutePath;
}

function verifyPin(repositoryRoot: string, pin: z.infer<typeof filePinSchema>, label: string) {
  const filePath = resolveTrustedFile(repositoryRoot, pin.path, label);
  const serialized = fs.readFileSync(filePath);
  if (sha256(serialized) !== pin.contentSha256) throw new Error(`${label}与发布准入证明不一致`);
  return serialized.toString("utf8");
}

export function verifyMetricReleaseAdmission({
  repositoryRoot,
  attestationPath = path.resolve(repositoryRoot, "server/v2/generated/metric-release-attestation.json"),
  now = new Date()
}: {
  repositoryRoot: string;
  attestationPath?: string;
  now?: Date;
}) {
  const nowMs = now.getTime();
  if (Number.isNaN(nowMs)) throw new Error("指标发布准入基准时间无效");
  const relativeAttestationPath = path.relative(path.resolve(repositoryRoot), path.resolve(attestationPath)).split(path.sep).join("/");
  const serializedAttestation = fs.readFileSync(
    resolveTrustedFile(repositoryRoot, relativeAttestationPath, "指标发布准入证明"),
    "utf8"
  );
  const admission = releaseAdmissionSchema.parse(JSON.parse(serializedAttestation));
  for (const [key, expectedPath] of Object.entries(requiredPaths)) {
    if (admission[key as keyof typeof requiredPaths].path !== expectedPath) {
      throw new Error(`指标发布准入证明的 ${key} 路径不符合固定契约`);
    }
  }

  verifyPin(repositoryRoot, admission.snapshot, "指标目录快照");
  const registrySerialized = verifyPin(repositoryRoot, admission.registry, "指标映射注册表");
  verifyPin(repositoryRoot, admission.platformCatalog, "平台目录");

  const artifactMetricIds = admission.validationArtifacts.map((artifact) => artifact.metricId);
  if (new Set(artifactMetricIds).size !== artifactMetricIds.length) {
    throw new Error("指标发布准入证明不得重复绑定同一指标的验数产物");
  }
  const artifactByMetricId = new Map(admission.validationArtifacts.map((artifact) => [artifact.metricId, artifact]));
  for (const artifact of admission.validationArtifacts) {
    if (!artifact.evidence.path.startsWith(evidencePrefix) || !artifact.evidence.path.endsWith(".evidence.json")) {
      throw new Error(`${artifact.metricId} evidence 路径不符合固定契约`);
    }
    if (!artifact.comparison.path.startsWith(evidencePrefix) || !artifact.comparison.path.endsWith(".comparison.json")) {
      throw new Error(`${artifact.metricId} comparison 路径不符合固定契约`);
    }
    const evidenceRoot = path.resolve(repositoryRoot, evidencePrefix);
    const evidenceRootStat = fs.lstatSync(evidenceRoot);
    if (!evidenceRootStat.isDirectory() || evidenceRootStat.isSymbolicLink()) {
      throw new Error("验数证据根目录必须是真实目录，不能是符号链接");
    }
    const evidenceSerialized = verifyPin(repositoryRoot, artifact.evidence, `${artifact.metricId} 验数证据`);
    verifyPin(repositoryRoot, artifact.comparison, `${artifact.metricId} 自动比较产物`);
    const evidence = JSON.parse(evidenceSerialized) as Record<string, unknown>;
    const comparison = evidence.comparison as Record<string, unknown> | undefined;
    const validatedAtMs = typeof evidence.validatedAt === "string" ? Date.parse(evidence.validatedAt) : Number.NaN;
    if (Number.isNaN(validatedAtMs) || validatedAtMs > nowMs + 300_000) {
      throw new Error(`${artifact.metricId} 验数证据 validatedAt 晚于当前时间允许范围`);
    }
    if (
      evidence.evidenceId !== artifact.evidence.path
      || evidence.metricId !== artifact.metricId
      || evidence.result !== artifact.status
      || comparison?.artifactPath !== artifact.comparison.path
      || comparison?.contentSha256 !== artifact.comparison.contentSha256
    ) throw new Error(`${artifact.metricId} 验数证据与发布准入证明不一致`);
  }

  const registry = JSON.parse(registrySerialized) as { entries?: Array<Record<string, unknown>> };
  if (!Array.isArray(registry.entries)) throw new Error("指标映射注册表 entries 缺失");
  const expectedResultEntries = registry.entries.filter((entry) => {
    const validation = entry.validation as Record<string, unknown> | undefined;
    return validation && ["passed", "failed", "expired"].includes(String(validation.status));
  });
  if (expectedResultEntries.length !== admission.validationArtifacts.length) {
    throw new Error("指标发布准入证明未完整绑定注册表结果态验数产物");
  }
  for (const entry of expectedResultEntries) {
    const metricId = String(entry.metricId);
    const validation = entry.validation as Record<string, unknown>;
    const artifact = artifactByMetricId.get(metricId);
    if (
      !artifact
      || artifact.status !== validation.status
      || artifact.evidence.path !== validation.evidenceId
      || artifact.evidence.contentSha256 !== validation.evidenceSha256
    ) throw new Error(`${metricId} 注册表验数结果未被发布准入证明准确绑定`);
  }
  return admission;
}

const productionRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const metricReleaseAdmission = verifyMetricReleaseAdmission({ repositoryRoot: productionRepositoryRoot });
