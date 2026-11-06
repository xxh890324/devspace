import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isJsonObject, isJsonString, type JsonObject, type WireInput } from "./json-value.js";
import { AgentProviderExecutionError, AgentProviderUnavailableError, captureAgentProviderResult } from "./local-agent-errors.js";
import { bindLocalAgentAbort, localAgentCancelledError } from "./local-agent-cancellation.js";
import { resolveExecutableCommand } from "./local-agent-command.js";
import { summarizeToolInput, type LocalAgentActivityEvent } from "./local-agent-events.js";
import { DshSdkConnection, dshProtocolError } from "./local-agent-dsh-rpc.js";
import type { LocalAgentDriver, LocalAgentModel, LocalAgentRunCallbacks, LocalAgentRunInput, LocalAgentRunResult, LocalAgentRuntime, LocalAgentRuntimeContext, LocalAgentWriteMode } from "./local-agent-runtime.js";

export class DshLocalAgentDriver implements LocalAgentDriver {
  readonly provider = "dsh" as const;
  readonly providerInstanceId = "dsh";
  readonly runtimePolicy = { scope: "agent", authority: "write_mode", idleTimeoutMs: 5 * 60_000 } as const;
  readonly capabilities = {
    sessions: { resume: true, close: false },
    turns: { interrupt: true, streaming: true },
    configuration: { modelOverride: true, effortOverride: true },
    permissions: { enforcement: "native" },
    mcp: { supported: false },
  } as const;

  constructor(private readonly options: { env?: NodeJS.ProcessEnv; command?: string; profile?: string } = {}) {}

  async createRuntime(context: LocalAgentRuntimeContext) {
    return captureAgentProviderResult({ provider: this.provider, agentId: context.agentId, operation: "create_runtime", run: async () => {
      const env = this.options.env ?? process.env;
      const command = resolveExecutableCommand(this.options.command ?? env.DSH_COMMAND ?? "dsh", env);

      if (!command) throw new AgentProviderUnavailableError({ code: "PROVIDER_UNAVAILABLE", provider: this.provider, operation: "create_runtime", retryable: false, message: "DSH executable was not found." });

      return new DshSdkRuntime({ command, profile: this.options.profile ?? "sdk", env, context });
    } });
  }

  async listModels(_workspaceRoot: string) {
    return captureAgentProviderResult({ provider: this.provider, operation: "list_models", run: async (): Promise<LocalAgentModel[]> => {
      throw dshProtocolError("list_models", "DSH SDK has no model catalogue RPC. Set an exact model in the provider/profile configuration.");
    } });
  }
}

/** Each turn gets a disposable SDK process. Model/effort changes and authority
 * reductions therefore apply even when resuming a durable DSH session. */
class DshSdkRuntime implements LocalAgentRuntime {
  readonly provider = "dsh" as const;
  private closed = false;
  private active = false;
  private connection?: DshSdkConnection;
  private sessionId?: string;

  constructor(private readonly options: { command: string; profile: string; env: NodeJS.ProcessEnv; context: LocalAgentRuntimeContext }) {}

  isAlive(): boolean { return !this.closed && (this.connection === undefined || this.connection.isAlive()); }

  async releaseSession(_providerSessionId: string): Promise<void> {
    // Every completed turn already shuts down its SDK process. DSH owns durable logs.
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.connection?.close();
  }

