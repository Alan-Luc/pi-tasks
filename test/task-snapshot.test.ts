import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskStore } from "../src/task-store.js";
import { parseTaskSnapshot } from "../src/task-snapshot.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("session task snapshots", () => {
  it("returns detached public fields and a content revision", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-tasks-snapshot-"));
    directories.push(directory);
    const store = new TaskStore(join(directory, "tasks.json"));
    store.create("private subject", "private description", undefined, { secret: "private metadata" });
    const first = store.readSnapshot();
    expect(first).toBeDefined();
    expect(first?.tasks[0]).toEqual({ id: "1", status: "pending", blockedBy: [] });
    expect(JSON.stringify(first)).not.toContain("private");
    const copy = first?.tasks[0].blockedBy;
    copy?.push("mutated");
    expect(store.readSnapshot()?.tasks[0].blockedBy).toEqual([]);
  });

  it("fails closed for absent and malformed source files instead of using loaded memory", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-tasks-snapshot-"));
    directories.push(directory);
    const file = join(directory, "tasks.json");
    const store = new TaskStore(file);
    store.create("kept only in memory", "description");
    unlinkSync(file);
    expect(store.readSnapshot()).toBeUndefined();
    writeFileSync(file, "{broken");
    expect(store.readSnapshot()).toBeUndefined();
  });

  it.each([
    { name: "missing subject", task: { id: "1", status: "pending", blockedBy: [] } },
    { name: "duplicate identifiers", task: { id: "1", status: "pending", subject: "duplicate", description: "d", blockedBy: [] }, duplicate: true },
  ])("fails closed for $name in the persisted source", ({ task, duplicate }) => {
    const directory = mkdtempSync(join(tmpdir(), "pi-tasks-snapshot-"));
    directories.push(directory);
    const file = join(directory, "tasks.json");
    const tasks = duplicate ? [{ id: "1", status: "pending", subject: "original", description: "d", blockedBy: [] }, task] : [task];
    writeFileSync(file, JSON.stringify({ nextId: 2, tasks }));
    expect(new TaskStore(file).readSnapshot()).toBeUndefined();
  });

  it("fails closed for structurally malformed persisted task records", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-tasks-snapshot-"));
    directories.push(directory);
    const file = join(directory, "tasks.json");
    writeFileSync(file, JSON.stringify({ nextId: 2, tasks: [{ id: "1", status: "pending", blockedBy: "not-an-array" }] }));
    expect(new TaskStore(file).readSnapshot()).toBeUndefined();
  });

  it("rejects extra private fields and wrong scope on the wire", () => {
    const value = {
      version: 1, requestId: "r1", sessionId: "s1", generation: "g1", storeId: "store",
      scope: "session-file", revision: "rev", tasks: [{ id: "1", status: "pending", blockedBy: [] }], continuation: null,
    };
    expect(parseTaskSnapshot(value)).toBeDefined();
    expect(parseTaskSnapshot({ ...value, scope: "project" })).toBeUndefined();
    expect(parseTaskSnapshot({ ...value, tasks: [{ ...value.tasks[0], description: "leak" }] })).toBeUndefined();
  });
});
