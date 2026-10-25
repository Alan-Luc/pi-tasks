import { expect, it } from "vitest";
import { runNativeTaskSnapshotScenario } from "./fixtures/native-task-snapshot.mjs";

it("registers the typed continuation field on native TaskUpdate", async () => {
  const result = await runNativeTaskSnapshotScenario();
  expect(result.continuationParameter).toBeDefined();
});

it("reconciles a typed TaskUpdate against actual native input entries and the persisted session store", async () => {
  const result = await runNativeTaskSnapshotScenario({ requestEntryId: "original" });
  expect(result.snapshot.continuation).toEqual({
    taskId: "1",
    disposition: "ready",
    basis: result.basis,
    revision: result.snapshot.revision,
  });
  expect(result.basis.inputEntryId).toBe(result.currentInputEntryId);
  expect(result.basis.requestEntryId).not.toBe(result.currentInputEntryId);
  expect(result.taskFileUnchangedByContinuation).toBe(true);
});

it("uses a bounded opaque store identity for long workspace paths", async () => {
  const result = await runNativeTaskSnapshotScenario();
  expect(result.snapshot.storeId).toMatch(/^[a-f0-9]{64}$/);
});

it.each(["waiting", "paused", "blocked", "approval-required", "unknown"] as const)(
  "preserves the typed %s continuation disposition",
  async (disposition) => {
    const result = await runNativeTaskSnapshotScenario({ disposition });
    expect(result.snapshot.continuation?.disposition).toBe(disposition);
  },
);

it("fails closed when the typed request reference is not a source-backed human entry", async () => {
  const result = await runNativeTaskSnapshotScenario({ requestEntryId: "model-only-entry" });
  expect(result.snapshot.continuation?.disposition).toBe("unknown");
});

it("clears a previous disposition when explicit reconciliation targets a missing task", async () => {
  const result = await runNativeTaskSnapshotScenario({ failedContinuationBeforeSnapshot: true });
  expect(result.snapshot.continuation).toBeNull();
});

it("invalidates a reconciled disposition when the persisted task revision changes", async () => {
  const result = await runNativeTaskSnapshotScenario({ metadataChurnBeforeSnapshot: true });
  expect(result.snapshot.continuation).toBeNull();
});

it("requires an actual plan anchor and source-backed approval entry for plan continuations", async () => {
  const planPath = ".harness/plans/2026-10-24-approved.md";
  const valid = await runNativeTaskSnapshotScenario({ planPath, planContent: "# Decision\napproved-anchor", requestEntryId: "original", approvalEntryId: "original" });
  expect(valid.snapshot.continuation?.disposition).toBe("ready");

  const missingPlan = await runNativeTaskSnapshotScenario({ planPath, planMissing: true });
  expect(missingPlan.snapshot.continuation?.disposition).toBe("approval-required");

  const missingApproval = await runNativeTaskSnapshotScenario({ planPath, approvalEntryId: "model-only-entry" });
  expect(missingApproval.snapshot.continuation?.disposition).toBe("approval-required");

  const symlinkPlan = await runNativeTaskSnapshotScenario({ planPath, planSymlink: true });
  expect(symlinkPlan.snapshot.continuation?.disposition).toBe("approval-required");

  const changedPlan = await runNativeTaskSnapshotScenario({ planPath, mutatePlanBeforeSnapshot: true });
  expect(changedPlan.snapshot.continuation?.disposition).toBe("approval-required");
});

it("invalidates a reconciled disposition when a distinct same-text human input is persisted", async () => {
  const result = await runNativeTaskSnapshotScenario();
  expect(result.snapshot.continuation).toMatchObject({ disposition: "ready", basis: result.basis });
  expect(result.afterNewInput.continuation).toBeNull();
});

it.each([
  { name: "project scope", options: { taskScope: "project" } },
  { name: "memory scope", options: { taskScope: "memory" } },
  { name: "custom PI_TASKS path", options: { piTasks: "./custom-tasks.json" } },
  { name: "PI_TASKS=off", options: { piTasks: "off" } },
])("does not answer native snapshot requests for $name", async ({ options }) => {
  const result = await runNativeTaskSnapshotScenario(options);
  expect(result.unsupportedReplies).toBe(0);
});

it("keeps a correlated snapshot available when the workspace path exceeds the wire identifier limit", async () => {
  const result = await runNativeTaskSnapshotScenario({ longWorkspace: true });
  expect(result.longPathReplies).toBe(1);
});

it("disables the native snapshot responder during session_shutdown", async () => {
  const result = await runNativeTaskSnapshotScenario();
  expect(result.shutdownResponses).toEqual([]);
});
