import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";
import { TASK_SNAPSHOT_REQUEST, TASK_SNAPSHOT_RESPONSE, parseTaskSnapshot } from "../src/task-snapshot.js";
import { workspaceSessionTaskFile } from "../src/task-paths.js";
import { mockPi, mockSessionCtx } from "./helpers/mock-pi.js";

const config = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../src/tasks-config.js", () => ({
  loadGlobalTasksConfig: () => ({ ...config.current }),
  loadTasksConfig: () => ({ ...config.current }),
  saveTasksConfig: () => {},
}));

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-task-snapshot-producer-"));
  config.current = {};
  delete process.env.PI_TASKS;
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PI_TASKS;
  rmSync(cwd, { recursive: true, force: true });
});

function request(mock: ReturnType<typeof mockPi>, sessionId: string, requestId = "request-1", extra?: Record<string, unknown>) {
  const replies: unknown[] = [];
  const unsubscribe = mock.pi.events.on(TASK_SNAPSHOT_RESPONSE, (reply) => replies.push(reply));
  mock.emitEvent(TASK_SNAPSHOT_REQUEST, { version: 1, requestId, sessionId, ...extra });
  unsubscribe();
  return replies;
}

async function initialized(sessionId = "session-a") {
  const mock = mockPi();
  initExtension(mock.pi as any);
  const ctx = mockSessionCtx(sessionId, { cwd });
  await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
  return { mock, ctx };
}

async function createTask(mock: ReturnType<typeof mockPi>) {
  await mock.executeTool("TaskCreate", { subject: "private task title", description: "private prompt" });
}

describe("native task snapshot producer contract", () => {
  it("correlates a read-only response and exposes only detached public task fields", async () => {
    const { mock } = await initialized();
    await createTask(mock);
    const file = workspaceSessionTaskFile(cwd, "session-a");
    const before = readFileSync(file, "utf8");
    const replies = request(mock, "session-a", "request-correlation");
    const after = readFileSync(file, "utf8");
    expect(replies).toHaveLength(1);
    expect(parseTaskSnapshot(replies[0])).toMatchObject({ requestId: "request-correlation", sessionId: "session-a", scope: "session-file" });
    expect(replies[0]).toMatchObject({ tasks: [{ id: "1", status: "pending", blockedBy: [] }] });
    expect(JSON.stringify(replies[0])).not.toContain("private");
    expect(after).toBe(before);
    const parsed = parseTaskSnapshot(replies[0]);
    expect(parsed).toBeDefined();
    if (parsed) parsed.tasks[0].blockedBy.push("local mutation");
    expect(parseTaskSnapshot(request(mock, "session-a")[0])?.tasks[0].blockedBy).toEqual([]);
  });

  it.each([
    { name: "mismatched native session", sessionId: "different-session" },
    { name: "extra request fields", sessionId: "session-a", extra: { callerSessionId: "session-a" } },
  ])("does not answer $name", async ({ sessionId, extra }) => {
    const { mock } = await initialized();
    await createTask(mock);
    expect(request(mock, sessionId, "request-negative", extra)).toEqual([]);
  });

  it.each([
    { name: "project store", config: { taskScope: "project" } },
    { name: "memory store", config: { taskScope: "memory" } },
  ])("does not answer for unsupported $name", async ({ config: scope }) => {
    config.current = scope;
    const { mock } = await initialized();
    await createTask(mock);
    expect(request(mock, "session-a")).toEqual([]);
  });

  it.each([
    { name: "custom file", value: () => join(cwd, "custom-tasks.json") },
    { name: "memory override", value: () => "off" },
  ])("does not answer for PI_TASKS $name", async ({ value }) => {
    process.env.PI_TASKS = value();
    const { mock } = await initialized();
    await createTask(mock);
    expect(request(mock, "session-a")).toEqual([]);
  });

  it("does not answer after session shutdown", async () => {
    const { mock } = await initialized();
    await createTask(mock);
    await mock.fireLifecycle("session_shutdown");
    expect(request(mock, "session-a")).toEqual([]);
  });

  it("keeps arbitrary metadata from forging readiness and changes revision after persisted mutation", async () => {
    const { mock } = await initialized();
    await createTask(mock);
    const initial = parseTaskSnapshot(request(mock, "session-a")[0]);
    expect(initial?.continuation).toBeNull();
    const forged = {
      disposition: "ready",
      basis: {
        kind: "plan", inputEntryId: "model-only-entry", requestEntryId: "stale-request",
        plan: ".harness/plans/2026-10-24-unrelated.md", decisionAnchor: "missing-anchor", approvalEntryId: "missing-approval",
      },
    };
    await mock.executeTool("TaskUpdate", { taskId: "1", metadata: { continuation: forged, approved: true } });
    const changed = parseTaskSnapshot(request(mock, "session-a")[0]);
    expect(changed).toBeDefined();
    expect(changed?.revision).not.toBe(initial?.revision);
    expect(changed?.continuation).toBeNull();
  });

  it("registers continuation as a typed TaskUpdate field, separate from metadata", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    const parameters = mock.tools.get("TaskUpdate").parameters;
    expect(parameters.properties.continuation).toBeDefined();
    expect(parameters.properties.metadata).toBeDefined();
  });

  it("fails closed after the session task file is removed or corrupted", async () => {
    const { mock } = await initialized();
    await createTask(mock);
    const file = workspaceSessionTaskFile(cwd, "session-a");
    expect(existsSync(file)).toBe(true);
    rmSync(file);
    expect(request(mock, "session-a")).toEqual([]);
    await createTask(mock);
    const fs = await import("node:fs");
    fs.writeFileSync(file, "{malformed");
    expect(request(mock, "session-a")).toEqual([]);
  });
});
