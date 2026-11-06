import type { WireInput } from "./json-value.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { Result } from "better-result";
import { AgentConflictError, AgentProviderCancelledError, AgentProviderExecutionError } from "./local-agent-errors.js";
import { LocalAgentManager } from "./local-agent-manager.js";
import { LocalAgentStore, type LocalAgentTurnRecord } from "./local-agent-store.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import type { LocalAgentRunInput, LocalAgentRuntime } from "./local-agent-runtime.js";
import { WorkflowManager } from "./workflow-manager.js";
import { WorkflowStore } from "./workflow-store.js";
import type { runWorkflowScript } from "./workflow-runner.js";
import { WorkflowError } from "./workflow-types.js";
import type { ServerConfig } from "./config.js";
import { isManagedWorkflowWorkspace } from "./workflow-workspaces.js";
import type { SubagentsConfig } from "./local-agent-config.js";
import type { LocalAgentDriverKind } from "./local-agent-provider.js";
import type { LocalAgentProfile } from "./local-agent-profiles.js";

async function fixture(runner?: typeof runWorkflowScript, testing: { dsh?: boolean; dshCommand?: string; profiles?: LocalAgentProfile[]; response?: (input: LocalAgentRunInput) => string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "devspace-workflow-"));
  await mkdir(join(dir, "project"));
  const root = await realpath(join(dir, "project"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "Initial"], { cwd: root });
  const stateDir = join(dir, "state");
  // SAFETY: The surrounding checks or construction already match this type.
  const config = { stateDir, allowedRoots: [root], worktreeRoot: join(dir, "worktrees") } as ServerConfig;
  const inputs: LocalAgentRunInput[] = [];
  let active = 0;
  let maximum = 0;
  let releaseHold: (() => void) | undefined;

  const runtime = (provider: LocalAgentDriverKind): LocalAgentRuntime => ({
    provider, isAlive: () => true, close: async () => {}, releaseSession: async () => {},
    run: async (input, callbacks) => {
      inputs.push(input);
      active++;
      maximum = Math.max(maximum, active);

      try {
        await callbacks?.onSessionId?.(`session_${inputs.length}`);

        if (input.prompt === "commit") {
          await writeFile(join(input.workspaceRoot, "committed.txt"), "preserve this commit");
          execFileSync("git", ["add", "committed.txt"], { cwd: input.workspaceRoot });
          execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "Worker change"], { cwd: input.workspaceRoot });
          await writeFile(join(input.workspaceRoot, "untracked.txt"), "preserve this too");
        }

        if (input.prompt === "hold") {
          await new Promise<void>((resolve) => {
            releaseHold = resolve;
            input.signal?.addEventListener("abort", () => resolve(), { once: true });

            if (input.signal?.aborted) resolve();
          });

          if (input.signal?.aborted) return Result.err(new AgentProviderCancelledError({
            code: "PROVIDER_CANCELLED", provider, operation: "run", retryable: false, message: "Test provider confirmed cancellation.",
          }));
        }

        await new Promise((resolve) => setTimeout(resolve, 5));

        return Result.ok({ provider, providerSessionId: null, finalResponse: testing.response?.(input) ?? (input.prompt.startsWith("Your last response") ? '{"ok":true}' : input.prompt), items: [] });
      } finally { active--; }
    },
  });

  const subagents: SubagentsConfig = {
    enabled: true, instructions: "on-demand", providers: [
      { id: "codex", driver: "codex", enabled: true },
      ...(testing.dsh ? [{ id: "dsh", driver: "dsh" as const, enabled: true, command: testing.dshCommand ?? process.execPath }] : []),
    ],
  };

  const agents = new LocalAgentManager({
    store: new LocalAgentStore(stateDir), pool: new LocalAgentRuntimePool(), loadProfiles: async () => testing.profiles ?? [],
    subagents,
    drivers: subagents.providers.map(({ id, driver }) => ({
      providerInstanceId: id, provider: driver, runtimePolicy: { scope: "instance" },
      capabilities: {
        sessions: { resume: true, close: false }, turns: { interrupt: true, streaming: false },
        configuration: { modelOverride: true, effortOverride: true },
        permissions: { enforcement: "native" }, mcp: { supported: false },
      },
      createRuntime: async () => Result.ok(runtime(driver)),
    })),
    allowedRoots: [root],
    authorizeManagedWorkspace: (path, id) => isManagedWorkflowWorkspace(config, path, id),
  });

  const store = new WorkflowStore(stateDir);

  const workflows = new WorkflowManager({
    store, agents, runner, config, loadProfiles: async () => testing.profiles ?? [], allowedRoots: [root],
    subagents,
  });

  const scope = { workspaceRoot: root };

  return {
    dir, root, inputs, agents, store, workflows, scope, maximum: () => maximum,
    release: () => releaseHold?.(),
    close: async () => { releaseHold?.(); await workflows.close(); await agents.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

test("real JS pipeline runs in parallel, preserves order and durable turn ownership", async () => {
  const f = await fixture();

  try {
    const run = await f.workflows.run({ ...f.scope, source: `export const meta = {name:'test',concurrency:2};
      return await pipeline(['a','b','c'], value => agent(value,{target:'codex'}), (value,item) => agent(value+item,{target:'codex'}));` });

    const done = await f.workflows.wait(run.id, f.scope);
    assert.equal(done.status, "completed", JSON.stringify(done.error));
    assert.deepEqual(done.result, ["aa", "bb", "cc"].map((value) => ({ status: "completed", value })));
    assert.equal(f.maximum(), 2);
    assert.equal(f.workflows.calls(run.id, f.scope).length, 6);
    assert.ok(f.workflows.calls(run.id, f.scope).every((call) => call.turnId && call.agentId && call.status === "completed"));
    // Workflow turns are ordinary agent turns: the call's turnId addresses their event log.
    const first = f.workflows.calls(run.id, f.scope)[0]!;
    const events = f.agents.events(first.agentId, f.scope, { turnId: first.turnId });
    assert.ok(events.isOk());
    assert.equal(events.value.turnId, first.turnId);
    assert.equal(events.value.events[0]?.type, "turn_started");
    assert.equal(events.value.events.at(-1)?.type, "turn_completed");
  } finally { await f.close(); }
});

test("automatic testing routing records the selected Codex reviewer before dispatch", async () => {
  const f = await fixture();

  try {
    const run = await f.workflows.run({ ...f.scope, source: `export const meta={name:'routing'}; return await agent('review',{target:'auto',coordination:{kind:'analysis',uncertainty:'high'}});` });
    const done = await f.workflows.wait(run.id, f.scope);
    assert.equal(done.status, "completed", JSON.stringify(done.error));
    assert.deepEqual(f.workflows.events(run.id, f.scope).find((event) => event.type === "routing_decision")?.data, {
      index: 0, requestedTarget: "auto", target: "codex", reason: "high_uncertainty",
    });
    assert.equal(f.inputs.at(-1)?.prompt, "review");
    assert.equal(f.workflows.calls(run.id, f.scope)[0]?.options.target, "codex");
  } finally { await f.close(); }
});

test("a validated Codex plan reaches DSH before a Codex acceptance review in the same worktree", async () => {
  const f = await fixture(undefined, { dsh: true, response: (input) => input.prompt.startsWith("plan")
    ? JSON.stringify({ ready: true, cases: ["login-valid", "login-invalid"], evidence: ["src/auth.ts:10"] })
    : input.prompt.startsWith("implement") ? "implemented login cases" : "reviewed" });

  try {
    const run = await f.workflows.run({ ...f.scope, writeMode: "allowed", source: `
      const plan = await agent('plan', {
        target:'auto', coordination:{kind:'analysis'}, writeMode:'read_only',
        schema:{type:'object',properties:{ready:{type:'boolean'},cases:{type:'array',items:{type:'string'},minItems:1},evidence:{type:'array',items:{type:'string'},minItems:1}},required:['ready','cases','evidence'],additionalProperties:false}
      });
      if (!plan.ready) return {blocked:true};
      const result = await agent('implement '+JSON.stringify(plan), {
        target:'auto',coordination:{kind:'implementation',uncertainty:'low',scope:'test_and_fixtures'},
        writeMode:'allowed',isolation:'worktree',workspace:'tests'
      });
      return await agent('review '+result, {target:'auto',coordination:{kind:'review'},writeMode:'read_only',workspace:'tests'});
    ` });

    const done = await f.workflows.wait(run.id, f.scope);
    assert.equal(done.status, "completed", JSON.stringify(done.error));
    const calls = f.workflows.calls(run.id, f.scope);
    assert.deepEqual(calls.map((call) => call.options.target), ["codex", "dsh", "codex"]);
    assert.deepEqual(calls.map((call) => call.options.writeMode), ["read_only", "allowed", "read_only"]);
    assert.match(f.inputs[1]!.prompt, /login-valid.*login-invalid/);
    assert.notEqual(calls[1]!.workspaceRoot, f.root);
    assert.equal(calls[1]!.workspaceRoot, calls[2]!.workspaceRoot);
    assert.equal(f.workflows.events(run.id, f.scope).filter((event) => event.type === "routing_decision").length, 3);
    assert.equal(done.result, "reviewed");
  } finally { await f.close(); }
});

test("a blocked analysis prevents downstream DSH dispatch", async () => {
  const f = await fixture(undefined, { dsh: true, response: () => '{"ready":false}' });

  try {
    const run = await f.workflows.run({ ...f.scope, source: `
      const plan = await agent('plan',{target:'auto',coordination:{kind:'analysis'},schema:{type:'object',properties:{ready:{type:'boolean'}},required:['ready']}});
      if (!plan.ready) return {status:'blocked',nextOwner:'human'};
      return await agent('implement',{target:'auto',coordination:{kind:'implementation',uncertainty:'low'}});
    ` });

    const done = await f.workflows.wait(run.id, f.scope);
    assert.deepEqual(done.result, { status: "blocked", nextOwner: "human" });
    assert.deepEqual(f.workflows.calls(run.id, f.scope).map((call) => call.options.target), ["codex"]);
  } finally { await f.close(); }
});

test("automatic routing falls back before dispatch and read-only routing replays consistently", async () => {
  const f = await fixture(undefined, { dsh: true, dshCommand: "/definitely/missing/devspace-dsh" });

  try {
    const run = await f.workflows.run({ ...f.scope, source: `return await agent('test',{target:'auto',coordination:{kind:'implementation',uncertainty:'low'}});` });
    assert.equal((await f.workflows.wait(run.id, f.scope)).status, "completed");
    assert.equal(f.workflows.calls(run.id, f.scope)[0]?.options.target, "codex");
    assert.deepEqual(f.workflows.events(run.id, f.scope).find((event) => event.type === "routing_decision")?.data, {
      index: 0, requestedTarget: "auto", target: "codex", reason: "dsh_unavailable", fallback: "dsh",
    });
    const resumed = await f.workflows.run({ ...f.scope, resume: run.id });
    assert.equal((await f.workflows.wait(resumed.id, f.scope)).status, "completed");
    assert.equal(f.inputs.length, 1);
    assert.equal(f.workflows.calls(resumed.id, f.scope)[0]?.reusedFrom, run.id);
  } finally { await f.close(); }
});

test("automatic provider selection rejects profile collisions while explicit profiles retain precedence", async () => {
  const f = await fixture(undefined, { dsh: true, profiles: [{ name: "codex", provider: "dsh", description: "Explicit worker", body: "", filePath: "/unused", disabled: false }] });

  try {
    const run = await f.workflows.run({ ...f.scope, source: `return agent('review',{target:'auto',coordination:{kind:'analysis'}});` });
    assert.equal((await f.workflows.wait(run.id, f.scope)).error?.code, "AMBIGUOUS_TARGET");
    assert.equal(f.inputs.length, 0);
    const explicit = await f.workflows.run({ ...f.scope, source: `return agent('review',{target:'codex',coordination:{kind:'analysis'}});` });
    assert.equal((await f.workflows.wait(explicit.id, f.scope)).status, "completed");
    const call = f.workflows.calls(explicit.id, f.scope)[0]!;
    const record = f.agents.get(call.agentId, f.scope);
    assert.ok(record.isOk());
    assert.equal(record.value.providerInstanceId, "dsh");
  } finally { await f.close(); }
});

test("workspaces outside the allowed roots are rejected with a workflow error", async () => {
  const f = await fixture();

  try {
    const outside = await mkdtemp(join(tmpdir(), "devspace-workflow-outside-"));

    try {
      await assert.rejects(
        f.workflows.run({ workspaceRoot: outside, source: "return 1;" }),
        (error) => error instanceof WorkflowError && error.code === "WORKSPACE_NOT_ALLOWED" && /outside|allowed/i.test(error.message),
      );
      await assert.rejects(
        f.workflows.run({ workspaceRoot: join(outside, "missing"), source: "return 1;" }),
        (error) => error instanceof WorkflowError && error.code === "WORKSPACE_NOT_ALLOWED",
      );
    } finally { await rm(outside, { recursive: true, force: true }); }
  } finally { await f.close(); }
});

test("shared daemon capacity bounds simultaneous workflows", async () => {
  const f = await fixture(async ({ onAgent }) => {
    await Promise.all(Array.from({ length: 16 }, (_, i) => onAgent(String(i), { target: "codex" })));

    return "done";
  });

  try {
    const source = "export const meta={concurrency:16}; return null;";
    const runs = await Promise.all([f.workflows.run({ ...f.scope, source }), f.workflows.run({ ...f.scope, source })]);
    await Promise.all(runs.map((r) => f.workflows.wait(r.id, f.scope)));
    assert.equal(f.maximum(), 8);
  } finally { await f.close(); }
});

test("cancelling one workflow stops its exact owned turn and preserves another shared-runtime agent", async () => {
  // SAFETY: The surrounding checks or construction already match this type.
  const f = await fixture(async ({ onAgent }) => await onAgent("hold", { target: "codex" }) as string);

  try {
    const run = await f.workflows.run({ ...f.scope, source: "return null;" });
    await until(() => f.inputs.length === 1);
    const other = await f.agents.start({ ...f.scope, target: "codex", prompt: "other" });
    assert.ok(other.isOk());
    await f.workflows.cancel(run.id, f.scope);
    assert.equal((await f.workflows.wait(run.id, f.scope)).status, "cancelled");
    const call = f.workflows.call(run.id, 0, f.scope);
    assert.equal(call.status, "cancelled");
    assert.equal(unwrap(f.agents.getTurn(call.agentId, call))?.status, "stopped");
    assert.equal(unwrap(await f.agents.wait([other.value.id], f.scope))[0]?.status, "completed");
  } finally { await f.close(); }
});

test("normal return with unawaited calls cancels children before persisting failure", async () => {
  const f = await fixture(async ({ onAgent }) => {
    void Promise.resolve(onAgent("hold", { target: "codex" })).catch(() => {});
    await until(() => f.inputs.length === 1);

    return "early";
  });

  try {
    const run = await f.workflows.run({ ...f.scope, source: "return null;" });
    const done = await f.workflows.wait(run.id, f.scope);
    assert.equal(done.status, "failed");
    assert.equal(done.error?.code, "UNAWAITED_CALLS");
    assert.equal(f.agents.activeTurnCount, 0);
  } finally { await f.close(); }
});

test("schema validates before dispatch and one correction runs with reduced authority", async () => {
  // SAFETY: The surrounding checks or construction already match this type.
  const f = await fixture(async ({ onAgent }) => await onAgent("work", {
    target: "codex", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
  }) as { ok: boolean });

  try {
    const run = await f.workflows.run({ ...f.scope, source: "return null;", writeMode: "allowed" });
    assert.deepEqual((await f.workflows.wait(run.id, f.scope)).result, { ok: true });
    assert.deepEqual(f.inputs.map((i) => i.writeMode), ["allowed", "read_only"]);
    assert.equal(f.workflows.calls(run.id, f.scope).length, 1);
  } finally { await f.close(); }

  // SAFETY: The surrounding checks or construction already match this type.
  const invalid = await fixture(async ({ onAgent }) => await onAgent("never", { target: "codex", schema: { type: "nonsense" } }) as null);

  try {
    const run = await invalid.workflows.run({ ...invalid.scope, source: "return null;" });
    assert.equal((await invalid.workflows.wait(run.id, invalid.scope)).error?.code, "INVALID_SCHEMA");
    assert.equal(invalid.inputs.length, 0);
  } finally { await invalid.close(); }
});

test("resume reuses only compatible read-only prefix and rejects changed context and active runs", async () => {
  // SAFETY: The surrounding checks or construction already match this type.
  const f = await fixture(async ({ onAgent }) => await onAgent("review", { target: "codex" }) as string);

  try {
    const first = await f.workflows.run({ ...f.scope, source: "return null;" });
    await assert.rejects(f.workflows.run({ ...f.scope, resume: first.id }), (e: WireInput) => e instanceof WorkflowError && e.code === "WORKFLOW_ACTIVE");
    await f.workflows.wait(first.id, f.scope);
    const resumed = await f.workflows.run({ ...f.scope, resume: first.id });
    await f.workflows.wait(resumed.id, f.scope);
    assert.equal(f.inputs.length, 1);
    assert.equal(f.workflows.call(resumed.id, 0, f.scope).reusedFrom, first.id);
    await writeFile(join(f.root, "changed"), "changed");
    await assert.rejects(f.workflows.run({ ...f.scope, resume: first.id }), (e: WireInput) => e instanceof WorkflowError && e.code === "RECOVERY_CONTEXT_CHANGED");
    assert.throws(() => f.workflows.get(first.id, { workspaceRoot: f.dir }), /not in this workspace/);
  } finally { await f.close(); }
});

test("resume hashes only files Git does not ignore", async () => {
  const f = await fixture(async () => null);

  try {
    await writeFile(join(f.root, ".gitignore"), "node_modules/\n");
    await writeFile(join(f.root, "tracked.txt"), "tracked");
    execFileSync("git", ["add", ".gitignore", "tracked.txt"], { cwd: f.root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "ignore"], { cwd: f.root });
    await mkdir(join(f.root, "node_modules", "dep"), { recursive: true });
    await writeFile(join(f.root, "node_modules", "dep", "index.js"), "one");
    const first = await f.workflows.run({ ...f.scope, source: "return null;" });
    await f.workflows.wait(first.id, f.scope);
    // Ignored changes (even a symlink, which would otherwise disable hashing) leave resume available.
    await writeFile(join(f.root, "node_modules", "dep", "index.js"), "two");
    await symlink(join(f.root, "node_modules", "dep"), join(f.root, "node_modules", "link"), "junction");
    const resumed = await f.workflows.run({ ...f.scope, resume: first.id });
    await f.workflows.wait(resumed.id, f.scope);
    // Deleting a tracked file or adding an unignored one still changes the context.
    await writeFile(join(f.root, "new.txt"), "x");
    await assert.rejects(f.workflows.run({ ...f.scope, resume: first.id }), (e: WireInput) => e instanceof WorkflowError && e.code === "RECOVERY_CONTEXT_CHANGED");
    await rm(join(f.root, "new.txt"));
    await rm(join(f.root, "tracked.txt"));
    await assert.rejects(f.workflows.run({ ...f.scope, resume: first.id }), (e: WireInput) => e instanceof WorkflowError && e.code === "RECOVERY_CONTEXT_CHANGED");
  } finally { await f.close(); }
});

test("resume rejects staged Git state changes even when worktree files are unchanged", async () => {
  const f = await fixture(async () => null);

  try {
    await writeFile(join(f.root, "staged.txt"), "same content");
    const first = await f.workflows.run({ ...f.scope, source: "return null;" });
    await f.workflows.wait(first.id, f.scope);
    execFileSync("git", ["add", "staged.txt"], { cwd: f.root });
    await assert.rejects(
      f.workflows.run({ ...f.scope, resume: first.id }),
      (error: WireInput) => error instanceof WorkflowError && error.code === "RECOVERY_CONTEXT_CHANGED",
    );
  } finally { await f.close(); }
});

test("nested workflow shares capacity at concurrency one and cannot recursively nest", async () => {
  const f = await fixture();

  try {
    await mkdir(join(f.root, ".devspace", "workflows"), { recursive: true });
    await writeFile(join(f.root, ".devspace", "workflows", "child.js"), "return await agent('nested',{target:'codex'});");
    const run = await f.workflows.run({ ...f.scope, source: "export const meta={concurrency:1}; return await workflow('child',{});" });
    assert.equal((await f.workflows.wait(run.id, f.scope)).result, "nested");
    await writeFile(join(f.root, ".devspace", "workflows", "child.js"), "try { return await workflow('child',{}); } catch { return 'ignored'; }");
    const recursive = await f.workflows.run({ ...f.scope, source: "return await workflow('child',{});" });
    assert.equal((await f.workflows.wait(recursive.id, f.scope)).status, "failed");
  } finally { await f.close(); }
});

test("worktree calls share their logical workspace and preserve commits plus dirty files", async () => {
  const f = await fixture(async ({ onAgent }) => {
    await onAgent("commit", { target: "codex", isolation: "worktree", workspace: "implementation" });

    // SAFETY: The surrounding checks or construction already match this type.
    return await onAgent("verify", { target: "codex", workspace: "implementation", writeMode: "read_only" }) as string;
  });

  try {
    const run = await f.workflows.run({ ...f.scope, source: "return null;", writeMode: "allowed" });
    const done = await f.workflows.wait(run.id, f.scope);
    assert.equal(done.status, "completed", JSON.stringify(done.error));
    const [implementation, verify] = f.workflows.calls(run.id, f.scope);
    assert.equal(implementation!.workspaceRoot, verify!.workspaceRoot);
    assert.notEqual(implementation!.workspaceRoot, f.root);
    assert.equal(await readFile(join(implementation!.workspaceRoot, "untracked.txt"), "utf8"), "preserve this too");
    assert.equal(execFileSync("git", ["show", "HEAD:committed.txt"], { cwd: implementation!.workspaceRoot, encoding: "utf8" }), "preserve this commit");
    await assert.rejects(readFile(join(f.root, "committed.txt")));
    await assert.rejects(f.workflows.run({ ...f.scope, resume: run.id }), (error: WireInput) => error instanceof WorkflowError && error.code === "RECOVERY_REQUIRED");
  } finally { await f.close(); }
});

test("restart reconciliation preserves durable ownership without dispatching interrupted calls", async () => {
  const f = await fixture(async () => "done");

  try {
    const run = await f.workflows.run({ ...f.scope, source: "return null;" });
    await f.workflows.wait(run.id, f.scope);
    f.store.addCall({ runId: run.id, index: 0, agentId: "agt_interrupted", status: "queued", prompt: "pending",
      options: { target: "codex", writeMode: "read_only" }, fingerprint: "old", ...f.scope, createdAt: "now", updatedAt: "now" });
    const child = unwrap(await f.agents.start({ ...f.scope, agentId: "agt_interrupted", target: "codex", prompt: "done", writeMode: "read_only" }));
    await f.agents.wait([child.id], f.scope);
    f.store.update(run.id, { status: "running" });
    f.workflows.reconcile();
    assert.equal(f.workflows.get(run.id, f.scope).status, "interrupted");
    const recovered = f.workflows.call(run.id, 0, f.scope);
    assert.equal(recovered.agentId, "agt_interrupted");
    assert.ok(recovered.turnId);
    assert.equal(recovered.status, "interrupted");
    assert.equal(f.inputs.length, 1);
  } finally { await f.close(); }
});

test("parallel unnamed isolated calls receive distinct worktrees", async () => {
  const f = await fixture(async ({ onAgent }) => {
    await Promise.all([0, 1].map((i) => onAgent(String(i), { target: "codex", isolation: "worktree" })));

    return "done";
  });

  try {
    const run = await f.workflows.run({ ...f.scope, source: "return null;" });
    const done = await f.workflows.wait(run.id, f.scope);
    assert.equal(done.status, "completed", JSON.stringify(done.error));
    const calls = f.workflows.calls(run.id, f.scope);
    assert.equal(new Set(calls.map((call) => call.workspaceRoot)).size, 2);
  } finally { await f.close(); }
});

test("shutdown stops retrying unconfirmed provider cancellation and preserves recovery state", async () => {
  // SAFETY: The surrounding checks or construction already match this type.
  const f = await fixture(async ({ onAgent }) => await onAgent("hold", { target: "codex" }) as string);
  const originalGetTurn = f.agents.getTurn.bind(f.agents);
  const originalStop = f.agents.stop.bind(f.agents);
  let close: Promise<void> | undefined;

  try {
    const run = await f.workflows.run({ ...f.scope, source: "return null;" });
    await until(() => f.inputs.length === 1);
    await until(() => f.workflows.calls(run.id, f.scope)[0]?.turnId !== undefined);
    const call = f.workflows.call(run.id, 0, f.scope);

    const runningTurn: LocalAgentTurnRecord = {
      id: 1, turnId: call.turnId!, agentId: call.agentId, prompt: call.prompt, status: "running", createdAt: "now",
    };

    f.agents.getTurn = () => Result.ok(runningTurn);
    f.agents.stop = async () => Result.err(new AgentConflictError({
      code: "AGENT_CONFLICT", agentId: call.agentId, operation: "stop", retryable: true,
      message: "Provider cancellation is unavailable.",
    }));
    close = f.workflows.close();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      close,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("workflow close timed out")), 2_000); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    const reopened = new WorkflowStore(join(f.dir, "state"));

    try {
      assert.equal(reopened.get(run.id)?.status, "stopping");
      assert.equal(reopened.get(run.id)?.error?.code, "RECOVERY_REQUIRED");
    } finally { reopened.close(); }
  } finally {
    f.agents.getTurn = originalGetTurn;
    f.agents.stop = originalStop;
    f.release();
    await close?.catch(() => {});
    await f.agents.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 5_000;

  while (!check()) {
    if (Date.now() > end) throw new Error("Test condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function unwrap<T, E>(result: import("better-result").Result<T, E>): T {
  if (result.isErr()) throw result.error;

  return result.value;
}

const testingResult = { status: "completed", artifacts: [], verification: [], evidence: ["Read actual files"], unresolved: [], nextOwner: "codex" };
const testingPlan = { ...testingResult, uncertainty: "low", testPlan: "SC-1: empty input is invalid; SC-2: text input is valid", implementationTask: "Add assertions for both scenarios" };

const testingContract = {
  task: "Cover validation", allowedPaths: ["tests"], artifacts: ["tests/case.cjs"], acceptance: ["Assert both valid and invalid input"],
  checks: [{ id: "unit", executable: process.execPath, args: ["-e", "require('./tests/case.cjs');require('node:fs').writeFileSync('tests/report.json',JSON.stringify({passed:2}))"], reports: ["tests/report.json"] }],
};

function testImplementation(input: LocalAgentRunInput, valid = true): string {
  mkdirSync(join(input.workspaceRoot, "tests"), { recursive: true });
  writeFileSync(join(input.workspaceRoot, "tests/case.cjs"), valid ? "const assert=require('node:assert/strict');assert.equal(''.trim().length>0,false);assert.equal(' x '.trim().length>0,true);" : "require('node:assert/strict').equal(1,2)");

  return JSON.stringify({ ...testingResult, artifacts: ["tests/case.cjs"] });
}

test("builtin testing runs plan, DSH implementation, independent assertions and read-only Codex review on one baseline", async () => {
  const f = await fixture(undefined, { dsh: true, response: (input) => input.prompt.startsWith("Analyze") ? JSON.stringify(testingPlan)
    : input.prompt.startsWith("Implement") ? testImplementation(input) : JSON.stringify(testingResult) });

  try {
    const run = await f.workflows.run({ ...f.scope, builtin: "testing-coordination", args: testingContract, writeMode: "allowed" });
    const final = await f.workflows.wait(run.id, f.scope, 10_000);
    assert.equal(final.status, "completed", JSON.stringify(final));
    assert.equal(unsafeResult(final.result).status, "completed");
    const calls = f.workflows.calls(run.id, f.scope);
    assert.deepEqual(calls.map((call) => call.options.target), ["codex", "dsh", "codex"]);
    assert.equal(new Set(calls.map((call) => call.workspaceRoot)).size, 1);
    assert.notEqual(calls[0]!.workspaceRoot, f.root);
    assert.deepEqual(calls.map((call) => call.options.writeMode), ["read_only", "allowed", "read_only"]);
    const events = f.workflows.events(run.id, f.scope);
    const evidence = events.find((event) => event.type === "testing_verification");
    assert.ok(evidence);
    const record = unsafeResult(evidence.data);
    const verification = JSON.parse(await readFile(String(record.path), "utf8"));
    assert.equal(verification.passed, true);
    assert.equal(verification.exitCode, 0);
    assert.ok(events.some((event) => event.type === "testing_acceptance"));
    await assert.rejects(f.workflows.run({ ...f.scope, resume: run.id }), /never replayed/);
  } finally { await f.close(); }
});

function unsafeResult(value: WireInput): Record<string, WireInput> {
  // SAFETY: Test assertions inspect JSON objects produced by the workflow runtime.
  return value as Record<string, WireInput>;
}

test("builtin blocks upstream ambiguity without starting DSH", async () => {
  const f = await fixture(undefined, { dsh: true, response: () => JSON.stringify({ ...testingPlan, status: "blocked", unresolved: ["Missing expected behavior"], nextOwner: "human" }) });

  try {
    const run = await f.workflows.run({ ...f.scope, builtin: "testing-coordination", args: testingContract, writeMode: "allowed" });
    const final = await f.workflows.wait(run.id, f.scope, 10_000);
    assert.equal(final.status, "completed");
    assert.equal(unsafeResult(final.result).status, "blocked");
    assert.equal(f.inputs.length, 1);
  } finally { await f.close(); }
});

test("malformed testing output preserves bounded redacted evidence for Codex diagnosis", async () => {
  const token = "x".repeat(60);
  const malformed = (stage: string) => `${stage}: Authorization: Bearer ${token}\n${".".repeat(5000)}`;

  const f = await fixture(undefined, { dsh: true, response: (input) => {
    if (input.prompt.startsWith("Analyze")) return JSON.stringify(testingPlan);

    if (input.prompt.startsWith("Implement")) {
      assert.match(input.prompt, /without Markdown code fences/);
      testImplementation(input);

      return malformed("INITIAL_BAD_OUTPUT");
    }

    if (input.prompt.startsWith("Your last response")) {
      assert.match(input.prompt, /without Markdown code fences/);

      return malformed("CORRECTED_BAD_OUTPUT");
    }

    assert.ok(input.prompt.startsWith("Diagnose"));
    assert.match(input.prompt, /CORRECTED_BAD_OUTPUT/);
    assert.match(input.prompt, /remainingCalls/);
    assert.equal(input.prompt.includes(token), false);

    return JSON.stringify({ ...testingResult, status: "blocked", repairable: false, instructions: "", uncertainty: "high", unresolved: ["Host must inspect the invalid output"], nextOwner: "human" });
  } });

  try {
    const run = await f.workflows.run({ ...f.scope, builtin: "testing-coordination", args: testingContract, writeMode: "allowed" });
    const final = await f.workflows.wait(run.id, f.scope, 10_000);
    assert.equal(unsafeResult(final.result).status, "blocked");
    const events = f.workflows.events(run.id, f.scope).filter((event) => event.type === "testing_invalid_output");
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((event) => unsafeResult(event.data).stage), ["initial", "correction"]);
    assert.ok(events.every((event) => unsafeResult(event.data).responseTruncated === true));
    assert.ok(events.every((event) => String(unsafeResult(event.data).response).length <= 2048));
    assert.equal(JSON.stringify(events).includes(token), false);
    assert.deepEqual(f.inputs.map((input) => input.writeMode), ["read_only", "allowed", "read_only", "read_only"]);
    assert.equal(f.workflows.calls(run.id, f.scope).filter((call) => call.options.coordination?.kind === "implementation").length, 1);
    assert.ok(!f.workflows.events(run.id, f.scope).some((event) => event.type === "testing_acceptance"));
  } finally { await f.close(); }
});

test("failed independent verification is diagnosed before bounded repair and rerun", async () => {
  let implementations = 0;

  const f = await fixture(undefined, { dsh: true, response: (input) => {
    if (input.prompt.startsWith("Analyze")) return JSON.stringify(testingPlan);

    if (input.prompt.startsWith("Implement")) return testImplementation(input, ++implementations > 1);

    if (input.prompt.startsWith("Diagnose")) return JSON.stringify({ ...testingResult, repairable: true, instructions: "Fix the failing test assertion", uncertainty: "low", nextOwner: "dsh" });

    return JSON.stringify(testingResult);
  } });

  try {
    const run = await f.workflows.run({ ...f.scope, builtin: "testing-coordination", args: testingContract, writeMode: "allowed" });
    const final = await f.workflows.wait(run.id, f.scope, 10_000);
    assert.equal(unsafeResult(final.result).status, "completed", JSON.stringify(final));
    assert.equal(unsafeResult(final.result).repairCount, 1);
    assert.deepEqual(f.workflows.calls(run.id, f.scope).map((call) => call.options.coordination?.kind), ["analysis", "implementation", "analysis", "implementation", "review"]);
    const records = f.workflows.events(run.id, f.scope).filter((event) => event.type === "testing_verification");
    assert.equal(records.length, 2);
    const checks = await Promise.all(records.map(async (event) => JSON.parse(await readFile(String(unsafeResult(event.data).path), "utf8"))));
    assert.deepEqual(checks.map((check) => check.passed), [false, true]);
  } finally { await f.close(); }
});

test("two repairs cover the whole task and provider changes do not reset the budget", async () => {
  const f = await fixture(undefined, { dsh: true, response: (input) => {
    if (input.prompt.startsWith("Analyze")) return JSON.stringify(testingPlan);

    if (input.prompt.startsWith("Implement")) return testImplementation(input, false);

    return JSON.stringify({ ...testingResult, repairable: true, instructions: "Fix this assertion", uncertainty: "low", nextOwner: "codex" });
  } });

  try {
    const run = await f.workflows.run({ ...f.scope, builtin: "testing-coordination", args: testingContract, writeMode: "allowed" });
    const final = await f.workflows.wait(run.id, f.scope, 10_000);
    assert.equal(unsafeResult(final.result).status, "blocked", JSON.stringify(final));
    assert.equal(unsafeResult(final.result).repairCount, 2);
    const implementation = f.workflows.calls(run.id, f.scope).filter((call) => call.options.coordination?.kind === "implementation");
    assert.deepEqual(implementation.map((call) => call.options.target), ["dsh", "codex", "codex"]);
  } finally { await f.close(); }
});

test("builtin requires explicit committed baseline for dirty input and enforces the total call budget", async () => {
  const f = await fixture(undefined, { dsh: true, response: (input) => input.prompt.startsWith("Analyze") ? JSON.stringify(testingPlan) : testImplementation(input) });

  try {
    await writeFile(join(f.root, "dirty.txt"), "preserve");
    await assert.rejects(f.workflows.run({ ...f.scope, builtin: "testing-coordination", args: testingContract, writeMode: "allowed" }), /uncommitted inputs/);
    const run = await f.workflows.run({ ...f.scope, builtin: "testing-coordination", args: { ...testingContract, baseRef: "HEAD", maxCalls: 1 }, writeMode: "allowed" });
    const final = await f.workflows.wait(run.id, f.scope, 10_000);
    assert.equal(final.status, "failed");
    assert.equal(final.error?.code, "WORKFLOW_CALL_LIMIT");
    assert.equal(f.inputs.length, 1);
    assert.equal(await readFile(join(f.root, "dirty.txt"), "utf8"), "preserve");
  } finally { await f.close(); }
});

test("Shadow uses independent worktrees and reports quality without changing configuration", async () => {
  const f = await fixture(undefined, { dsh: true, response: (input) => input.prompt.startsWith("Analyze") ? JSON.stringify(testingPlan)
    : input.prompt.startsWith("Implement") ? testImplementation(input) : JSON.stringify(testingResult) });

  try {
    const run = await f.workflows.run({ ...f.scope, builtin: "testing-coordination", args: { ...testingContract, mode: "shadow" }, writeMode: "allowed" });
    const final = await f.workflows.wait(run.id, f.scope, 10_000);
    assert.equal(unsafeResult(final.result).status, "completed", JSON.stringify(final));
    const calls = f.workflows.calls(run.id, f.scope);
    const workers = calls.filter((call) => call.options.coordination?.kind === "implementation");
    assert.deepEqual(workers.map((call) => call.options.target), ["codex", "dsh"]);
    assert.notEqual(workers[0]!.workspaceRoot, workers[1]!.workspaceRoot);
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: workers[0]!.workspaceRoot, encoding: "utf8" }), execFileSync("git", ["rev-parse", "HEAD"], { cwd: workers[1]!.workspaceRoot, encoding: "utf8" }));
    assert.match(String(unsafeResult(final.result).recommendation), /explicitly enabling/);
  } finally { await f.close(); }
});

