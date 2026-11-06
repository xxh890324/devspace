import { isJsonString, isObjectValue } from "../../src/json-value.js";
import type { WireInput } from "../../src/json-value.js";
import { readFileSync, realpathSync } from "node:fs";
import { redactSecrets } from "../../src/local-agent-events.js";

/**
 * A transcript is the stdio traffic between one driver and one provider
 * process: a meta line, then one line per newline-delimited frame. `in` frames
 * were written by the driver to the provider's stdin, `out` frames were read
 * from its stdout. Frames are stored scrubbed: machine-specific paths become
 * placeholders and credential-shaped strings are redacted.
 */
export interface TranscriptMeta {
  type: "meta";
  provider: string;
  scenario: string;
  /** Provider arguments, scrubbed like frames. */
  args: string[];
  /** Where the driver started the provider process, scrubbed; replay requires the same. */
  cwd?: string;
  /** Output of `<command> --version`, replayed for drivers that probe it. */
  version?: string;
  recordedAt: string;
  source?: string;
}

export interface TranscriptFrame {
  dir: "in" | "out" | "signal";
  /** Milliseconds since the provider process started. */
  ms: number;
  frame: unknown;
}

export interface Transcript {
  meta: TranscriptMeta;
  frames: TranscriptFrame[];
}

export function readTranscript(path: string): Transcript {
  const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim());
  // SAFETY: The surrounding checks or construction already match this type.
  const [meta, ...frames] = lines.map((line) => JSON.parse(line) as unknown);

  // SAFETY: The surrounding checks or construction already match this type.
  if ((meta as TranscriptMeta | undefined)?.type !== "meta") {
    throw new Error(`${path} does not start with a transcript meta line.`);
  }

  // SAFETY: The surrounding checks or construction already match this type.
  return { meta: meta as TranscriptMeta, frames: frames as TranscriptFrame[] };
}

/** Machine-specific values replaced by placeholders, most specific first. */
export interface ScrubContext {
  workspace: string;
  /** The `--worktree` checkout the provider runs in, when the scenario uses one. */
  worktree?: string;
  home: string;
  tmp: string;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const cachedPlaceholders = new WeakMap<ScrubContext, Array<[string, string]>>();

function placeholders(context: ScrubContext): Array<[string, string]> {
  const cached = cachedPlaceholders.get(context);

  if (cached) return cached;
  const result: Array<[string, string]> = [];

  const roots: Array<[string | undefined, string, string?]> = [
    [context.worktree, "$WORKTREE", "$WORKTREE_SLUG"],
    [context.workspace, "$WORKSPACE", "$CWD_SLUG"],
    [context.tmp, "$TMP"], [context.home, "$HOME"],
  ];

  for (const [path, placeholder, slug] of roots) {
    if (!path) continue;
    const spellings = new Set([path]);

    // Node's cwd and native providers may expand Windows 8.3 names (or /var
    // aliases) while the runner retains the configured spelling of that root.
    try { spellings.add(realpathSync.native(path)); }
    catch { /* Optional roots may not exist yet; retain their explicit spelling. */ }

    for (const spelling of spellings) {
      for (const variant of new Set([spelling, spelling.replaceAll("\\", "/")])) result.push([variant, placeholder]);

      if (slug) result.push([spelling.replace(/[/\\.:]/g, "-"), slug]);
    }
  }

  cachedPlaceholders.set(context, result);

  return result;
}

export function scrub(value: WireInput, context: ScrubContext): WireInput {
  return mapStrings(value, (text) => {
    let next = text;

    for (const [actual, placeholder] of placeholders(context)) {
      if (actual) next = next.replaceAll(actual, placeholder);
    }

    return redactSecrets(next).replace(EMAIL, "user@example.invalid");
  });
}

export function restore(value: WireInput, context: ScrubContext): WireInput {
  return mapStrings(value, (text) => {
    let next = text;

    for (const [actual, placeholder] of placeholders(context)) next = next.replaceAll(placeholder, actual);

    return next;
  });
}

export function mapStrings(value: WireInput, map: (text: string) => string): WireInput {
  if (isJsonString(value)) return map(value);

  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, map));

  if (value && isObjectValue(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, mapStrings(entry, map)]));
  }

  return value;
}

/** Parses one stdio line; lines that are not JSON are kept as raw strings. */
export function parseFrame(line: string): WireInput {
  try {
    // SAFETY: The surrounding checks or construction already match this type.
    return JSON.parse(line) as WireInput;
  } catch {
    return { raw: line };
  }
}
