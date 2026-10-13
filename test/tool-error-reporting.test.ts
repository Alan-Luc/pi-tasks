/**
 * Result contract for the task tools: an unknown task ID returns a plain "not found"
 * result, as Claude Code's TaskGet/TaskUpdate do, and TaskUpdate warns when a manual
 * status change bypasses open blockers (#71).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import initExtension from "../src/index.js";
import { mockPi } from "./helpers/mock-pi.js";

beforeEach(() => { process.env.PI_TASKS = "off"; });
afterEach(() => { delete process.env.PI_TASKS; });

describe("unknown-ID results match Claude Code", () => {
  it("TaskGet returns a non-error \"Task not found\"", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    const res = await mock.executeTool("TaskGet", { taskId: "99" });
    expect(res.content[0].text).toBe("Task not found");
  });

  it("TaskUpdate returns a non-error \"Task #N not found\"", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    const res = await mock.executeTool("TaskUpdate", { taskId: "99", status: "completed" });
    expect(res.content[0].text).toBe("Task #99 not found");
  });
});

describe("#71 TaskUpdate surfaces a blocker warning without blocking the change", () => {
  it("warns when moving a blocked task to in_progress", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.executeTool("TaskCreate", { subject: "Blocker", description: "d" }); // #1
    await mock.executeTool("TaskCreate", { subject: "Blocked", description: "d" }); // #2
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    const res = await mock.executeTool("TaskUpdate", { taskId: "2", status: "in_progress" });
    expect(res.content[0].text).toContain("warning");
    expect(res.content[0].text).toContain("open blockers");

    const got = await mock.executeTool("TaskGet", { taskId: "2" });
    expect(got.content[0].text).toContain("Status: in_progress"); // change still applied
  });
});