  async run(input: LocalAgentRunInput, callbacks?: LocalAgentRunCallbacks) {
    return captureAgentProviderResult({ provider: this.provider, operation: "run", run: async (): Promise<LocalAgentRunResult> => {
      if (this.closed || this.active) throw dshProtocolError("run", "DSH runtime is closed or already running a turn.");

      if (input.signal?.aborted) throw localAgentCancelledError(this.provider, "run");
      this.active = true;
      let overlayDir: string | undefined;
      let unbind = () => {};

      try {
        const root = await realpath(input.workspaceRoot);
        overlayDir = await mkdtemp(join(tmpdir(), "devspace-dsh-"));
        const sessionId = input.providerSessionId ?? this.sessionId ?? this.options.context.providerSessionId ?? `devspace-${randomUUID()}`;
        const resumed = Boolean(input.providerSessionId ?? this.sessionId ?? this.options.context.providerSessionId);
        const accumulator = new DshTurnEvents(sessionId, callbacks?.onEvent);
        let permissionReady = false;
        let blockedQuestion = false;
        const mode = input.writeMode ?? this.options.context.writeMode ?? "allowed";
        const overlay = join(overlayDir, "sdk.patch.json");
        await writeFile(overlay, JSON.stringify(dshSdkOverlay(root)), { mode: 0o600 });

        if (this.closed || input.signal?.aborted) throw localAgentCancelledError(this.provider, "run");

        const connection = new DshSdkConnection({ command: this.options.command, args: ["--profile", this.options.profile, "--patch", overlay], cwd: root, env: { ...this.options.env, DSH_PERMISSION_MODE: "read-only", DSH_MAX_TOKENS_AS_SUCCESS: "false" } }, (frame) => {
          if (frame.method === "session.event") accumulator.receive(frame);

          if (frame.id === undefined) return;

          if (frame.method === "approval/request") {
            connection.reply(frame.id, { outcome: permissionReady && mode === "full_access" ? "allowed-once" : "rejected" });
          } else if (frame.method === "user-question/ask") {
            blockedQuestion = true;
            connection.reply(frame.id, { cancelled: true });
          } else {
            connection.reject(frame.id);
          }
        });

        this.connection = connection;
        unbind = bindLocalAgentAbort(input.signal, () => connection.close());
        const params: JsonObject = { cwd: root, provider: "deepseek-official", model: input.model ?? this.options.context.model ?? "deepseek-v4-pro", approvalRequests: true, capabilities: { userQuestions: true } };
        const effort = input.effort ?? this.options.context.effort;

        if (effort) params.reasoningEffort = effort;
        const initialized = await connection.request("initialize", params);

        if (object(initialized.serverInfo)?.name !== "deepseek-harness-sdk-runtime") throw dshProtocolError("initialize", "Unexpected DSH SDK server identity.");
        // Verify command support on a fresh session under our read-only overlay,
        // before touching a restored session which may retain greater authority.
        await setPermission(connection, `devspace-probe-${randomUUID()}`, "read_only");

        if (resumed) await connection.request("session/resume", { sessionId });
        const directory = await connection.request("session/working-directory/get", { sessionId });

        if (!isJsonString(directory.cwd) || await realpath(directory.cwd) !== root) throw dshProtocolError("resume", "DSH session working directory does not match the DevSpace workspace. Start a new agent.");
        await setPermission(connection, sessionId, mode);
        permissionReady = true;
        this.sessionId = sessionId;
        await callbacks?.onSessionId?.(sessionId);

        if (input.signal?.aborted) throw localAgentCancelledError(this.provider, "run");
        accumulator.begin();
        await connection.request("session/prompt", { sessionId, contentBlocks: [{ type: "text", text: input.prompt }] });
        await connection.request("session/wait", { sessionId }, 5 * 60_000);

        if (blockedQuestion) throw execution("DSH needs user input. Return this task to the host for clarification.");

        return accumulator.result();
      } catch (cause) {
        if (input.signal?.aborted) throw localAgentCancelledError(this.provider, "run", cause);
        throw cause;
      } finally {
        try {
          if (input.signal?.aborted) await this.connection?.close();
          else await this.connection?.shutdown();
        } finally {
          unbind();
          this.connection = undefined;
          this.active = false;

          if (overlayDir) await rm(overlayDir, { recursive: true, force: true });
        }
      }
    } });
  }
}

/** Pin fresh-session authority and the permission table instead of relying on
 * environment defaults, which persisted DSH session knobs can override. */
