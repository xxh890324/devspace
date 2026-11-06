import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { executeTestingCheck, inspectTestingWorkspace, testingGit } from "./workflow-evidence.js";
import { parseTestingRun } from "./workflow-testing.js";
import { WorkflowTestingSession } from "./workflow-testing-session.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "devspace-evidence-"));
  const root = await realpath(directory);
  execFileSync("git", ["init", "-q"], { cwd: root });
  await writeFile(join(root, "app.cjs"), "module.exports = value => value.trim().length > 0;\n");
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  await mkdir(join(root, "tests"));
  await writeFile(join(root, "tests", "case.cjs"), "const assert = require('node:assert/strict'); const valid = require('../app.cjs'); assert.equal(valid(''), false); assert.equal(valid(' x '), true);\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "-qm", "base"], { cwd: root });
  const base = (await testingGit(root, ["rev-parse", "HEAD"])).trim();

  const config = parseTestingRun({ task: "Test validation", allowedPaths: ["tests"], artifacts: ["tests/case.cjs"], acceptance: ["Validation matches requirements"],
    checks: [{ id: "unit", executable: process.execPath, args: ["-e", "require('./tests/case.cjs'); require('node:fs').writeFileSync('tests/results.json', JSON.stringify({passed:2}))"], reports: ["tests/results.json"] }] });

  return { root, base, config, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("testing contracts reject traversal, duplicate IDs and report/artifact conflicts", () => {
  const value = { task: "task", allowedPaths: ["tests"], artifacts: ["tests/case.js"], acceptance: ["ok"], checks: [{ id: "test", executable: "node" }] };
  assert.equal(parseTestingRun(value).maxRepairs, 2);

  for (const path of ["../x", "/tmp/x", "C:/x", "tests/.git/x", "tests/../x", "tests\\x"]) assert.throws(() => parseTestingRun({ ...value, allowedPaths: [path] }));
  assert.throws(() => parseTestingRun({ ...value, maxRepairs: 3 }));
  assert.throws(() => parseTestingRun({ ...value, checks: [value.checks[0], value.checks[0]] }));
  assert.throws(() => parseTestingRun({ ...value, checks: [{ id: "test", executable: "node", reports: value.artifacts }] }));
});

test("inspection detects deletion, rename, ignored/untracked scope escapes and symlinks", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  await rename(join(f.root, "tests/case.cjs"), join(f.root, "tests/renamed.cjs"));
  let inspection = await inspectTestingWorkspace(f.root, "w", f.base, f.config, []);
  assert.deepEqual(inspection.changed.map((file) => [file.path, file.status]), [["tests/case.cjs", "D"], ["tests/renamed.cjs", "?"]]);
  await writeFile(join(f.root, "ignored.txt"), "outside");
  inspection = await inspectTestingWorkspace(f.root, "w", f.base, f.config, []);
  assert.match(inspection.violations.join("\n"), /outside allowedPaths: ignored.txt/);

  if (process.platform !== "win32") {
    await symlink(join(f.root, "app.cjs"), join(f.root, "tests/link.cjs"));
    inspection = await inspectTestingWorkspace(f.root, "w", f.base, f.config, []);
    assert.match(inspection.violations.join("\n"), /Symlinks/);
  }
});

test("independent verification records assertions, detects failures and requires fresh reports", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const check = f.config.checks[0]!;
  const signal = new AbortController().signal;
  const execute = (args: string[]) => executeTestingCheck(f.root, "w", f.base, f.config, { ...check, args }, signal);
  const passed = await execute(check.args);
  assert.equal(passed.passed, true);
  assert.equal(passed.reports[0]?.path, "tests/results.json");
  assert.equal(passed.inputDigest, passed.outputDigest);
  const missing = await execute(["-e", "process.exit(0)"]);
  assert.equal(missing.passed, false);
  assert.match(missing.violations.join("\n"), /Missing report/);
  const failed = await execute(["-e", "require('node:assert/strict').equal(1,2)"]);
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.passed, false);
  const modified = await execute(["-e", "require('node:fs').appendFileSync('tests/case.cjs', '//weakened')"]);
  assert.match(modified.violations.join("\n"), /modified files/);
});

