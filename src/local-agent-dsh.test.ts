import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { DshLocalAgentDriver } from "./local-agent-dsh.js";
import { DshSdkConnection } from "./local-agent-dsh-rpc.js";
import type { JsonObject } from "./json-value.js";
import type { LocalAgentActivityEvent } from "./local-agent-events.js";

const context = (root: string) => ({ agentId: "agt_dsh_test", providerInstanceId: "dsh", provider: "dsh" as const, workspaceRoot: root, writeMode: "allowed" as const });

// This fixture verifies the SDK boundary, not the provider's sandbox or model quality.
async function fakeDsh(t: TestContext, root: string): Promise<string> {
  const file = join(root, "fake-dsh.mjs");
  await writeFile(file, `#!/usr/bin/env node
import readline from 'node:readline';
import {appendFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
const scenario = process.env.DEVSPACE_DSH_TEST_SCENARIO;
const log = value => { if (process.env.DEVSPACE_DSH_TEST_LOG) appendFileSync(process.env.DEVSPACE_DSH_TEST_LOG, JSON.stringify(value) + '\\n'); };
const out = value => process.stdout.write(JSON.stringify(value) + '\\n');
log({launch:process.argv.slice(2),pid:process.pid});
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  log(request);
  if (request.method === 'initialize') {
    if (scenario === 'malformed') { process.stdout.write('invalid-json\\n'); return; }
    if (scenario === 'exit') { process.exit(7); return; }
    if (scenario === 'timeout') return;
    out({jsonrpc:'2.0',id:request.id,result:{serverInfo:{name:'deepseek-harness-sdk-runtime',version:'test'}}});
  }
  else if (request.method === 'session/query') {
    if (scenario === 'unsupported') { out({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'unknown method session/query'}}); return; }
    out({jsonrpc:'2.0',id:request.id,result:{kind:'command',execution:{commandId:'cmd',result:{kind:'success',text:scenario === 'mismatch' ? 'ignored' : 'preset '+request.params.contentBlocks[0].text.slice(12)}}}});
  }
  else if (request.method === 'session/working-directory/get') out({jsonrpc:'2.0',id:request.id,result:{cwd:scenario === 'wrong-directory' ? process.env.DEVSPACE_DSH_TEST_OUTSIDE : process.cwd()}});
  else if (request.method === 'session/resume') out({jsonrpc:'2.0',id:request.id,result:{}});
  else if (request.method === 'session/prompt') {
    out({jsonrpc:'2.0',id:request.id,result:{messageId:'m'}});
    const event = (type,data) => out({jsonrpc:'2.0',method:'session.event',params:{sessionId:request.params.sessionId,event:{type,data}}});
    if (scenario === 'hold') {
      const child = spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
      log({toolPid:child.pid});
      event('tool/call',{name:'bash',callId:'held',arguments:'{"command":"sleep"}'});
      return;
    }
    event('tool/call',{name:'read',callId:'tool-1',arguments:'{"path":"test.txt"}'});
    event('tool/result',{message:{toolCallId:'tool-1',isError:false}});
    if (scenario !== 'empty') event('assistant/message',{message:{content:[{type:'text',text:'done'}]}});
    if (scenario === 'question') out({jsonrpc:'2.0',id:'host-question',method:'user-question/ask',params:{sessionId:request.params.sessionId,questions:[]}});
    if (scenario === 'approval') out({jsonrpc:'2.0',id:'host-approval',method:'approval/request',params:{sessionId:request.params.sessionId}});
    event('turn/end',{reason:{kind:scenario === 'failed' ? 'failed' : 'completed'}});
  }
  else if (request.method === 'session/wait' || request.method === 'shutdown') out({jsonrpc:'2.0',id:request.id,result:{}});
});\n`);
  await chmod(file, 0o700);
  t.after(() => rm(file, { force: true }));

  return file;
}

test("DSH adapter enforces the native permission command and maps a completed turn", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "devspace-dsh-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = await fakeDsh(t, root);
  const driver = new DshLocalAgentDriver({ command });
  const runtime = await driver.createRuntime({ ...context(root), agentId: command });

  assert.equal(runtime.isOk(), true);

  if (runtime.isErr()) return;
  const result = await runtime.value.run({ prompt: "test", workspaceRoot: root, writeMode: "allowed" });

  assert.equal(result.isOk(), true, result.isErr() ? result.error.message : "");

  if (result.isOk()) assert.equal(result.value.finalResponse, "done");
  await runtime.value.close();
});

async function fixture(t: TestContext, scenario = "completed") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "devspace-dsh-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = await fakeDsh(t, root);
  const log = join(root, "requests.jsonl");
  const env = { ...process.env, DEVSPACE_DSH_TEST_SCENARIO: scenario, DEVSPACE_DSH_TEST_LOG: log, DEVSPACE_DSH_TEST_OUTSIDE: tmpdir() };
  const driver = new DshLocalAgentDriver({ command, env });
  const created = await driver.createRuntime(context(root));
  assert.ok(created.isOk());
  const runtime = created.value;
  t.after(() => runtime.close());

  return { root, command, env, driver, runtime, requests: async (): Promise<JsonObject[]> => (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)) };
}