test("missing committed inputs block before any model dispatch", async () => {
  const f = await fixture(undefined, { dsh: true });

  try {
    const run = await f.workflows.run({ ...f.scope, builtin: "testing-coordination", args: { ...testingContract, inputs: ["missing-spec.md"] }, writeMode: "allowed" });
    const final = await f.workflows.wait(run.id, f.scope, 10_000);
    assert.equal(final.status, "failed");
    assert.match(final.error?.message ?? "", /missing-spec.md/);
    assert.equal(f.inputs.length, 0);
  } finally { await f.close(); }
});

test("JSON corrections consume the builtin call budget and use reduced authority", async () => {
  const f = await fixture(undefined, { dsh: true, response: (input) => input.prompt.startsWith("Your last response") ? JSON.stringify(testingPlan) : "invalid-json" });

  try {
    const run = await f.workflows.run({ ...f.scope, builtin: "testing-coordination", args: { ...testingContract, maxCalls: 2 }, writeMode: "allowed" });
    const final = await f.workflows.wait(run.id, f.scope, 10_000);
    assert.equal(final.error?.code, "WORKFLOW_CALL_LIMIT");
    assert.equal(f.inputs.length, 2);
    assert.equal(f.inputs[1]?.writeMode, "read_only");
  } finally { await f.close(); }
});

