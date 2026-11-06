import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { AcceptanceCommandError, observeAcceptance, reserveLiveBudget, runAcceptanceCli, type CommandRecord } from "./testing-coordination-harness.js";
import type { JsonValue, WireInput } from "../src/json-value.js";
import { ensureLocalAgentDaemonSecret, LOCAL_AGENT_DAEMON_PROTOCOL_VERSION, localAgentDaemonPaths } from "../src/local-agent-daemon-lifecycle.js";
import { decodeLocalAgentDaemonRequest, encodeLocalAgentDaemonResponse } from "../src/local-agent-daemon-protocol.js";
import { writeTestDevspaceConfig } from "../src/test-support/config.js";
import { restore, scrub } from "./agents-replay/transcript.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "ds-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  return { root, ledger: join(root, "budget.json") };
}

function unavailable() {
  return new AcceptanceCommandError({ args: ["agents", "daemon", "status"], stdout: '{"error":{"code":"DAEMON_UNAVAILABLE"}}', stderr: "", exitCode: 1, killed: false, signal: null });
}

const completed = { id: "wf_fixture", status: "completed", result: { status: "completed" } };

const events = [
  { sequence: 1, type: "agent_turn", data: { turnId: "plan", repair: false } },
  { sequence: 2, type: "agent_turn", data: { turnId: "format", repair: true } },
  { sequence: 3, type: "agent_turn", data: { turnId: "implement", repair: false } },
  { sequence: 4, type: "agent_turn", data: { turnId: "review", repair: false } },
];

const calls = ["format", "implement", "review"].map((turnId) => ({ turnId, status: "completed" }));

function mockCli(options: { blocked?: boolean; waitFailure?: boolean; startFailure?: boolean; missingEvents?: boolean; stopping?: boolean; callsFailure?: boolean } = {}) {
  const commands: string[][] = [];
  const final = options.blocked ? { ...completed, result: { status: "blocked" } } : completed;

  const cli = async (args: string[]): Promise<JsonValue> => {
    commands.push(args);

    if (args[0] === "agents") {
      if (args[2] === "stop") return { state: "stopping", pid: 12345 };
      throw unavailable();
    }

    switch (args[1]) {
      case "run":
        if (options.startFailure) throw new AcceptanceCommandError({ args, stdout: JSON.stringify({ id: final.id, status: "running" }), stderr: "", exitCode: null, killed: true, signal: "SIGKILL" });

        return { id: final.id, status: "running" };
      case "wait":
        if (options.waitFailure) throw new Error("transport failed after partial writes");

        return options.stopping ? { ...final, status: "stopping" } : final;
      case "cancel": return { id: final.id, status: "stopping" };
      case "status": return options.stopping ? { ...final, status: "stopping" } : final;
      case "calls":
        if (options.callsFailure) throw new Error("calls unavailable");

        return calls;
      case "events":
        if (options.missingEvents) throw new Error("events unavailable");

        return args.at(-1) === "0" ? events : [];
      default: throw new Error(`Unexpected offline command: ${args}`);
    }
  };

  return { cli, commands, isProcessAlive: () => false };
}

test("budget reserves exclusively, counts format corrections, and retains cumulative usage", async (t) => {
  const { root, ledger } = await fixture(t);
  await writeFile(ledger, JSON.stringify({ calls: 2, elapsedMs: 1000 }));
  const budget = await reserveLiveBudget(ledger, root);
  assert.equal(budget.remainingCalls, 10);
  assert.equal(JSON.parse(await readFile(ledger, "utf8")).reserved, true);
  await assert.rejects(reserveLiveBudget(ledger, root), { code: "EEXIST" });
  const observation = await observeAcceptance({ ...mockCli(), startArgs: ["workflow", "run"], timeoutMs: 10_000 });
  assert.equal(observation.passed, true);
  await budget.settle(observation);
  await budget.release();
  const actual = JSON.parse(await readFile(ledger, "utf8"));
  assert.equal(actual.calls, 6, "three calls plus one schema correction, with previous usage");
  assert.ok(actual.elapsedMs >= 1000);
  assert.equal(actual.reserved, undefined);
});