test("DSH sets permissions before prompting, reports its session and streams tool activity", async (t) => {
  const f = await fixture(t);
  const events: LocalAgentActivityEvent[] = [];
  const identities: string[] = [];

  const result = await f.runtime.run({ prompt: "test", workspaceRoot: f.root, writeMode: "allowed", model: "exact-model", effort: "high" }, {
    onSessionId: (id) => { identities.push(id); }, onEvent: (event) => events.push(event),
  });

  assert.ok(result.isOk(), result.isErr() ? result.error.message : "");
  assert.equal(result.value.providerSessionId, identities[0]);
  assert.deepEqual(events.map((event) => event.type), ["tool_started", "tool_completed", "message"]);
  const requests = await f.requests();
  assert.deepEqual(requests.filter((r) => r.method).map((r) => r.method), ["initialize", "session/query", "session/working-directory/get", "session/query", "session/prompt", "session/wait", "shutdown"]);
  assert.deepEqual(requests.find((r) => r.method === "initialize")?.params, {
    cwd: f.root, provider: "deepseek-official", model: "exact-model", reasoningEffort: "high", approvalRequests: true, capabilities: { userQuestions: true },
  });
  assert.match(JSON.stringify(requests.filter((r) => r.method === "session/query")), /workspace-write/);
});

test("DSH resume uses a fresh process and downgrades authority before prompting", async (t) => {
  const f = await fixture(t);
  const first = await f.runtime.run({ prompt: "first", workspaceRoot: f.root, writeMode: "allowed" });
  assert.ok(first.isOk());
  const second = await f.runtime.run({ prompt: "second", workspaceRoot: f.root, writeMode: "read_only", model: "new-model", effort: "low" });
  assert.ok(second.isOk(), second.isErr() ? second.error.message : "");
  assert.equal(second.value.providerSessionId, first.value.providerSessionId);
  const requests = await f.requests();
  assert.equal(requests.filter((r) => r.launch).length, 2);
  const afterResume = requests.slice(requests.findIndex((r) => r.method === "session/resume"));
  assert.deepEqual(afterResume[0]?.params, { sessionId: first.value.providerSessionId });
  assert.match(JSON.stringify(afterResume.find((r) => r.method === "session/query")), /\/permission read-only/);
  assert.match(JSON.stringify(requests.filter((r) => r.method === "initialize").at(-1)), /new-model/);
});

for (const scenario of ["unsupported", "mismatch", "wrong-directory", "malformed", "exit"]) {
  test(`DSH fails closed without prompting on ${scenario}`, async (t) => {
    const f = await fixture(t, scenario);
    const result = await f.runtime.run({ prompt: "must not run", workspaceRoot: f.root, providerSessionId: "persisted", writeMode: "read_only" });
    assert.ok(result.isErr());
    assert.ok(!(await f.requests()).some((r) => r.method === "session/prompt"));

    if (scenario === "unsupported" || scenario === "mismatch") assert.ok(!(await f.requests()).some((r) => r.method === "session/resume"));

    if (scenario === "unsupported") {
      assert.equal(result.error.code, "PROVIDER_PROTOCOL_ERROR");
      assert.equal(result.error.operation, "session/query");
    }
  });
}

test("restricted DSH turns reject approval escalation and return unanswered questions to the host", async (t) => {
  const approval = await fixture(t, "approval");
  assert.ok((await approval.runtime.run({ prompt: "test", workspaceRoot: approval.root, writeMode: "read_only" })).isOk());
  assert.deepEqual((await approval.requests()).find((r) => r.id === "host-approval")?.result, { outcome: "rejected" });
  const question = await fixture(t, "question");
  const blocked = await question.runtime.run({ prompt: "test", workspaceRoot: question.root });
  assert.ok(blocked.isErr());
  assert.equal(blocked.error.code, "PROVIDER_EXECUTION_ERROR");
  assert.match(blocked.error.message, /user input/);
  assert.deepEqual((await question.requests()).find((r) => r.id === "host-question")?.result, { cancelled: true });
});

test("failed or empty DSH turns cannot be reported as successful", async (t) => {
  for (const scenario of ["failed", "empty"]) {
    const f = await fixture(t, scenario);
    const result = await f.runtime.run({ prompt: "test", workspaceRoot: f.root });
    assert.ok(result.isErr());
    assert.equal(result.error.code, scenario === "failed" ? "PROVIDER_EXECUTION_ERROR" : "PROVIDER_PROTOCOL_ERROR");
  }
});

test("cancelling DSH waits for process exit before returning", async (t) => {
  const f = await fixture(t, "hold");
  const controller = new AbortController();

  const result = await f.runtime.run({ prompt: "hold", workspaceRoot: f.root, signal: controller.signal }, {
    onEvent: (event) => { if (event.type === "tool_started") controller.abort(); },
  });

  assert.ok(result.isErr());
  assert.equal(result.error.code, "PROVIDER_CANCELLED");
  const requests = await f.requests();
  const pid = requests.find((r) => r.pid !== undefined)?.pid;
  assert.equal(Number.isInteger(pid), true);
  assert.throws(() => process.kill(Number(pid), 0), /ESRCH/);
  assert.ok(requests.some((r) => r.method === "session/prompt"));
  const toolPid = requests.find((r) => r.toolPid !== undefined)?.toolPid;
  assert.equal(Number.isInteger(toolPid), true);
  assert.throws(() => process.kill(Number(toolPid), 0), /ESRCH/);
});

test("SDK request timeout closes the process", async (t) => {
  const f = await fixture(t, "timeout");
  const connection = new DshSdkConnection({ command: f.command, args: [], cwd: f.root, env: f.env }, () => {});
  t.after(() => connection.close());
  await assert.rejects(connection.request("initialize", {}, 100), /timed out/);
  await connection.close();
  assert.equal(connection.isAlive(), false);
});

test("workspace lookup failure does not leave a DSH runtime locked", async (t) => {
  const f = await fixture(t);
  assert.ok((await f.runtime.run({ prompt: "test", workspaceRoot: join(f.root, "missing") })).isErr());
  assert.ok((await f.runtime.run({ prompt: "retry", workspaceRoot: f.root })).isOk());
});
