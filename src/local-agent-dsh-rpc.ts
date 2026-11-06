import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { isJsonObject, isJsonString, jsonObject, type JsonObject, type WireInput } from "./json-value.js";
import { terminateProcessTree } from "./process-platform.js";
import { AgentProviderProtocolError } from "./local-agent-errors.js";
import { unsafeNarrow } from "./unsafe-narrow.js";

// Resolve npm command shims and executable shebangs on Windows as the ACP adapter does.
const spawn = unsafeNarrow<typeof import("node:child_process").spawn>(createRequire(import.meta.url)("cross-spawn"));

interface PendingRequest {
  method: string;
  resolve(value: JsonObject): void;
  reject(cause: Error): void;
  timer: NodeJS.Timeout;
}

/** DSH SDK uses NDJSON JSON-RPC; provider requests and responses have independent id spaces. */
export class DshSdkConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private nextId = 0;
  private buffer = "";
  private stderrTail = "";
  private failure?: Error;
  private closed = false;
  private exited = false;
  private closePromise?: Promise<void>;

  constructor(input: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }, private readonly notify: (frame: JsonObject) => void) {
    this.child = spawn(input.command, input.args, { cwd: input.cwd, env: input.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => { this.stderrTail = (this.stderrTail + chunk).slice(-8_192); });
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.once("error", (error) => { this.exited = true; this.fail(error); });
    this.child.once("close", (code, signal) => {
      this.exited = true;
      this.fail(new Error(`DSH SDK exited (${signal ?? code ?? "unknown"}).${this.stderrTail ? `\n${this.stderrTail}` : ""}`));
    });
  }

  async request(method: string, params?: JsonObject, timeoutMs = 30_000): Promise<JsonObject> {
    if (this.failure) throw this.failure;

    if (this.closed) throw new Error("DSH SDK connection is closed.");
    const id = `devspace-${++this.nextId}`;
    const frame: JsonObject = { jsonrpc: "2.0", id, method };

    if (params !== undefined) frame.params = params;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(dshProtocolError(method, `DSH SDK ${method} timed out after ${timeoutMs}ms.`));
        void this.close();
      }, timeoutMs);

      this.pending.set(id, { method, resolve, reject, timer });
      this.write(frame);
    });
  }

  /** Restricted runs reject approval escalation, including paths outside the workspace. */
  reply(id: WireInput, result: JsonObject): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  reject(id: WireInput): void {
    this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unsupported DSH host request." } });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.fail(new Error("DSH SDK connection closed."));
    this.closePromise = (async () => {
      if (this.exited) {
        if (process.platform !== "win32" && this.child.pid) terminateProcessTree(this.child, "SIGKILL", true);

        return;
      }

      const ended = new Promise<void>((done) => this.child.once("close", () => done()));
      // No public per-session cancel RPC exists. Kill the agent-scoped process tree,
      // and wait for exit before reporting cancellation or reusing its workspace.
      terminateProcessTree(this.child, "SIGTERM", process.platform !== "win32");
      const killTimer = setTimeout(() => terminateProcessTree(this.child, "SIGKILL", process.platform !== "win32"), 500);

      try { await ended; }
      finally {
        clearTimeout(killTimer);

        // A child tool may survive its parent. The detached group still belongs to this runtime.
        if (process.platform !== "win32") terminateProcessTree(this.child, "SIGKILL", true);
      }
    })();

    return this.closePromise;
  }

  isAlive(): boolean {
    return !this.closed && !this.exited && this.failure === undefined;
  }

  async shutdown(): Promise<void> {
    if (!this.closed && !this.failure) await this.request("shutdown", undefined, 5_000).catch(() => {});
    await this.close();
  }

  private write(frame: JsonObject): void {
    if (this.closed || this.failure) return;
    this.child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => { if (error) this.fail(error); });
  }

  private consume(chunk: string): void {
    if (this.closed || this.failure) return;
    this.buffer += chunk;

    for (;;) {
      const end = this.buffer.indexOf("\n");

      if (end < 0) break;

      if (end > 8 * 1024 * 1024) return this.invalidFrame();
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);

      if (!line.trim()) continue;

      try { this.receive(jsonObject(JSON.parse(line), "DSH SDK frame")); }
      catch { return this.invalidFrame(); }
    }

    if (this.buffer.length > 8 * 1024 * 1024) this.invalidFrame();
  }

  private receive(frame: JsonObject): void {
    if (frame.jsonrpc !== "2.0") return this.invalidFrame();

    if (isJsonString(frame.method)) {
      this.notify(frame);

      return;
    }

    if (!isJsonString(frame.id)) return;
    const waiter = this.pending.get(frame.id);

    if (!waiter) return;
    this.pending.delete(frame.id);
    clearTimeout(waiter.timer);

    if (isJsonObject(frame.error)) {
      waiter.reject(dshProtocolError(waiter.method, isJsonString(frame.error.message) ? frame.error.message : "DSH SDK request failed.", frame.error));
    } else if (isJsonObject(frame.result)) {
      waiter.resolve(frame.result);
    } else {
      waiter.reject(dshProtocolError("rpc", "DSH SDK response has no object result."));
    }
  }

  private invalidFrame(): void {
    this.fail(dshProtocolError("rpc", "DSH SDK emitted a malformed or oversized JSON-RPC frame."));
    void this.close();
  }

  private fail(error: Error): void {
    this.failure ??= error;

    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(this.failure);
    }

    this.pending.clear();
  }
}

export function dshProtocolError(operation: string, message: string, cause?: WireInput): AgentProviderProtocolError {
  return new AgentProviderProtocolError({ code: "PROVIDER_PROTOCOL_ERROR", provider: "dsh", operation, retryable: false, message, cause });
}