for (const [name, content] of [
  ["malformed JSON", "{"], ["invalid counters", '{"calls":-1,"elapsedMs":0}'],
  ["reserved", '{"calls":0,"elapsedMs":0,"reserved":true}'], ["exhausted", '{"calls":0,"elapsedMs":0,"exhausted":true}'],
  ["calls spent", '{"calls":12,"elapsedMs":0}'], ["time spent", '{"calls":1,"elapsedMs":2000628}'],
] as const) {
  test(`budget fails closed for ${name} without changing existing ledger`, async (t) => {
    const { root, ledger } = await fixture(t);
    await writeFile(ledger, content);
    await assert.rejects(reserveLiveBudget(ledger, root));
    assert.equal(await readFile(ledger, "utf8"), content);
    await assert.rejects(readFile(`${ledger}.lock`), { code: "ENOENT" });
  });
}

test("a non-file ledger is not treated as an absent ledger", async (t) => {
  const { root, ledger } = await fixture(t);
  await mkdir(ledger);
  await assert.rejects(reserveLiveBudget(ledger, root), /regular file/);
});

test("replay recognizes native canonical paths while restoring the configured workspace spelling", async (t) => {
  const { root } = await fixture(t);
  const workspace = join(root, "project");
  const alias = join(root, "alias");
  await mkdir(workspace);
  await symlink(workspace, alias, process.platform === "win32" ? "junction" : "dir");
  const context = { workspace: alias, home: root, tmp: tmpdir() };
  const canonical = await realpath(alias);
  assert.equal(scrub(canonical, context), "$WORKSPACE");
  assert.equal(scrub(alias, context), "$WORKSPACE");
  assert.equal(scrub(canonical.replaceAll("\\", "/"), context), "$WORKSPACE");
  assert.equal(restore("$WORKSPACE", context), alias);
  assert.notEqual(scrub(join(root, "unrelated"), context), "$WORKSPACE");
});

test("interruption or missing turn evidence keeps reservation across restart", async (t) => {
  const { root, ledger } = await fixture(t);
  const budget = await reserveLiveBudget(ledger, root);
  const observation = await observeAcceptance({ ...mockCli(), startArgs: ["workflow", "run"], timeoutMs: 10_000 });
  observation.events = [];
  await budget.settle(observation);
  await budget.release();
  await assert.rejects(reserveLiveBudget(ledger, root), /reserved/);
});

test("script completion with a blocked business result is not acceptance", async () => {
  const result = await observeAcceptance({ ...mockCli({ blocked: true }), startArgs: ["workflow", "run"], timeoutMs: 10_000 });
  assert.equal(result.final?.status, "completed");
  assert.equal(result.passed, false);
  assert.equal(result.stopConfirmed, true);
});

test("a CLI wait failure still cancels and collects partial work evidence", async () => {
  const mock = mockCli({ waitFailure: true });
  const result = await observeAcceptance({ ...mock, startArgs: ["workflow", "run"], timeoutMs: 10_000 });
  assert.equal(result.passed, false);
  assert.equal(result.calls.length, 3);
  assert.equal(result.events.length, 4);
  assert.ok(mock.commands.some((args) => args[1] === "cancel"));
  assert.match(result.errors.join(), /partial writes/);
});

test("a killed start's JSON receipt is only a cleanup hint", async () => {
  const mock = mockCli({ startFailure: true });
  const result = await observeAcceptance({ ...mock, startArgs: ["workflow", "run"], timeoutMs: 10_000 });
  assert.equal(result.passed, false);
  assert.equal(result.calls.length, 3);
  assert.ok(mock.commands.some((args) => args[1] === "cancel"));
});

