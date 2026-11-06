import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { lstat, readFile, realpath, unlink } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { unsafeNarrow } from "./unsafe-narrow.js";
import { isPathInsideRoot } from "./roots.js";
import { terminateProcessTree } from "./process-platform.js";
import { redactSecrets } from "./local-agent-events.js";
import { WorkflowError } from "./workflow-types.js";
import { allowedTestingPath, type TestingRunConfig, type TestingCheck } from "./workflow-testing.js";

const spawn = unsafeNarrow<typeof import("node:child_process").spawn>(createRequire(import.meta.url)("cross-spawn"));
const exec = promisify(execFile);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export async function testingGit(root: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd: root, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })).stdout;
}

export interface EvidenceFile { path: string; hash: string; bytes: number; mode: number; summary: string }

export interface TestingInspection {
  workspace: string; baseSha: string; headSha: string; digest: string;
  changed: Array<{ path: string; status: string; hash: string | null; mode: number | null }>;
  artifacts: EvidenceFile[]; violations: string[]; sourceDigest: string;
}

/** Hash actual files; symlinks are rejected before reading, including parent components. */
export async function evidenceFile(root: string, path: string): Promise<EvidenceFile> {
  const resolved = resolve(root, path);

  if (!isPathInsideRoot(resolved, root) || resolved === root) throw new WorkflowError("TESTING_SCOPE", `Path outside workspace: ${path}`);
  const segments = relative(root, resolved).split(/[\\/]/);
  let current = root;

  for (const segment of segments) {
    current = join(current, segment);

    if ((await lstat(current)).isSymbolicLink()) throw new WorkflowError("TESTING_SCOPE", `Symlinks cannot be evidence: ${path}`);
  }

  if (!isPathInsideRoot(await realpath(resolved), root)) throw new WorkflowError("TESTING_SCOPE", `Path escaped workspace: ${path}`);
  const stat = await lstat(resolved);

  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new WorkflowError("TESTING_ARTIFACT", `Evidence must be a regular file at most 16 MiB: ${path}`);
  const content = await readFile(resolved);

  return { path, hash: hash(content), bytes: content.length, mode: stat.mode & 0o777,
    summary: content.includes(0) ? "(binary)" : redactSecrets(content.subarray(0, 2048).toString("utf8")) };
}