test("read-only planning or implementation scope escapes block acceptance and retain the worktree", async () => {
  for (const phase of ["Analyze", "Implement"]) {
    const f = await fixture(undefined, { dsh: true, response: (input) => {
      if (input.prompt.startsWith(phase)) writeFileSync(join(input.workspaceRoot, "business.txt"), "unexpected mutation");

      return JSON.stringify(input.prompt.startsWith("Analyze") ? testingPlan : testingResult);
    } });

    try {
      const run = await f.workflows.run({ ...f.scope, builtin: "testing-coordination", args: testingContract, writeMode: "allowed" });
      const final = await f.workflows.wait(run.id, f.scope, 10_000);

      if (phase === "Analyze") assert.equal(final.error?.code, "TESTING_SCOPE");
      else assert.equal(unsafeResult(final.result).status, "blocked");
      const worker = f.workflows.calls(run.id, f.scope).at(-1)!;
      assert.equal(await readFile(join(worker.workspaceRoot, "business.txt"), "utf8"), "unexpected mutation");
      assert.equal(f.workflows.events(run.id, f.scope).some((event) => event.type === "testing_acceptance"), false);
    } finally { await f.close(); }
  }
});

test("Codex diagnoses partial provider writes before taking over the same bounded task", async () => {
  let implementations = 0;

  const f = await fixture(undefined, { dsh: true, response: (input) => {
    if (input.prompt.startsWith("Analyze")) return JSON.stringify(testingPlan);

    if (input.prompt.startsWith("Implement")) {
      if (++implementations === 1) {
        mkdirSync(join(input.workspaceRoot, "tests"));
        writeFileSync(join(input.workspaceRoot, "tests/partial.txt"), "retained partial write");
        throw new AgentProviderExecutionError({ code: "PROVIDER_EXECUTION_ERROR", provider: "dsh", operation: "run", retryable: false, message: "provider disconnected after partial write" });
      }

      return testImplementation(input);
    }

    if (input.prompt.startsWith("Diagnose")) return JSON.stringify({ ...testingResult, repairable: true, instructions: "Complete the test; preserve the partial-write evidence", uncertainty: "low", nextOwner: "codex" });

    return JSON.stringify(testingResult);
  } });

  try {
    const run = await f.workflows.run({ ...f.scope, builtin: "testing-coordination", args: testingContract, writeMode: "allowed" });
    const final = await f.workflows.wait(run.id, f.scope, 10_000);
    assert.equal(final.status, "completed", JSON.stringify({ final, calls: f.workflows.calls(run.id, f.scope).map((call) => ({phase:call.options.phase, status:call.status, error:call.error})) }));
    assert.equal(unsafeResult(final.result).status, "completed", JSON.stringify(final));
    const calls = f.workflows.calls(run.id, f.scope);
    assert.deepEqual(calls.map((call) => call.options.target), ["codex", "dsh", "codex", "codex", "codex"]);
    assert.equal(calls[1]?.status, "failed");
    assert.equal(new Set(calls.map((call) => call.workspaceRoot)).size, 1);
    assert.equal(await readFile(join(calls[1]!.workspaceRoot, "tests/partial.txt"), "utf8"), "retained partial write");
  } finally { await f.close(); }
});

test("an elapsed absolute budget blocks dispatch even before timer callbacks run", async (t) => {
  const f = await fixture(async (input) => {
    t.mock.timers.tick(1001);

    return input.onAgent("Late task", { target: "codex" });
  });

  try {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const run = await f.workflows.run({ ...f.scope, builtin: "testing-coordination", args: { ...testingContract, timeoutMs: 1000 }, writeMode: "allowed" });
    const final = await f.workflows.wait(run.id, f.scope, 10_000);
    assert.equal(final.error?.code, "WORKFLOW_TIMEOUT");
    assert.equal(f.inputs.length, 0);
  } finally { t.mock.timers.reset(); await f.close(); }
});

test("unexpected execution-layer internal errors stop admission even when the guest catches them", async () => {
  const f = await fixture(undefined, { response: () => { throw new Error("unexpected internal defect"); } });

  try {
    const run = await f.workflows.run({ ...f.scope, source: `try { await agent('first',{target:'codex'}); } catch {} return agent('must not start',{target:'codex'});` });
    const final = await f.workflows.wait(run.id, f.scope, 10_000);
    assert.equal(final.error?.code, "AGENT_INTERNAL_ERROR");
    assert.equal(f.inputs.length, 1);
  } finally { await f.close(); }
});
