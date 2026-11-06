import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import * as z from "zod/v4";
import { redactSecrets } from "../src/local-agent-events.js";
import { parseJsonValue, type JsonValue, type WireInput } from "../src/json-value.js";

const exec = promisify(execFile);
export const LIVE_MAX_CALLS = 12;
export const LIVE_MAX_MS = 1_200_000;

const counters = z.object({ calls: z.number().int().nonnegative(), elapsedMs: z.number().int().nonnegative(),
  reserved: z.boolean().optional(), exhausted: z.boolean().optional() });

async function writeAtomic(path: string, value: JsonValue): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/** Keep the lock for the whole exercise. A crash leaves a reservation, never fresh allowance. */
export async function reserveLiveBudget(path: string, root: string) {
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const lock = await open(lockPath, "wx", 0o600);

  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, root }));
    let previous: z.infer<typeof counters>;

    try {
      if (!(await lstat(path)).isFile()) throw new Error("Budget ledger must be a regular file");
      previous = counters.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      previous = { calls: 0, elapsedMs: 0 };
    }

    if (previous.reserved || previous.exhausted || previous.calls >= LIVE_MAX_CALLS || previous.elapsedMs >= LIVE_MAX_MS) {
      throw new Error("Live budget exhausted or reserved; inspect retained evidence, do not reset the ledger");
    }

    const started = Date.now();
    await writeAtomic(path, { calls: LIVE_MAX_CALLS, elapsedMs: LIVE_MAX_MS, reserved: true, root, prior: previous, reservedAt: new Date(started).toISOString() });
    let settled = false;

    return {
      remainingCalls: LIVE_MAX_CALLS - previous.calls,
      get remainingMs() { return Math.max(0, LIVE_MAX_MS - previous.elapsedMs - Math.max(0, Date.now() - started)); },
      async settle(observation: AcceptanceObservation): Promise<void> {
        if (settled) throw new Error("Budget already settled");
        // Incomplete CLI receipts, missing turn links or unconfirmed cleanup retain the reservation.

        if (!observation.stopConfirmed || !observation.daemonStopped || observation.errors.length || !observation.final) return;
        const turns = observation.events.filter((event) => event.type === "agent_turn");

        if (observation.calls.some((call) => !call.turnId || !turns.some((event) => event.data.turnId === call.turnId))) return;
        const calls = previous.calls + turns.length;
        const elapsedMs = previous.elapsedMs + Math.max(0, Date.now() - started);
        await writeAtomic(path, { calls, elapsedMs, exhausted: calls >= LIVE_MAX_CALLS || elapsedMs >= LIVE_MAX_MS, root, runId: observation.final.id });
        settled = true;
      },
      async release(): Promise<void> { await lock.close(); await rm(lockPath); },
    };
  } catch (error) {
    await lock.close();
    await rm(lockPath);
    throw error;
  }
}

export interface CommandRecord {
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number | string | null;
  signal: string | null;
  killed: boolean;
  error?: string;
}

export class AcceptanceCommandError extends Error {
  constructor(readonly record: CommandRecord) {
    super(`Acceptance CLI failed: ${JSON.stringify(record)}`);
  }
}

/** A valid JSON stdout from a killed/nonzero command is still a failed command. */
export async function runAcceptanceCli(options: {
  cliPath: string; cwd: string; env: NodeJS.ProcessEnv; args: string[]; timeoutMs?: number;
  record: (value: CommandRecord) => Promise<void>;
}): Promise<JsonValue> {
  let record: CommandRecord;

  try {
    const result = await exec(process.execPath, [options.cliPath, ...options.args, "--json"], {
      cwd: options.cwd, env: options.env, timeout: options.timeoutMs ?? 75_000, maxBuffer: 4 * 1024 * 1024, killSignal: "SIGKILL",
    });

    record = { args: options.args, stdout: redactSecrets(result.stdout), stderr: redactSecrets(result.stderr), exitCode: 0, signal: null, killed: false };
  } catch (error) {
    const failure = z.object({ stdout: z.string().optional(), stderr: z.string().optional(), code: z.union([z.string(), z.number()]).nullable().optional(),
      signal: z.string().nullable().optional(), killed: z.boolean().optional(), message: z.string() }).parse(error);

    record = { args: options.args, stdout: redactSecrets(failure.stdout ?? ""), stderr: redactSecrets(failure.stderr ?? ""),
      exitCode: failure.code ?? null, signal: failure.signal ?? null, killed: failure.killed ?? false, error: redactSecrets(failure.message) };
    await options.record(record);
    throw new AcceptanceCommandError(record);
  }

  await options.record(record);

  try { return parseJsonValue(record.stdout); }
  catch { throw new Error("Acceptance CLI returned invalid JSON; inspect command records"); }
}

const runSchema = z.object({ id: z.string().min(1), status: z.enum(["starting", "running", "stopping", "completed", "failed", "cancelled", "interrupted"]),
  result: z.object({ status: z.string() }).passthrough().optional() }).passthrough();

const callsSchema = z.array(z.object({ turnId: z.string().optional(), status: z.string() }).passthrough());
const eventsSchema = z.array(z.object({ sequence: z.number().int().positive(), type: z.string(), data: z.record(z.string(), z.unknown()) }).passthrough());
const terminal = (status: string) => ["completed", "failed", "cancelled", "interrupted"].includes(status);

