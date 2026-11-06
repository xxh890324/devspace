import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { chooseTestingTarget, parseCoordinationResult, parseCoordinationTask } from "./testing-coordination.js";
import { runWorkflowScript } from "./workflow-runner.js";
import { compileWorkflowSchema } from "./workflow-schema.js";
import { WorkflowError } from "./workflow-types.js";
import { parseTestingRun } from "./workflow-testing.js";
import { isJsonObject } from "./json-value.js";

const providers = [
  { id: "codex", driver: "codex" as const, enabled: true },
  { id: "dsh", driver: "dsh" as const, enabled: true },
];

test("automatic testing routing keeps uncertain work with Codex", () => {
  assert.deepEqual(
    chooseTestingTarget({ requestedTarget: "auto", task: parseCoordinationTask({ kind: "analysis", uncertainty: "high" }), providers }),
    { target: "codex", reason: "high_uncertainty" },
  );
});

test("automatic testing routing assigns bounded implementation to DSH", () => {
  assert.deepEqual(
    chooseTestingTarget({ requestedTarget: "auto", task: parseCoordinationTask({ kind: "implementation", uncertainty: "low" }), providers }),
    { target: "dsh", reason: "dsh_implementation", fallback: "codex" },
  );
});

test("explicit targets take precedence over routing metadata", () => {
  assert.deepEqual(
    chooseTestingTarget({ requestedTarget: "reviewer", task: parseCoordinationTask({ kind: "implementation", uncertainty: "low" }), providers }),
    { target: "reviewer", reason: "explicit" },
  );
});

test("only low uncertainty test implementation is eligible for automatic DSH routing", () => {
  for (const [task, reason] of [
    [{ kind: "implementation", uncertainty: "medium" }, "medium_uncertainty"],
    [{ kind: "implementation", uncertainty: "low", scope: "business_code" }, "business_code"],
    [{ kind: "implementation", uncertainty: "low", routing: "shadow" }, "shadow"],
    [{ kind: "review", uncertainty: "low" }, "codex_review"],
    [{ kind: "verification", uncertainty: "low" }, "codex_review"],
  ] as const) {
    assert.deepEqual(chooseTestingTarget({ requestedTarget: "auto", task: parseCoordinationTask(task), providers }), { target: "codex", reason });
  }

  assert.throws(() => chooseTestingTarget({ requestedTarget: "auto", task: parseCoordinationTask({ kind: "implementation", routing: "explicit" }), providers }), /concrete target/);
});

test("disabled or unavailable DSH routes to the configured Codex instance", () => {
  const task = parseCoordinationTask({ kind: "implementation", uncertainty: "low" });

  for (const configured of [providers.map((p) => ({ ...p, enabled: p.driver !== "dsh" })), providers.filter((p) => p.driver !== "dsh")]) {
    assert.equal(chooseTestingTarget({ requestedTarget: "auto", task, providers: configured }).reason, "dsh_unavailable");
  }

  assert.deepEqual(chooseTestingTarget({ requestedTarget: "auto", task,
    providers: providers.map((p) => ({ ...p, id: p.driver === "codex" ? "reviewer" : "worker" })), available: () => false,
  }), { target: "reviewer", reason: "dsh_unavailable", fallback: "dsh" });
});

test("coordination results require evidence fields with a bounded status", () => {
  assert.deepEqual(parseCoordinationResult({ status: "completed", artifacts: ["tests"], verification: ["pnpm test"], evidence: ["report"], unresolved: [] }), {
    status: "completed", artifacts: ["tests"], verification: ["pnpm test"], evidence: ["report"], unresolved: [],
  });
  assert.throws(() => parseCoordinationResult({ status: "completed" }), /evidence/);
  assert.throws(() => parseCoordinationResult({ status: "completed", evidence: [] }), /Too small/);
  assert.throws(() => parseCoordinationResult({ status: "blocked", evidence: ["missing fixture"] }), /nextOwner/);
  assert.equal(parseCoordinationResult({ status: "blocked", evidence: ["missing fixture"], unresolved: ["Which account?"], nextOwner: "human" }).nextOwner, "human");
});

test("the shipped testing workflow gates handoffs, routes stages and returns failures to Codex", async () => {
  const source = await readFile(new URL("../skills/testing-coordination/workflow.js", import.meta.url), "utf8");

  const result = {
    status: "completed", artifacts: ["test/login.test.ts"], verification: ["pnpm test: passed"],
    evidence: ["test-report"], unresolved: [], nextOwner: "codex",
  };

  const plan = { ...result, uncertainty: "low", testPlan: "Check valid and invalid credentials", implementationTask: "Add two login cases" };

  for (const scenario of ["completed", "blocked", "provider-failure"]) {
    const calls: Array<{ target: string; workspace?: string; writeMode?: string; prompt: string }> = [];

    const output = await runWorkflowScript({
      source, args: parseTestingRun({ task: "Login coverage", allowedPaths: ["test"], artifacts: ["test/login.test.ts"], acceptance: ["Valid and invalid login"], checks: [{ id: "unit", executable: "node" }] }),
      onInspect: () => ({ violations: [], digest: "fixture" }),
      onVerify: () => ({ passed: true }),
      onAgent: (prompt, options) => {
        const target = chooseTestingTarget({ requestedTarget: options.target, task: parseCoordinationTask(options.coordination), providers }).target;
        calls.push({ target, workspace: options.workspace, writeMode: options.writeMode, prompt });

        if (calls.length === 2 && scenario === "provider-failure") throw new WorkflowError("PROVIDER_PROTOCOL_ERROR", "unsupported permission command");

        const value = calls.length === 1
          ? { ...plan, status: scenario === "blocked" ? "blocked" : "completed", unresolved: scenario === "blocked" ? ["Missing login fixture"] : [] }
          : result;

        assert.ok(compileWorkflowSchema(options.schema!)(value));

        return value;
      },
    });

    assert.ok(isJsonObject(output));
    assert.equal(output.status, scenario === "completed" ? "completed" : "blocked");
    assert.deepEqual(calls.map((call) => call.target), scenario === "completed" ? ["codex", "dsh", "codex"] : scenario === "blocked" ? ["codex"] : ["codex", "dsh"]);

    if (scenario === "completed") {
      assert.deepEqual(calls.map((call) => call.writeMode), ["read_only", "allowed", "read_only"]);
      assert.equal(calls[1]!.workspace, calls[2]!.workspace);
      assert.match(calls[1]!.prompt, /Add two login cases/);
    }

    if (scenario === "provider-failure") assert.equal(output.nextOwner, "human");
  }
});