test("unconfirmed stop and missing evidence never release allowance", async (t) => {
  const { root, ledger } = await fixture(t);
  const budget = await reserveLiveBudget(ledger, root);
  let tick = 0;
  const mock = mockCli({ stopping: true, missingEvents: true });
  const result = await observeAcceptance({ ...mock, startArgs: ["workflow", "run"], timeoutMs: 10, now: () => tick++ * 10 });
  assert.equal(result.stopConfirmed, false);
  assert.equal(result.passed, false);
  assert.match(result.errors.join(), /deadline/);
  await budget.settle(result);
  await budget.release();
  assert.equal(JSON.parse(await readFile(ledger, "utf8")).reserved, true);
});

test("events are collected even if calls cannot be read", async () => {
  const result = await observeAcceptance({ ...mockCli({ callsFailure: true }), startArgs: ["workflow", "run"], timeoutMs: 10_000 });
  assert.equal(result.events.length, 4);
  assert.equal(result.stopConfirmed, false);
  assert.equal(result.passed, false);
});

test("zero remaining wall-clock budget cannot dispatch a model task", async () => {
  const mock = mockCli();
  const result = await observeAcceptance({ ...mock, startArgs: ["workflow", "run"], timeoutMs: 0 });
  assert.equal(result.passed, false);
  assert.equal(mock.commands.some((args) => args[0] === "workflow"), false);
  assert.match(result.errors.join(), /before dispatch/);
});

test("daemon stop acknowledgement alone cannot pass acceptance", async () => {
  const mock = mockCli();
  const result = await observeAcceptance({ ...mock, cli: (args) => args[0] === "agents" && args[2] === "stop" ? Promise.reject(new Error("stop denied")) : mock.cli(args), startArgs: ["workflow", "run"], timeoutMs: 10_000 });
  assert.equal(result.daemonStopped, false);
  assert.equal(result.passed, false);
  assert.match(result.errors.join(), /stop denied/);
});

test("an unavailable daemon endpoint while its PID lives is not confirmed termination", async () => {
  const result = await observeAcceptance({ ...mockCli(), isProcessAlive: () => true, startArgs: ["workflow", "run"], timeoutMs: 10_000 });
  assert.equal(result.daemonStopped, false);
  assert.equal(result.passed, false);
  assert.match(result.errors.join(), /termination not confirmed/);
});

