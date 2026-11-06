import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue, WireInput } from "./json-value.js";
import { isJsonObject } from "./json-value.js";
import type { LocalAgentWorkspaceScope } from "./local-agent-store.js";
import { WorkflowError, type WorkflowAgentOptions } from "./workflow-types.js";
import { evidenceFile, executeTestingCheck, inspectTestingWorkspace, type TestingInspection, type TestingVerification } from "./workflow-evidence.js";
import { inspectionRequestSchema, verificationRequestSchema, type TestingRunConfig } from "./workflow-testing.js";

interface TestingWorkspace {
  scope: LocalAgentWorkspaceScope;
  records: Map<string, TestingVerification>;
  busy: boolean;
  reviewedDigest?: string;
}

/** Host-owned authority and durable evidence; the guest can only request declared check IDs. */
export class WorkflowTestingSession {
  private readonly workspaces = new Map<string, TestingWorkspace>();
  private sequence = 0;
  constructor(
    readonly config: TestingRunConfig,
    readonly baseSha: string,
    private readonly directory: string,
    private readonly create: (key: string) => Promise<LocalAgentWorkspaceScope>,
    private readonly event: (type: string, data: WireInput) => void,
  ) {}

  async inspect(value: WireInput): Promise<JsonValue> {
    const request = inspectionRequestSchema.parse(value);
    const workspace = await this.workspace(request.workspace);

    if (workspace.busy) throw new WorkflowError("TESTING_BUSY", "Wait for the current operation before inspecting its workspace.");
    const inspection = await this.manifest(request.workspace, workspace, request.artifacts);
    await this.record("inspection", inspection);

    return JSON.parse(JSON.stringify(inspection));
  }

  async verify(value: WireInput, signal: AbortSignal): Promise<JsonValue> {
    const request = verificationRequestSchema.parse(value);
    const check = this.config.checks.find((candidate) => candidate.id === request.checkId);

    if (!check) throw new WorkflowError("TESTING_UNDECLARED_CHECK", `Check was not declared by the host: ${request.checkId}`);
    const workspace = await this.workspace(request.workspace);
    this.acquire(workspace);
    workspace.reviewedDigest = undefined;

    try {
      const record = await executeTestingCheck(workspace.scope.workspaceRoot, request.workspace, this.baseSha, this.config, check, signal, async (evidence) => {
        workspace.records.set(check.id, evidence);
        await this.record("verification", evidence);
      });

      return JSON.parse(JSON.stringify(record));
    } finally { workspace.busy = false; }
  }

  async beginAgent(options: WorkflowAgentOptions): Promise<() => Promise<void>> {
    if (!options.workspace) throw new WorkflowError("TESTING_SCOPE", "Testing agents require an isolated named workspace.");
    const key = options.workspace;
    const workspace = await this.workspace(key);
    this.acquire(workspace);

    try {
      const before = await this.manifest(key, workspace);
      this.assertScope(before);

      if (options.coordination?.kind === "review") await this.assertEvidence(workspace, before);

      if (options.writeMode !== "read_only") {
        workspace.records.clear();
        workspace.reviewedDigest = undefined;
      }

      return async () => {
        try {
          const after = await this.manifest(key, workspace);
          await this.record("inspection", after);
          this.assertScope(after);

          if (options.writeMode === "read_only" && before.digest !== after.digest) {
            workspace.records.clear();
            workspace.reviewedDigest = undefined;
            throw new WorkflowError("TESTING_SCOPE", "Read-only agent changed the workspace; evidence was invalidated.");
          }
        } finally { workspace.busy = false; }
      };
    } catch (error) { workspace.busy = false; throw error; }
  }

  async acceptAgent(options: WorkflowAgentOptions, output: JsonValue): Promise<void> {
    if (!isJsonObject(output)) throw new WorkflowError("INVALID_TESTING_RESULT", "Testing phases must return structured results.");

    if (output.status !== "completed" || !Array.isArray(output.unresolved) || output.unresolved.length) return;
    const workspace = await this.workspace(options.workspace!);
    const artifacts = Array.isArray(output.artifacts) ? output.artifacts : [];
    const parsed = inspectionRequestSchema.parse({ workspace: options.workspace, artifacts });
    const required = options.coordination?.kind === "implementation" ? [...new Set(this.config.artifacts.concat(parsed.artifacts))] : parsed.artifacts;
    const inspection = await this.manifest(options.workspace!, workspace, required);
    this.assertScope(inspection);

    if (options.coordination?.kind === "review") {
      await this.assertEvidence(workspace, inspection);
      workspace.reviewedDigest = inspection.digest;
    }
  }

  async finish(result: JsonValue): Promise<void> {
    if (!isJsonObject(result) || result.status !== "completed") return;

    for (const [key, workspace] of this.workspaces) {
      const inspection = await this.manifest(key, workspace, this.config.artifacts);
      this.assertScope(inspection);
      await this.assertEvidence(workspace, inspection);

      if (workspace.reviewedDigest !== inspection.digest) throw new WorkflowError("TESTING_STALE_EVIDENCE", "Current files lack an independent review against current verification evidence.");
    }

    await this.record("acceptance", result);
  }

  private async workspace(key: string): Promise<TestingWorkspace> {
    let workspace = this.workspaces.get(key);

    if (!workspace) {
      const scope = await this.create(key);

      for (const path of this.config.inputs) await evidenceFile(scope.workspaceRoot, path);
      workspace = { scope, records: new Map(), busy: false };
      this.workspaces.set(key, workspace);
    }

    return workspace;
  }
  private acquire(workspace: TestingWorkspace): void {
    if (workspace.busy) throw new WorkflowError("TESTING_BUSY", "Concurrent operations in the same testing workspace are not allowed.");
    workspace.busy = true;
  }
  private manifest(key: string, workspace: TestingWorkspace, artifacts: string[] = []): Promise<TestingInspection> {
    return inspectTestingWorkspace(workspace.scope.workspaceRoot, key, this.baseSha, this.config, artifacts);
  }
  private assertScope(inspection: TestingInspection): void {
    if (inspection.violations.length) throw new WorkflowError("TESTING_SCOPE", inspection.violations.join("\n"));
  }
  private async assertEvidence(workspace: TestingWorkspace, inspection: TestingInspection): Promise<void> {
    for (const path of this.config.artifacts) await evidenceFile(workspace.scope.workspaceRoot, path);

    for (const check of this.config.checks) {
      const record = workspace.records.get(check.id);

      if (!record?.passed || record.outputDigest !== inspection.sourceDigest) throw new WorkflowError("TESTING_STALE_EVIDENCE", `Missing, failed or stale independent check: ${check.id}`);

      for (const report of record.reports) {
        const actual = await evidenceFile(workspace.scope.workspaceRoot, report.path);

        if (actual.hash !== report.hash) throw new WorkflowError("TESTING_STALE_EVIDENCE", `Report changed after verification: ${report.path}`);
      }
    }
  }
  private async record(type: string, value: WireInput): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, `${++this.sequence}-${type}.json`);
    await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
    this.event(`testing_${type}`, { path });
  }
}

export async function builtinTestingSource(): Promise<string> {
  return readFile(new URL("../skills/testing-coordination/workflow.js", import.meta.url), "utf8");
}