export async function inspectTestingWorkspace(root: string, workspace: string, baseSha: string, config: TestingRunConfig, artifacts: string[]): Promise<TestingInspection> {
  const changed: TestingInspection["changed"] = [];
  const violations: string[] = [];
  const rows = (await testingGit(root, ["diff", "--name-status", "-z", "--no-renames", baseSha, "--"])).split("\0");
  const paths = new Map<string, string>();

  for (let i = 0; i + 1 < rows.length; i += 2) paths.set(rows[i + 1]!, rows[i]!);

  for (const path of (await testingGit(root, ["ls-files", "--others", "-z"])).split("\0").filter(Boolean)) paths.set(path, "?");

  if (paths.size > 2048) throw new WorkflowError("TESTING_SCOPE", "Too many changed paths to inspect safely.");

  for (const [path, status] of [...paths].sort(([a], [b]) => a.localeCompare(b))) {
    if (!allowedTestingPath(path, config.allowedPaths)) violations.push(`Change outside allowedPaths: ${path}`);

    if (!["A", "M", "D", "T", "?"].includes(status)) violations.push(`Unresolved or unsupported Git status ${status}: ${path}`);
    let file: EvidenceFile | undefined;

    if (status !== "D") {
      try { file = await evidenceFile(root, path); }
      catch (error) { violations.push(error instanceof Error ? error.message : String(error)); }
    }

    changed.push({ path, status, hash: file?.hash ?? null, mode: file?.mode ?? null });
  }

  const files: EvidenceFile[] = [];

  for (const path of [...new Set(artifacts)].sort()) {
    if (!allowedTestingPath(path, config.allowedPaths)) { violations.push(`Artifact outside allowedPaths: ${path}`); continue; }

    try { files.push(await evidenceFile(root, path)); }
    catch (error) { violations.push(`Missing or invalid artifact ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }

  const headSha = (await testingGit(root, ["rev-parse", "HEAD"])).trim();
  // Include tracked ignored files, permissions, input files and index state; ignored reports are hashed separately.
  const tracked = (await testingGit(root, ["ls-files", "-z"])).split("\0").filter(Boolean).sort();
  const trackedHashes: Array<[string, string, number]> = [];

  if (tracked.length > 20_000) throw new WorkflowError("TESTING_SCOPE", "Workspace exceeds inspection file limit.");

  for (const path of tracked) {
    try { const file = await evidenceFile(root, path); trackedHashes.push([path, file.hash, file.mode]); }
    catch (error) {
      if (!paths.has(path)) violations.push(`Cannot inspect tracked file ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const path of config.inputs) {
    if (!tracked.includes(path)) {
      const file = await evidenceFile(root, path);
      trackedHashes.push([path, file.hash, file.mode]);
    }
  }

  const reports = new Set(config.checks.flatMap((check) => check.reports));
  const reportFiles: EvidenceFile[] = [];

  for (const path of [...reports].sort()) {
    try { reportFiles.push(await evidenceFile(root, path)); }
    catch { /* A report is required only after its verification command runs. */ }
  }

  if (headSha !== baseSha) violations.push("Workspace HEAD changed from the approved base commit.");
  const index = await testingGit(root, ["ls-files", "--stage", "-z"]);

  const sourceDigest = hash(JSON.stringify({ baseSha, headSha, index,
    trackedHashes: trackedHashes.filter(([path]) => !reports.has(path)),
    changed: changed.filter(({ path }) => !reports.has(path)),
  }));

  const digest = hash(JSON.stringify({ sourceDigest, reportFiles }));

  return { workspace, baseSha, headSha, digest, sourceDigest, changed, artifacts: files, violations };
}

export interface TestingVerification {
  checkId: string; workspace: string; executable: string; args: string[]; cwd: string;
  startedAt: string; durationMs: number; exitCode: number | null; signal: string | null;
  timedOut: boolean; cancelled: boolean; error?: string; output: string; outputTruncated: boolean; reports: EvidenceFile[];
  inputDigest: string; outputDigest: string; violations: string[]; passed: boolean;
}

export async function executeTestingCheck(root: string, workspace: string, baseSha: string, config: TestingRunConfig, check: TestingCheck, signal: AbortSignal, onRecord?: (record: TestingVerification) => Promise<void>): Promise<TestingVerification> {
  signal.throwIfAborted();
  const before = await inspectTestingWorkspace(root, workspace, baseSha, config, config.artifacts);

  if (before.violations.length) throw new WorkflowError("TESTING_SCOPE", before.violations.join("\n"));
  const cwd = await realpath(resolve(root, check.cwd ?? "."));

  if (!isPathInsideRoot(cwd, root)) throw new WorkflowError("TESTING_SCOPE", "Verification cwd escaped workspace.");

  if (check.cwd) await assertDirectory(root, check.cwd);

  // Freshness is established by requiring each report to be recreated, not by trusting timestamps alone.
  for (const path of check.reports) {
    const existing = await lstat(resolve(root, path)).catch(() => undefined);

    if (existing) { await evidenceFile(root, path); await unlink(resolve(root, path)); }
  }

  const startedAt = new Date().toISOString();
  const started = Date.now();
  const child = spawn(check.executable, check.args, { cwd, env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
  let output = "";
  let bytes = 0;
  let outputTruncated = false;
  let timedOut = false;
  let killTimer: NodeJS.Timeout | undefined;

  const consume = (chunk: Buffer) => {
    bytes += chunk.length;
    const remaining = Math.max(0, check.maxOutputBytes - Buffer.byteLength(output));
    output += chunk.subarray(0, remaining).toString("utf8");
    outputTruncated = bytes > check.maxOutputBytes;
  };

  child.stdout!.on("data", consume);
  child.stderr!.on("data", consume);

  const stop = () => {
    terminateProcessTree(child, "SIGTERM", process.platform !== "win32");
    killTimer ??= setTimeout(() => terminateProcessTree(child, "SIGKILL", process.platform !== "win32"), 500);
  };

  signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(() => { timedOut = true; stop(); }, check.timeoutMs);
  let result: { exitCode: number | null; signal: string | null; error?: string };

  try {
    result = await new Promise((done) => {
      child.once("error", (error) => done({ exitCode: null, signal: null, error: redactSecrets(error.message) }));
      child.once("close", (exitCode, exitSignal) => done({ exitCode, signal: exitSignal }));

      if (signal.aborted) stop();
    });
  } finally {
    clearTimeout(timer);

    if (killTimer) clearTimeout(killTimer);
    signal.removeEventListener("abort", stop);

    if (child.pid) terminateProcessTree(child, "SIGKILL", process.platform !== "win32");
  }

  const after = await inspectTestingWorkspace(root, workspace, baseSha, config, config.artifacts);
  const violations = [...after.violations];

  if (before.sourceDigest !== after.sourceDigest) violations.push("Verification modified files other than declared reports.");
  const reports: EvidenceFile[] = [];

  for (const path of check.reports) {
    try {
      const report = await evidenceFile(root, path);
      const stat = await lstat(resolve(root, path));

      if (stat.mtimeMs < started - 1000) violations.push(`Stale verification report: ${path}`);
      reports.push(report);
    } catch (error) { violations.push(`Missing report ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }

  const record: TestingVerification = { checkId: check.id, workspace, executable: check.executable, args: check.args, cwd,
    startedAt, durationMs: Date.now() - started, ...result, timedOut, cancelled: signal.aborted, output: redactSecrets(output), outputTruncated, reports,
    inputDigest: before.sourceDigest, outputDigest: after.sourceDigest, violations,
    passed: result.exitCode === 0 && !timedOut && !signal.aborted && violations.length === 0 };

  await onRecord?.(record);
  signal.throwIfAborted();

  return record;
}

async function assertDirectory(root: string, path: string): Promise<void> {
  let current = root;

  for (const part of path.split("/")) {
    current = join(current, part);
    const stat = await lstat(current);

    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new WorkflowError("TESTING_SCOPE", "Verification cwd must be a regular workspace directory.");
  }
}
