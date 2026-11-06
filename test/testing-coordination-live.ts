import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, parseArgs } from "node:util";
import YAML from "yaml";
import { executeTestingCheck } from "../src/workflow-evidence.js";
import { parseTestingRun } from "../src/workflow-testing.js";
import { redactSecrets } from "../src/local-agent-events.js";
import { isJsonString, isJsonObject } from "../src/json-value.js";
import { observeAcceptance, reserveLiveBudget, runAcceptanceCli, type CommandRecord } from "./testing-coordination-harness.js";

const exec = promisify(execFile);
const { values } = parseArgs({ options: { smoke: { type: "boolean" }, "dsh-command": { type: "string" }, "credential-store": { type: "string" }, ledger: { type: "string" } } });
const project = fileURLToPath(new URL("..", import.meta.url));
const fixture = join(project, "test/testing-coordination-fixture");
const root = await realpath(await mkdtemp(join(tmpdir(), "ds-tc-")));
const workspace = join(root, "project");
const stateDir = join(root, "state");
const configDir = join(root, "config");
const dshHome = join(root, "dsh");
const ledgerPath = values.ledger ? resolve(values.ledger) : undefined;

await mkdir(workspace);

await mkdir(configDir);

for (const name of ["server.cjs", "playwright.config.cjs"]) await cp(join(fixture, name), join(workspace, name));

await writeFile(join(workspace, "README.md"), "Contact form: trim input; allow 1..20 characters; success says Thank you, <trimmed name>; reject empty/whitespace or >20 with Name must contain 1 to 20 characters.\n");