test("verification bounds output, times out, cancels and kills delayed descendant writes", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const check = { ...f.config.checks[0]!, reports: [], maxOutputBytes: 256 };
  const result = await executeTestingCheck(f.root, "w", f.base, f.config, { ...check, args: ["-e", "process.stdout.write('x'.repeat(10000))"] }, new AbortController().signal);
  assert.equal(result.outputTruncated, true);
  assert.equal(Buffer.byteLength(result.output), 256);
  const timeout = await executeTestingCheck(f.root, "w", f.base, f.config, { ...check, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 100 }, new AbortController().signal);
  assert.equal(timeout.timedOut, true);
  assert.equal(timeout.passed, false);
  const controller = new AbortController();
  const promise = executeTestingCheck(f.root, "w", f.base, f.config, { ...check, args: ["-e", "require('node:child_process').spawn(process.execPath, ['-e', \"setTimeout(()=>require('node:fs').writeFileSync('tests/late','bad'), 800)\"], {stdio:'inherit'});setInterval(()=>{},1000)"] }, controller.signal);
  setTimeout(() => controller.abort(new Error("cancelled by host")), 300);
  await assert.rejects(promise, /cancelled by host/);
  await new Promise((done) => setTimeout(done, 850));
  await assert.rejects(readFile(join(f.root, "tests/late")));
});

test("runtime disallows undeclared commands and invalidates review evidence after source/report edits", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const state = await mkdtemp(join(tmpdir(), "devspace-evidence-state-")); t.after(() => rm(state, { recursive: true, force: true }));
  const session = new WorkflowTestingSession(f.config, f.base, state, async () => ({ workspaceRoot: f.root }), () => {});
  await assert.rejects(session.verify({ workspace: "w", checkId: "shell" }, new AbortController().signal), /not declared/);
  await assert.rejects(session.verify({ workspace: "w", checkId: "unit", args: ["arbitrary"] }, new AbortController().signal));
  const review = { target: "codex", workspace: "w", writeMode: "read_only" as const, coordination: { kind: "review" as const, uncertainty: "low" as const, scope: "tests_only" as const, routing: "enabled" as const } };
  await assert.rejects(session.beginAgent(review), /Missing, failed or stale/);
  await session.verify({ workspace: "w", checkId: "unit" }, new AbortController().signal);
  const finish = await session.beginAgent(review); await finish();
  await session.acceptAgent(review, { status: "completed", artifacts: [], unresolved: [] });
  await session.finish({ status: "completed" });
  await writeFile(join(f.root, "tests/results.json"), "tampered");
  await assert.rejects(session.beginAgent(review), /Report changed/);
  await session.verify({ workspace: "w", checkId: "unit" }, new AbortController().signal);
  await writeFile(join(f.root, "tests/case.cjs"), "//lost assertions");
  await assert.rejects(session.beginAgent(review), /stale/);
  await unlink(join(f.root, "tests/case.cjs"));
  await assert.rejects(session.finish({ status: "completed" }));
});

test("verification persists cancellation and command-launch failures as independent evidence", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const check = { ...f.config.checks[0]!, reports: [] };
  const missing = await executeTestingCheck(f.root, "w", f.base, f.config, { ...check, executable: join(f.root, "missing-executable") }, new AbortController().signal);
  assert.equal(missing.passed, false);
  assert.equal(missing.exitCode, null);
  assert.match(missing.error ?? "", /ENOENT/);
  const controller = new AbortController();
  let cancelled = false;
  const pending = executeTestingCheck(f.root, "w", f.base, f.config, { ...check, args: ["-e", "setInterval(()=>{},1000)"] }, controller.signal, async (record) => { cancelled = record.cancelled && !record.passed; });
  setTimeout(() => controller.abort(new Error("host cancellation")), 200);
  await assert.rejects(pending, /host cancellation/);
  assert.equal(cancelled, true);
});