test("offline harness traverses the real CLI and daemon codec, collecting complete evidence", async (t) => {
  // Keep the Unix socket path within macOS's 104-byte limit.
  const directory = await mkdtemp(join(tmpdir(), "ds-h-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = await realpath(directory);
  const stateDir = join(directory, "state");

  const env = { ...process.env, ...writeTestDevspaceConfig(join(root, "config"), { workspaces: { allowedRoots: [root] }, storage: { stateDir } }),
    DEVSPACE_WORKSPACE_ROOT: root, DEVSPACE_WORKSPACE_ID: "ws_offline", DEVSPACE_EXPERIMENTAL_WORKFLOWS: "1" };

  const paths = localAgentDaemonPaths(stateDir);
  ensureLocalAgentDaemonSecret(paths);
  const requests: string[] = [];

  const run = { ...completed, workspaceRoot: root, workspaceId: "ws_offline", name: "offline fixture", writeMode: "allowed", concurrency: 1,
    createdAt: "now", updatedAt: "now", callCount: 3 };

  let stopping = false;

  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;

      if (!buffer.includes("\n")) return;
      const request = decodeLocalAgentDaemonRequest(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))));
      requests.push(request.method);

      const status = { state: stopping ? "stopping" : "ready", protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION, pid: process.pid,
        endpoint: paths.endpoint, startedAt: "now", activeTurns: 0, runtimeCount: 0, clientConnections: 1 };

      let result: JsonValue = run;

      if (request.method === "hello") result = { status, configMatches: true };

      if (request.method === "workflow.run") result = { ...run, status: "running" };

      if (request.method === "workflow.calls") result = calls.map((call, index) => ({ ...call, index, runId: run.id, agentId: `agt_${index}`, workspaceRoot: root, workspaceId: "ws_offline",
        prompt: "offline", fingerprint: "fixture", options: { target: index === 1 ? "dsh" : "codex" }, createdAt: "now", updatedAt: "now" }));

      if (request.method === "workflow.events") result = request.params.after === 0 ? events.map((event) => ({ ...event, runId: run.id, createdAt: "now" })) : [];

      if (request.method === "daemon.stop") { stopping = true; result = { ...status, state: "stopping" }; }

      if (request.method === "daemon.status" && stopping) {
        socket.end(encodeLocalAgentDaemonResponse({ requestId: request.requestId, protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION, ok: false,
          error: { code: "DAEMON_UNAVAILABLE", operation: "daemon.status", retryable: true, message: "Offline fixture stopped" } }));
      } else socket.end(encodeLocalAgentDaemonResponse({ requestId: request.requestId, protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION, ok: true, result }));
    });
  });

  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(paths.endpoint, resolve); });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const wrapper = join(root, "cli.mjs");
  const sourceCli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  await writeFile(wrapper, `import {spawnSync} from 'node:child_process'; const result=spawnSync(process.execPath,['--import',${JSON.stringify(import.meta.resolve("tsx"))},${JSON.stringify(sourceCli)},...process.argv.slice(2)],{stdio:'inherit'});process.exitCode=result.status??1;`);
  const records: CommandRecord[] = [];

  const observation = await observeAcceptance({
    cli: (args, timeoutMs) => runAcceptanceCli({ cliPath: wrapper, cwd: root, env, args, timeoutMs, record: async (value) => { records.push(value); } }),
    startArgs: ["workflow", "run", "--builtin", "testing-coordination", "--args", "{}", "--write-mode", "allowed"], timeoutMs: 30_000,
    // The fixture endpoint is simulated in this process; production uses OS PID liveness.
    isProcessAlive: () => false,
  });

  assert.equal(observation.passed, true, JSON.stringify(observation));
  assert.equal(observation.calls.length, 3);
  assert.equal(observation.events.length, 4);
  assert.ok(requests.includes("workflow.run"));
  assert.ok(requests.includes("daemon.stop"));
  assert.ok(records.at(-1)?.stdout.includes("DAEMON_UNAVAILABLE"));
});

test("real child process nonzero exit preserves JSON stdout and stderr as failure evidence", async (t) => {
  const { root } = await fixture(t);
  const cliPath = join(root, "cli.cjs");
  await writeFile(cliPath, `console.log('{"status":"completed"}');console.error('original diagnostic');process.exitCode=7;`);
  const records: CommandRecord[] = [];
  await assert.rejects(runAcceptanceCli({ cliPath, cwd: root, env: {}, args: [], record: async (value) => { records.push(value); } }), (error: WireInput) => error instanceof AcceptanceCommandError && error.record.exitCode === 7);
  assert.equal(records[0]?.stdout.trim(), '{"status":"completed"}');
  assert.match(records[0]!.stderr, /original diagnostic/);
});

test("real child timeout with valid JSON cannot be misclassified as a completed workflow", async (t) => {
  const { root } = await fixture(t);
  const cliPath = join(root, "cli.cjs");
  await writeFile(cliPath, `console.log('{"id":"wf_fixture","status":"running"}');setInterval(()=>{},1000);`);
  const records: CommandRecord[] = [];
  await assert.rejects(runAcceptanceCli({ cliPath, cwd: root, env: {}, args: [], timeoutMs: 500, record: async (value) => { records.push(value); } }), AcceptanceCommandError);
  assert.equal(records[0]?.killed, true);
  assert.match(records[0]!.stdout, /wf_fixture/);
});