export interface AcceptanceObservation {
  final?: z.infer<typeof runSchema>;
  calls: z.infer<typeof callsSchema>;
  events: z.infer<typeof eventsSchema>;
  stopConfirmed: boolean;
  daemonStopped: boolean;
  errors: string[];
  passed: boolean;
}

/** Same collection and cleanup path for success, timeout, provider failure and CLI failure. */
export async function observeAcceptance(options: {
  cli: (args: string[], timeoutMs?: number) => Promise<JsonValue>;
  startArgs: string[];
  timeoutMs: number;
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean;
}): Promise<AcceptanceObservation> {
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;
  const result: AcceptanceObservation = { calls: [], events: [], stopConfirmed: false, daemonStopped: false, errors: [], passed: false };
  let id: string | undefined;
  const saveError = (error: WireInput) => result.errors.push(redactSecrets(error instanceof Error ? error.message : String(error)));

  const isProcessAlive = options.isProcessAlive ?? ((pid: number) => {
    try {
      process.kill(pid, 0);

      return true;
    }
    catch (error) { return !(error instanceof Error && "code" in error && error.code === "ESRCH"); }
  });

  const cliRun = async (args: string[], timeoutMs?: number) => {
    const run = runSchema.parse(await options.cli(args, timeoutMs));

    if (id && run.id !== id) throw new Error("Acceptance CLI returned a different workflow");
    result.final = run;

    return run;
  };

  try {
    if (options.timeoutMs <= 0) throw new Error("Acceptance wall-clock deadline reached before dispatch");
    const receipt = await cliRun(options.startArgs, Math.max(1, Math.min(75_000, deadline - now())));
    id = receipt.id;

    while (!terminal(result.final!.status)) {
      const remaining = deadline - now();

      if (remaining <= 0) throw new Error("Acceptance wall-clock deadline reached");
      await cliRun(["workflow", "wait", id, "--timeout", String(Math.min(60, Math.floor(remaining / 1000)))], Math.max(1, Math.min(75_000, remaining)));
    }

    if (now() >= deadline) throw new Error("Acceptance wall-clock deadline reached");
  } catch (error) {
    saveError(error);
    // A receipt from an errored start is only a cleanup hint, never successful execution.

    if (!id && error instanceof AcceptanceCommandError) {
      try {
        const receipt = runSchema.safeParse(JSON.parse(error.record.stdout));

        if (receipt.success) { id = receipt.data.id; result.final = receipt.data; }
      } catch { /* Raw command evidence is already retained. */ }
    }
  }

  if (id) {
    if (!result.final || !terminal(result.final.status)) {
      try {
        await cliRun(["workflow", "cancel", id], 15_000);

        for (let attempt = 0; attempt < 3 && !terminal(result.final!.status); attempt++) {
          await cliRun(["workflow", "wait", id, "--timeout", "5"], 15_000);
        }
      } catch (error) { saveError(error); }
    }

    // Re-read even on failure: a wait command can fail after a provider wrote partial files.
    try { await cliRun(["workflow", "status", id], 15_000); }
    catch (error) { saveError(error); }

    let callsCollected = false;

    try {
      result.calls = callsSchema.parse(await options.cli(["workflow", "calls", id], 15_000));
      callsCollected = true;
    } catch (error) { saveError(error); }

    try {
      let cursor = 0;

      for (let pages = 0; ; pages++) {
        if (pages >= 1024) throw new Error("Acceptance event page limit exceeded");

        const page = eventsSchema.parse(await options.cli(["workflow", "events", id, "--after", String(cursor)], 15_000));

        if (!page.length) break;

        if (page.some((event, index) => event.sequence <= (index ? page[index - 1]!.sequence : cursor))) throw new Error("Acceptance event cursor did not advance");
        result.events.push(...page);
        cursor = page.at(-1)!.sequence;
      }

    } catch (error) { saveError(error); }

    result.stopConfirmed = callsCollected && !!result.final && terminal(result.final.status) && result.calls.every((call) => terminal(call.status));
  }

  try {
    // This is the dedicated harness daemon, never the user's default daemon.
    const stopped = z.object({ state: z.literal("stopping"), pid: z.number().int().positive() }).parse(await options.cli(["agents", "daemon", "stop"], 15_000));
    // A stopping acknowledgement is not process termination. Read-only status never starts it.

    for (let attempt = 0; attempt < 10 && !result.daemonStopped; attempt++) {
      let unavailable = false;

      try { await options.cli(["agents", "daemon", "status"], 15_000); }
      catch (error) {
        if (error instanceof AcceptanceCommandError) {
          const payload = z.object({ error: z.object({ code: z.literal("DAEMON_UNAVAILABLE") }) }).safeParse(JSON.parse(error.record.stdout || "null"));
          unavailable = payload.success;
        }

        if (!unavailable) throw error;
      }

      result.daemonStopped = unavailable && !isProcessAlive(stopped.pid);

      if (!result.daemonStopped && attempt < 9) await delay(100);
    }

    if (!result.daemonStopped) throw new Error("Acceptance daemon termination not confirmed");
  } catch (error) { saveError(error); }

  if (now() >= deadline && !result.errors.some((error) => error.includes("wall-clock deadline"))) saveError(new Error("Acceptance wall-clock deadline reached during evidence collection or cleanup"));
  result.passed = result.stopConfirmed && result.daemonStopped && !result.errors.length && result.final?.status === "completed" && result.final.result?.status === "completed";

  return result;
}