export function dshSdkOverlay(workspaceRoot: string): JsonObject[] {
  return [
    { id: "permission", disabled: false, config: { defaultPreset: "read-only", presets: {
      "read-only": { sandbox: "read-only", approval: "ask" },
      "workspace-write": { sandbox: "workspace-write", approval: "ask" },
      "danger-full-access": { sandbox: "danger-full-access", approval: "never" },
    } } },
    { id: "commands", disabled: false },
    { id: "sandbox-policy", config: { mode: "read-only", workspaceRoot } },
    { id: "approval", config: { policy: "ask" } },
    { id: "schedule", disabled: true },
    { id: "tool-schedule", disabled: true },
    { id: "tool-plugin-manager", disabled: true },
  ];
}

async function setPermission(connection: DshSdkConnection, sessionId: string, mode: LocalAgentWriteMode): Promise<void> {
  const preset = mode === "read_only" ? "read-only" : mode === "allowed" ? "workspace-write" : "danger-full-access";
  const result = await connection.request("session/query", { sessionId, contentBlocks: [{ type: "text", text: `/permission ${preset}` }] });
  const outcome = object(object(result.execution)?.result);

  if (result.kind !== "command" || outcome?.kind !== "success" || outcome.text !== `preset ${preset}`) {
    throw dshProtocolError("permission", `DSH did not apply native permission preset ${preset}. A DSH SDK with session/query support is required.`);
  }
}

class DshTurnEvents {
  private started = false;
  private finalResponse = "";
  private reason?: JsonObject;
  private readonly items: JsonObject[] = [];
  private itemBytes = 0;
  private readonly tools = new Map<string, string>();

  constructor(private readonly sessionId: string, private readonly onEvent?: (event: LocalAgentActivityEvent) => void) {}

  begin(): void { this.started = true; }

  receive(frame: JsonObject): void {
    const params = object(frame.params);
    const event = object(params?.event);
    const data = object(event?.data);

    if (!this.started || params?.sessionId !== this.sessionId || !event || !data) return;
    const size = Buffer.byteLength(JSON.stringify(event));

    if (this.items.length < 10_000 && this.itemBytes + size <= 4 * 1024 * 1024) {
      this.items.push(event);
      this.itemBytes += size;
    }

    if (event.type === "assistant/message") {
      const message = object(data.message);
      const content = message?.content;

      if (!Array.isArray(content) || data.interrupted === true) return;

      const text = content.flatMap((block: WireInput) => {
        const value = object(block);

        return value?.type === "text" && isJsonString(value.text) ? [value.text] : [];
      }).join("");

      this.finalResponse = text;

      if (text) this.onEvent?.({ type: "message", text });
    } else if (event.type === "turn/end") {
      this.reason = object(data.reason);
    } else if (event.type === "tool/call" && isJsonString(data.name) && isJsonString(data.callId)) {
      this.tools.set(data.callId, data.name);
      this.onEvent?.({ type: "tool_started", tool: data.name, summary: summarizeToolInput(parseArguments(data.arguments)) });
    } else if (event.type === "tool/result") {
      const message = object(data.message);
      const tool = isJsonString(message?.toolCallId) ? this.tools.get(message.toolCallId) : undefined;

      if (tool) this.onEvent?.({ type: "tool_completed", tool, status: message?.isError === true ? "failed" : "completed" });
    }
  }

  result(): LocalAgentRunResult {
    if (this.reason?.kind !== "completed") throw execution(`DSH turn ended with ${String(this.reason?.kind ?? "no terminal event")}.`, this.reason);

    if (!this.finalResponse.trim()) throw dshProtocolError("run", "DSH completed without a final assistant text response.");

    return { provider: "dsh", providerSessionId: this.sessionId, finalResponse: this.finalResponse, items: this.items };
  }
}

function object(value: WireInput): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function parseArguments(value: WireInput): WireInput {
  if (!isJsonString(value)) return value;

  try { return JSON.parse(value); }
  catch { return value; }
}

function execution(message: string, cause?: WireInput): AgentProviderExecutionError {
  return new AgentProviderExecutionError({ code: "PROVIDER_EXECUTION_ERROR", provider: "dsh", operation: "run", retryable: false, message, cause });
}
