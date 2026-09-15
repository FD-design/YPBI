import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { v2MetricQuerySuccessSchema } from "../contracts/bi-v2.ts";
import { parseM016ValidationDataset, readM016ValidationContext } from "./validate-m016.mjs";

/** 仅转换受控查询导出；文件本身不证明来源真实性、验数通过或数据完整水位。 */
export function buildM016Candidate(responses, artifactId) {
  const { entry, revision, contentSha256, pids } = readM016ValidationContext();
  if (!Array.isArray(responses) || responses.length !== pids.length) {
    throw new Error("候选采集必须包含当前每个启用 PID 的一份响应");
  }
  const parsed = responses.map((response, index) => {
    const result = v2MetricQuerySuccessSchema.safeParse(response);
    if (!result.success) throw new Error(`第 ${index + 1} 份响应不满足 M016 查询契约`);
    return result.data;
  });
  const dateRange = parsed[0].data.dateRange;
  const allowedPids = new Set(pids);
  const seen = new Set();
  const rowsByPid = new Map();
  for (const { data, meta } of parsed) {
    const pid = data.scope.pid;
    if (!allowedPids.has(pid) || seen.has(pid)) throw new Error("候选采集包含未知、停用或重复 PID");
    seen.add(pid);
    if (data.metric.authority.version !== entry.authorityVersion || meta.mappingVersion !== entry.mappingVersion) {
      throw new Error("候选响应与当前指标权威版本或映射版本不一致");
    }
    if ([...meta.sourceApiIds].sort().join("|") !== [...entry.mapping.sourceApiIds].sort().join("|")) {
      throw new Error("候选响应来源接口与当前登记不一致");
    }
    if (data.dateRange.join("|") !== dateRange.join("|")) throw new Error("全部 PID 必须使用同一业务日期范围");
    const fetchedAt = Date.parse(meta.fetchedAt);
    if (fetchedAt < Date.parse(`${dateRange[1]}T16:00:00Z`) || fetchedAt > Date.now() + 300_000) {
      throw new Error("候选响应必须在覆盖期结束后采集，且不得使用未来采集时间");
    }
    // 无记录保留为缺行；有记录无值保留 null；真实 0 原样保留。
    rowsByPid.set(pid, [
      ...data.points.map((point) => ({ pid, businessDate: point.businessDate, value: point.value })),
      ...data.unavailableDates.filter((item) => item.state === "no_value")
        .map((item) => ({ pid, businessDate: item.businessDate, value: null }))
    ].sort((left, right) => left.businessDate.localeCompare(right.businessDate)));
  }
  return parseM016ValidationDataset({
    schemaVersion: "m016-validation-dataset/v1",
    kind: "controlled_technical_query",
    metricId: "M016",
    authorityVersion: entry.authorityVersion,
    mappingVersion: entry.mappingVersion,
    platformCatalogRevision: revision,
    platformCatalogContentSha256: contentSha256,
    generatedAt: new Date(Math.max(...parsed.map((response) => Date.parse(response.meta.fetchedAt)))).toISOString(),
    artifactId,
    dateRange,
    rows: pids.flatMap((pid) => rowsByPid.get(pid))
  }, "candidate");
}

function runCli(argv) {
  if (argv.length !== 4 || argv[0] !== "--responses" || argv[2] !== "--output") {
    throw new Error("用法：--responses <受控查询响应数组.json> --output <新候选文件.json>；仅离线转换，不联网、不写注册表");
  }
  const input = path.resolve(argv[1]);
  const output = path.resolve(argv[3]);
  let responses;
  try {
    const stat = fs.lstatSync(input);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 67_108_864) throw new Error();
    responses = JSON.parse(fs.readFileSync(input, "utf8"));
  } catch {
    throw new Error("响应文件必须是 64 MiB 以内的普通非符号链接 JSON 文件");
  }
  const candidate = buildM016Candidate(responses, `m016-api-${randomUUID()}`);
  try {
    fs.writeFileSync(output, `${JSON.stringify(candidate, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch {
    throw new Error("候选文件写入失败；必须指定可写的新文件，不覆盖已有文件或链接");
  }
  // 业务值只进入用户指定的受保护文件，不输出到终端日志。
  process.stdout.write(`${JSON.stringify({ metricId: "M016", rowCount: candidate.rows.length, validationStatus: "not_validated" })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runCli(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "候选转换失败"}\n`);
    process.exitCode = 1;
  }
}
