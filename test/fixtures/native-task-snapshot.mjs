import assert from "node:assert/strict";
import { mkdirSync, readFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import initTasks from "../../src/index.ts";
import { registerHumanInputTracker } from "../../src/human-input.ts";
import { workspaceSessionTaskFile } from "../../src/task-paths.ts";
import { TaskStore } from "../../src/task-store.ts";
import { parseTaskSnapshot } from "../../src/task-snapshot.ts";
import { TASK_SNAPSHOT_REQUEST, TASK_SNAPSHOT_RESPONSE } from "../../src/task-snapshot.ts";

export async function runNativeTaskSnapshotScenario(options = {}) {
  const [pi, ai, compat] = await Promise.all([
    import("@earendil-works/pi-coding-agent"),
    import("@earendil-works/pi-ai"),
    import("@earendil-works/pi-ai/compat"),
  ]);
  const root = mkdtempSync(join(options.longWorkspace ? tmpdir() : "/tmp", "native-task-snapshot-"));
  const priorHome = process.env.HOME;
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  const priorPiTasks = process.env.PI_TASKS;
  const priorFetch = globalThis.fetch;
  process.env.HOME = root;
  process.env.PI_CODING_AGENT_DIR = root;
  delete process.env.PI_TASKS;
  if (options.piTasks !== undefined) process.env.PI_TASKS = options.piTasks;
  if (options.taskScope !== undefined) {
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(join(root, ".pi", "tasks-config.json"), JSON.stringify({ taskScope: options.taskScope }));
  }
  if (options.planPath && !options.planMissing) {
    const planPath = join(root, options.planPath);
    mkdirSync(dirname(planPath), { recursive: true });
    if (options.planSymlink) {
      const target = join(root, "plan-target.md");
      writeFileSync(target, options.planContent ?? "approved-anchor");
      symlinkSync(target, planPath);
    } else {
      writeFileSync(planPath, options.planContent ?? "approved-anchor");
    }
  }
  let api;
  let currentContext;
  let humanInputs;
  const registeredTools = new Map();
  const sources = [];
  const receivedRequests = [];
  const responses = [];
  const shutdownResponses = [];
  let observedSessionId;
  let session;
  globalThis.fetch = async () => { throw new Error("Unexpected network request in local native fixture"); };
  try {
    const settings = pi.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }, { projectTrusted: false });
    const loader = new pi.DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager: settings,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [(extensionApi) => {
        api = extensionApi;
        extensionApi.events.on(TASK_SNAPSHOT_REQUEST, (value) => receivedRequests.push(value));
        const proxy = new Proxy(extensionApi, {
          get(target, key, receiver) {
            if (key === "registerTool") return (definition) => {
              registeredTools.set(definition.name, definition);
              return target.registerTool(definition);
            };
            const value = Reflect.get(target, key, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        initTasks(proxy);
        humanInputs = registerHumanInputTracker(extensionApi);
        extensionApi.on("input", (event) => { sources.push(event.source); });
        extensionApi.on("before_agent_start", (_event, ctx) => { currentContext = ctx; });
        extensionApi.on("session_shutdown", () => {
          const start = responses.length;
          extensionApi.events.emit(TASK_SNAPSHOT_REQUEST, { version: 1, requestId: "shutdown-probe", sessionId: observedSessionId });
          shutdownResponses.push(...responses.slice(start));
        });
        extensionApi.events.on(TASK_SNAPSHOT_RESPONSE, (value) => responses.push(value));
      }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, [], "native extension setup must be clean before behavior assertions");
    const runtime = await pi.ModelRuntime.create({ authPath: join(root, "absent-auth.json"), modelsPath: null, refreshOnCreate: false });
    await runtime.setRuntimeApiKey("anthropic", "local-fixture-only");
    const model = compat.getModel("anthropic", "claude-sonnet-4-5");
    assert.ok(model, "pinned fixture model must exist");
    ({ session } = await pi.createAgentSession({
      cwd: root,
      agentDir: root,
      resourceLoader: loader,
      settingsManager: settings,
      modelRuntime: runtime,
      model,
      thinkingLevel: "off",
      tools: [],
      sessionManager: pi.SessionManager.create(root, join(root, "sessions")),
    }));
    session.agent.streamFunction = (selectedModel) => {
      const stream = ai.createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: {
        role: "assistant", api: selectedModel.api, provider: selectedModel.provider, model: selectedModel.id,
        content: [{ type: "text", text: "Local fixture response" }], stopReason: "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } });
      return stream;
    };
    await session.bindExtensions({ mode: "print" });
    await session.prompt("identical request", { source: "rpc" });
    await session.prompt("identical request", { source: "rpc" });
    assert.deepEqual(sources, ["rpc", "rpc"], "both requests must traverse native input source events");
    const userEntries = session.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user");
    assert.equal(userEntries.length, 2, "both user requests must be persisted on the selected branch");
    assert.notEqual(userEntries[0].id, userEntries[1].id, "same-text actual requests have distinct native entry identities");
    assert.ok(currentContext, "native before_agent_start context must be available");
    assert.equal(humanInputs.current(currentContext)?.entryId, userEntries[1].id, "the supplied native adapter identifies the latest persisted human entry");
    assert.equal(humanInputs.isHumanEntry(currentContext, userEntries[0].id), true, "the originating human entry is source-backed");

    const create = registeredTools.get("TaskCreate");
    assert.ok(create, "TaskCreate must register in the native extension runtime");
    await create.execute("native-create", { subject: "private task title", description: "private task description" }, undefined, undefined, currentContext);
    const sessionId = session.sessionManager.getSessionId();
    observedSessionId = sessionId;
    const taskFile = workspaceSessionTaskFile(root, sessionId);
    const requestId = "native-correlation";
    api.events.emit(TASK_SNAPSHOT_REQUEST, { version: 1, requestId: "wrong-session", sessionId: "foreign-session" });
    api.events.emit(TASK_SNAPSHOT_REQUEST, { version: 1, requestId: "extra-field", sessionId, callerSessionId: sessionId });
    assert.equal(responses.length, 0, "mismatched and malformed queries must not receive a reply");
    if (options.taskScope === "project" || options.taskScope === "memory" || options.piTasks !== undefined) {
      api.events.emit(TASK_SNAPSHOT_REQUEST, { version: 1, requestId, sessionId });
      return { unsupportedReplies: responses.length, sessionId, sources, taskFile };
    }
    const storedBefore = readFileSync(taskFile, "utf8");
    const source = new TaskStore(taskFile).readSnapshot();
    assert.ok(source, "persisted store fixture must be readable before querying");
    const wireFixture = parseTaskSnapshot({ version: 1, requestId, sessionId, generation: "fixture-generation", storeId: `path:${taskFile}`, scope: "session-file", revision: source.revision, tasks: source.tasks, continuation: null });
    if (options.longWorkspace) {
      assert.ok(`path:${taskFile}`.length > 128, "long-path negative control must exceed the wire identifier bound");
      assert.equal(wireFixture, undefined, "the canonical parser rejects a raw path as an oversized store identifier");
    } else {
      assert.ok(wireFixture, "wire contract must accept a valid native-store fixture");
    }
    api.events.emit(TASK_SNAPSHOT_REQUEST, { version: 1, requestId, sessionId });
    if (options.longWorkspace) return { longPathReplies: responses.length, storeIdLength: `path:${taskFile}`.length, sessionId, sources };
    assert.equal(responses.length, 1, `the current native session request must receive one snapshot (requests=${receivedRequests.length}, contextSession=${currentContext.sessionManager.getSessionId()}, sessionFile=${currentContext.sessionManager.getSessionFile()}, nativeSession=${sessionId})`);
    assert.equal(responses[0].requestId, requestId, "the response must echo the request correlation");
    assert.equal(responses[0].sessionId, sessionId, "the response must use the native session identity");
    assert.equal(responses[0].continuation, null);
    assert.deepEqual(responses[0].tasks, [{ id: "1", status: "pending", blockedBy: [] }]);
    assert(!JSON.stringify(responses[0]).includes("private"), "private task text must not cross the wire");
    assert.equal(readFileSync(taskFile, "utf8"), storedBefore, "querying must not mutate persisted task bytes");

    const update = registeredTools.get("TaskUpdate");
    assert.ok(update, "TaskUpdate must register in the native extension runtime");
    const initialRevision = responses[0].revision;
    const forgedMetadata = { disposition: "ready", basis: { kind: "request", inputEntryId: userEntries[1].id, requestEntryId: userEntries[0].id } };
    await update.execute("metadata-update", { taskId: "1", metadata: { continuation: forgedMetadata, approved: true } }, undefined, undefined, currentContext);
    responses.length = 0;
    api.events.emit(TASK_SNAPSHOT_REQUEST, { version: 1, requestId: "after-metadata", sessionId });
    assert.equal(responses[0].continuation, null, "caller-controlled metadata must not manufacture readiness");
    assert.notEqual(responses[0].revision, initialRevision, "persisted metadata churn must change the store revision");
    const storedTasks = JSON.parse(readFileSync(taskFile, "utf8"));
    storedTasks.tasks[0].updatedAt = 0;
    writeFileSync(taskFile, `${JSON.stringify(storedTasks, null, 2)}\n`);
    const beforeContinuationUpdate = readFileSync(taskFile, "utf8");
    const requestEntryId = options.requestEntryId === "original" ? userEntries[0].id : options.requestEntryId;
    const approvalEntryId = options.approvalEntryId === "original" ? userEntries[0].id : options.approvalEntryId;
    const basis = options.planPath
      ? {
        kind: "plan", plan: options.planPath, decisionAnchor: options.decisionAnchor ?? "approved-anchor",
        ...(requestEntryId ? { requestEntryId } : {}),
        ...(approvalEntryId ? { approvalEntryId } : {}),
      }
      : {
        kind: "request",
        ...(requestEntryId ? { requestEntryId } : {}),
      };
    await update.execute("native-update", { taskId: "1", continuation: { disposition: options.disposition ?? "ready", basis } }, undefined, undefined, currentContext);
    const reconciledInputEntryId = humanInputs.current(currentContext)?.entryId;
    if (options.failedContinuationBeforeSnapshot) {
      await update.execute("missing-reconcile", { taskId: "missing", continuation: { disposition: "ready", basis } }, undefined, undefined, currentContext);
    }
    if (options.metadataChurnBeforeSnapshot) {
      await update.execute("revision-churn", { taskId: "1", metadata: { revisionChurn: true } }, undefined, undefined, currentContext);
    }
    if (options.mutatePlanBeforeSnapshot && options.planPath) {
      writeFileSync(join(root, options.planPath), "decision changed after reconciliation");
    }
    responses.length = 0;
    api.events.emit(TASK_SNAPSHOT_REQUEST, { version: 1, requestId: "after-typed-update", sessionId });
    assert.equal(responses.length, 1, "query after supported TaskUpdate must still correlate");
    const reconciledSnapshot = responses[0];
    await session.prompt("identical request", { source: "rpc" });
    assert.deepEqual(sources, ["rpc", "rpc", "rpc"], "each actual request must retain its native input source");
    const latestUsers = session.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user");
    assert.equal(latestUsers.length, 3);
    assert.notEqual(latestUsers[2].id, latestUsers[1].id, "new same-text input must create a new native entry");
    responses.length = 0;
    api.events.emit(TASK_SNAPSHOT_REQUEST, { version: 1, requestId: "after-new-input", sessionId });
    assert.equal(responses.length, 1, "new-input query must remain correlated");
    return {
      snapshot: reconciledSnapshot, afterNewInput: responses[0], basis: reconciledSnapshot.continuation?.basis ?? basis,
      currentInputEntryId: reconciledInputEntryId, sessionId, sources, taskFile, shutdownResponses, receivedRequests,
      taskFileUnchangedByContinuation: readFileSync(taskFile, "utf8") === beforeContinuationUpdate,
      continuationParameter: update.parameters.properties.continuation,
    };
  } finally {
    session?.dispose();
    globalThis.fetch = priorFetch;
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    if (priorPiTasks === undefined) delete process.env.PI_TASKS; else process.env.PI_TASKS = priorPiTasks;
    rmSync(root, { recursive: true, force: true });
  }
}