const env: NodeJS.ProcessEnv = { ...process.env, DEVSPACE_CONFIG_DIR: configDir, DEVSPACE_EXPERIMENTAL_WORKFLOWS: "1", DEVSPACE_AGENTD_IDLE_TIMEOUT_MS: "60000",
  DEVSPACE_OAUTH_OWNER_TOKEN: "testing-acceptance-owner-token-long-enough", NODE_PATH: join(fixture, "node_modules"),
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/private/tmp/devspace-testing-browsers" };

delete env.DEVSPACE_WORKSPACE_ID;

delete env.DEVSPACE_WORKSPACE_ROOT;

const playwright = join(fixture, "node_modules/@playwright/test/cli.js");
const report = { code: "not-run", offlineBrowser: "not-run", live: "not-run", crossPlatform: "not-run", root, ledgerPath, reason: "", stopConfirmed: false, daemonStopped: false };
const cliPath = join(project, "dist/cli.js");
const commands: CommandRecord[] = [];

const cli = (args: string[], timeoutMs?: number) => runAcceptanceCli({ cliPath, args, cwd: workspace, env, timeoutMs,
  record: async (record) => {
    commands.push(record);
    await writeFile(join(root, "commands.json"), JSON.stringify(commands, null, 2), { mode: 0o600 });
  } });

let budget: Awaited<ReturnType<typeof reserveLiveBudget>> | undefined;

try {
  if (values.smoke) {
    await mkdir(join(workspace, "tests"));
    await writeFile(join(workspace, "tests/smoke.spec.cjs"), `const {test,expect}=require('@playwright/test');
for (const [name,input,message] of [['valid','  Ada  ','Thank you, Ada'],['invalid','   ','Name must contain 1 to 20 characters'],['boundary','abcdefghijklmnopqrst','Thank you, abcdefghijklmnopqrst']]) {
 test(name,async({page})=>{await page.goto('/');await page.getByLabel('Name').fill(input);await page.getByRole('button',{name:'Submit'}).click();await expect(page.getByRole('status')).toHaveText(message);});
}`);
    await exec("git", ["init", "-q"], { cwd: workspace });
    await exec("git", ["add", "."], { cwd: workspace });
    await exec("git", ["-c", "user.name=Acceptance", "-c", "user.email=acceptance@example.invalid", "commit", "-qm", "isolated browser smoke"], { cwd: workspace });
    const base = (await exec("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout.trim();

    const contract = parseTestingRun({ task: "Independent browser smoke", allowedPaths: ["tests", "reports"], artifacts: ["tests/smoke.spec.cjs"], acceptance: ["Valid, invalid and boundary UI assertions pass"],
      checks: [{ id: "browser", executable: process.execPath, args: [playwright, "test", "--config", "playwright.config.cjs"], timeoutMs: 120_000, reports: ["reports/results.json", "reports/browser/.last-run.json"] }] });

    process.env.NODE_PATH = env.NODE_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH = env.PLAYWRIGHT_BROWSERS_PATH;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Browser smoke budget exhausted")), 120_000);

    try {
      const evidence = await executeTestingCheck(workspace, "browser-smoke", base, contract, contract.checks[0]!, controller.signal,
        async (record) => { await writeFile(join(root, "independent-browser.json"), JSON.stringify(record, null, 2)); });

      assert.equal(evidence.passed, true, JSON.stringify(evidence));
      report.offlineBrowser = "passed";
    } finally { clearTimeout(timer); }
  } else {
    if (!ledgerPath) throw new Error("Provide --ledger pointing to the cumulative acceptance budget; no automatic fresh budget is allowed");

    if (!values["dsh-command"]) throw new Error("Provide --dsh-command for the isolated compatible SDK");

    if (values["credential-store"]) {
      // Use an existing API key only in child-process memory. Never copy or rewrite the credential file.
      const store = YAML.parse(await readFile(resolve(values["credential-store"]), "utf8"));
      const key = isJsonObject(store) && isJsonObject(store.refs) ? store.refs.DEEPSEEK_API_KEY : undefined;

      if (isJsonString(key) && key.startsWith("sk-")) env.DEEPSEEK_API_KEY = key;
    }

    if (!env.DEEPSEEK_API_KEY) throw new Error("No DSH API credential available to the isolated process");
    const profile = join(dshHome, "profiles/sdk");
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, "package.json"), JSON.stringify({ name: "dsh-profile-sdk", private: true, dependencies: {}, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app"] } } }));
    await writeFile(join(profile, "cordis.yml"), "[]\n");
    await writeFile(join(profile, "cordis.patch.yml"), "[]\n");
    await exec("git", ["init", "-q"], { cwd: workspace });
    await exec("git", ["add", "."], { cwd: workspace });
    await exec("git", ["-c", "user.name=Acceptance", "-c", "user.email=acceptance@example.invalid", "commit", "-qm", "isolated acceptance fixture"], { cwd: workspace });
    budget = await reserveLiveBudget(ledgerPath, root);

    const contract = { taskId: "contact-e2e", task: "Analyze this tiny Web contact form, produce scenario-linked test plan and implement test cases in tests/CASES.md and Playwright Chromium E2E in tests/form.spec.cjs. Use require('@playwright/test') in CommonJS. Cover valid trimmed submission, invalid whitespace input, and exact 20-character boundary. Use the existing Playwright config and server. Do not install dependencies, execute tests or modify business code/config. Independent verifier runs declared checks. All work must finish within the call/time budget.",
      baseRef: "HEAD", inputs: ["README.md", "server.cjs", "playwright.config.cjs"], allowedPaths: ["tests", "reports"], artifacts: ["tests/CASES.md", "tests/form.spec.cjs"],
      acceptance: ["Scenario IDs map cases to browser assertions", "Actual Chromium UI asserts exact success for trimmed valid input", "Whitespace invalid input asserts exact rejection", "20-character boundary asserts exact success", "No business-code changes or weakened assertions"],
      checks: [{ id: "browser-e2e", executable: process.execPath, args: [playwright, "test", "--config", "playwright.config.cjs"], timeoutMs: 120_000, reports: ["reports/results.json", "reports/browser/.last-run.json"] }],
      implementer: "dsh", maxCalls: budget.remainingCalls, timeoutMs: budget.remainingMs, maxRepairs: 2 };

    await writeFile(join(configDir, "config.jsonc"), JSON.stringify({ configVersion: 1, workspaces: { allowedRoots: [root], worktreeRoot: join(root, "worktrees") }, storage: { stateDir },
      subagents: { enabled: true, providers: [{ id: "codex", driver: "codex", enabled: true }, { id: "dsh", driver: "dsh", enabled: true, command: resolve(values["dsh-command"]), config: { profile: "sdk" }, env: { DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: "1" } }] } }));
    const argsFile = join(root, "contract.json");
    await writeFile(argsFile, JSON.stringify(contract, null, 2));
    const observation = await observeAcceptance({ cli, startArgs: ["workflow", "run", "--builtin", "testing-coordination", "--args-file", argsFile, "--write-mode", "allowed"], timeoutMs: budget.remainingMs });
    await writeFile(join(root, "workflow-result.json"), JSON.stringify(observation.final ?? null, null, 2));
    await writeFile(join(root, "events.json"), JSON.stringify(observation.events, null, 2));
    await writeFile(join(root, "calls.json"), JSON.stringify(observation.calls, null, 2));
    await writeFile(join(root, "observation.json"), JSON.stringify(observation, null, 2));
    await budget.settle(observation);
    report.code = "completed";
    report.stopConfirmed = observation.stopConfirmed;
    report.daemonStopped = observation.daemonStopped;
    report.live = observation.passed ? "passed" : "blocked";
    report.reason = report.live === "passed" ? "Real Codex plan, real DSH implementation, independent Chromium execution and Codex review" : "Inspect workflow-result.json and retained evidence";

    if (observation.errors.length) report.reason += `: ${observation.errors.join("; ")}`;
    assert.equal(report.live, "passed", report.reason);
  }
} catch (error) {
  report.reason = redactSecrets(error instanceof Error ? error.message : String(error));

  if (!values.smoke) report.live = "blocked";
  process.exitCode = 1;
} finally {
  try { if (budget) await budget.release(); }
  catch (error) {
    report.reason += `; budget lock release failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`;
    report.live = "blocked";
    process.exitCode = 1;
  }

  await writeFile(join(root, "acceptance-summary.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
