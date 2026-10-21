import { UpstreamError, type UpstreamClient } from "./client";
import {
  queryJobCreatedSchema, queryJobResultSchema, queryJobStatusSchema,
  type QueryJobContext, type QueryJobCreateRequest, type QueryJobCreated, type QueryJobResult, type QueryJobStatus
} from "./query-jobs.contract";

export * from "./query-jobs.contract";
export { QueryJobBusinessError } from "./client";

function invalidResponse(): never {
  throw new UpstreamError("UPSTREAM_INVALID_RESPONSE", "查询任务响应结构不符合契约", 502);
}

/** BI identity, PID authorization and access-binding checks remain the calling service's responsibility. */
export class QueryJobsClient {
  constructor(private readonly upstream: UpstreamClient) {}

  contextForPid(authorizedPid: string): QueryJobContext {
    return this.upstream.queryJobContext(authorizedPid);
  }

  async create(context: QueryJobContext, body: QueryJobCreateRequest, signal?: AbortSignal): Promise<QueryJobCreated> {
    const parsed = queryJobCreatedSchema.safeParse(await this.upstream.requestQueryJob(context, { kind: "create", body }, signal));
    if (!parsed.success) return invalidResponse();
    return parsed.data;
  }

  async status(context: QueryJobContext, taskId: string, signal?: AbortSignal): Promise<QueryJobStatus> {
    const parsed = queryJobStatusSchema.safeParse(await this.upstream.requestQueryJob(context, { kind: "status", taskId }, signal));
    if (!parsed.success || parsed.data.msg.taskId !== taskId) return invalidResponse();
    return parsed.data;
  }

  async result(context: QueryJobContext, taskId: string, expectedUnitCount: number, signal?: AbortSignal): Promise<QueryJobResult> {
    if (!Number.isInteger(expectedUnitCount) || expectedUnitCount < 1 || expectedUnitCount > 64) {
      throw new UpstreamError("UPSTREAM_INVALID_REQUEST", "查询任务单元数量无效", 400);
    }
    const parsed = queryJobResultSchema.safeParse(await this.upstream.requestQueryJob(context, { kind: "result", taskId }, signal));
    if (!parsed.success || parsed.data.msg.taskId !== taskId) return invalidResponse();
    const msg = parsed.data.msg;
    if (msg.status === "SUCCEEDED" && (msg.results.length !== expectedUnitCount
      || (msg.totalUnits !== undefined && msg.totalUnits !== expectedUnitCount)
      || (msg.completedUnits !== undefined && msg.completedUnits !== expectedUnitCount))) return invalidResponse();
    return parsed.data;
  }
}
