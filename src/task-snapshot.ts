function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const TASK_SNAPSHOT_REQUEST = "workflow:task-snapshot:request:v1";
export const TASK_SNAPSHOT_RESPONSE = "workflow:task-snapshot:response:v1";
export const CONTINUATION_DISPOSITIONS = ["ready", "waiting", "blocked", "approval-required", "paused", "unknown"] as const;
const TASK_STATUSES = ["pending", "in_progress", "completed"] as const;

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024;
}
function identifier(value: unknown): value is string {
  return text(value) && value.length <= 128;
}
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
function member<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.some((item) => item === value);
}

export function parseContinuationBasis(value: unknown) {
  if (!isRecord(value) || !identifier(value.inputEntryId) || !identifier(value.requestEntryId)) return undefined;
  const identity = { inputEntryId: value.inputEntryId, requestEntryId: value.requestEntryId };
  if (value.kind === "request" && keys(value, ["kind", "inputEntryId", "requestEntryId"])) {
    return { ...identity, kind: "request" as const };
  }
  if (value.kind !== "plan" || !keys(value, ["kind", "inputEntryId", "requestEntryId", "plan", "decisionAnchor", "approvalEntryId"])
    || !text(value.plan) || !/^\.harness\/plans\/\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(value.plan)
    || !text(value.decisionAnchor) || !identifier(value.approvalEntryId)) return undefined;
  return { ...identity, kind: "plan" as const, plan: value.plan, decisionAnchor: value.decisionAnchor, approvalEntryId: value.approvalEntryId };
}
export type ContinuationBasis = NonNullable<ReturnType<typeof parseContinuationBasis>>;
export type ContinuationDisposition = (typeof CONTINUATION_DISPOSITIONS)[number];

export function parseContinuationRecord(value: unknown) {
  if (!isRecord(value) || !keys(value, ["taskId", "disposition", "basis", "revision"])
    || !identifier(value.taskId) || !identifier(value.revision) || !member(value.disposition, CONTINUATION_DISPOSITIONS)) return undefined;
  const basis = parseContinuationBasis(value.basis);
  if (!basis) return undefined;
  return { taskId: value.taskId, disposition: value.disposition, basis, revision: value.revision };
}
export type ContinuationRecord = NonNullable<ReturnType<typeof parseContinuationRecord>>;

function parseTask(value: unknown) {
  if (!isRecord(value) || !keys(value, ["id", "status", "blockedBy"], ["owner"])
    || !identifier(value.id) || !member(value.status, TASK_STATUSES)
    || !Array.isArray(value.blockedBy) || !value.blockedBy.every(identifier)
    || new Set(value.blockedBy).size !== value.blockedBy.length
    || (value.owner !== undefined && !identifier(value.owner))) return undefined;
  return { id: value.id, status: value.status, blockedBy: [...value.blockedBy], ...(value.owner === undefined ? {} : { owner: value.owner }) };
}

/** A valid wire snapshot is not approval; the producer and guard check native provenance. */
export function parseTaskSnapshot(value: unknown) {
  if (!isRecord(value) || !keys(value, ["version", "requestId", "sessionId", "generation", "storeId", "scope", "revision", "tasks", "continuation"])
    || value.version !== 1 || !identifier(value.requestId) || !identifier(value.sessionId)
    || !identifier(value.generation) || !identifier(value.storeId) || value.scope !== "session-file"
    || !identifier(value.revision) || !Array.isArray(value.tasks)) return undefined;
  const tasks = value.tasks.map(parseTask);
  if (tasks.some((task) => task === undefined)) return undefined;
  const validTasks = tasks.filter((task) => task !== undefined);
  if (new Set(validTasks.map((task) => task.id)).size !== validTasks.length) return undefined;
  const continuation = value.continuation === null ? null : parseContinuationRecord(value.continuation);
  if (continuation === undefined) return undefined;
  return {
    version: 1 as const, requestId: value.requestId, sessionId: value.sessionId,
    generation: value.generation, storeId: value.storeId, scope: "session-file" as const,
    revision: value.revision, tasks: validTasks, continuation,
  };
}
export type TaskSnapshot = NonNullable<ReturnType<typeof parseTaskSnapshot>>;
