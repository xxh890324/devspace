# Writing DevSpace workflows

A workflow is one JavaScript file. It runs in an isolated QuickJS sandbox with no filesystem, network, `import`,
`require`, or timers: the only capabilities are the primitives below. Save named workflows as
`.devspace/workflows/<name>.js` in the project, or run any file with `devspace workflow run --file <path>`.

## Shape

```js
export const meta = {
  name: "review-auth",
  description: "Review auth changes from two perspectives",
  concurrency: 2,
};

const reviews = await phase("Review", (agent) => parallel(
  [
    { target: "codex", focus: "correctness" },
    { target: "claude", focus: "security" },
  ],
  ({ target, focus }) => agent(`Review the auth diff for ${focus}. Cite files.`, { target, label: focus }),
));

const summary = await phase("Synthesize", (agent) => agent(
  `Merge these reviews into one prioritized list: ${JSON.stringify(reviews)}`,
  { target: "codex", label: "summary" },
));

return { reviews, summary };
```

- The body runs inside an async function: use top-level `await`, and `return` the run's result. The result must be
  JSON-compatible.
- `meta` is optional. When present it must be the first statement, and it is parsed as data, never executed:
  - `name`: string, at most 128 characters (default `"workflow"`).
  - `description`: string, at most 2048 characters.
  - `concurrency`: integer 1–16 (default 4). Caps how many agent calls this run executes at once.
  - Values must be literal single-line strings or numbers. No other fields, expressions, or variables.

## Primitives

| Primitive | Behavior |
| --- | --- |
| `agent(prompt, options)` | Runs one subagent turn and resolves to its final response: a string, or the parsed JSON value when `options.schema` is set. Rejects if the agent fails or stops. |
| `phase(name, (agent) => ...)` | Groups calls under a named phase in the event log. Use the `agent` passed to the callback so each call is tagged with the phase. Resolves to the callback's value. |
| `parallel(items, worker, concurrency?)` | Calls `worker(item, index)` for every item, at most `concurrency` at a time (default `meta.concurrency`, maximum 16). Never rejects: resolves to one `{ status: "completed", value }` or `{ status: "failed", error: { code, message, retryable } }` per item, in input order. |
| `pipeline(items, ...stages)` | Passes each item through the stages in order, calling `stage(value, item, index)` where `value` is the previous stage's result. Items run concurrently like `parallel` and resolve to the same per-item outcomes. |
| `workflow(name, args?)` | Runs another named workflow from `.devspace/workflows/` and resolves to its result. |
| `inspect({workspace, artifacts?})` | Builtin testing contract only: create/reuse its isolated worktree and return a baseline-relative manifest, hashes, excerpts and scope violations. |
| `verify({workspace, checkId})` | Builtin testing contract with allowed authority only: execute a host-declared executable/argv check, recording bounded output, cancellation, reports and current file evidence. Cannot supply replacement commands. |
| `log(...values)` | Records JSON-compatible progress in the run's event log. |
| `args` | The frozen JSON arguments passed with `--args` or `--args-file`; `{}` when none were passed. |

Because `parallel` and `pipeline` report failures per item instead of rejecting, check `status` before using
`value`:

```js
const results = await parallel(files, (file) => agent(`Summarize ${file}.`, { target: "codex" }));
const summaries = results.filter((r) => r.status === "completed").map((r) => r.value);
const failures = results.filter((r) => r.status === "failed").map((r) => r.error.message);
```

`inspect` and `verify` are denied for ordinary file/named workflows: only the whitelisted
`--builtin testing-coordination` source receives a parsed, immutable host contract. Run it with
`--args-file <contract.json> --write-mode allowed`; builtin, file, name and resume selections are mutually exclusive.
See [testing contract and evidence](../testing-coordination/workflow.md). No new MCP tool is exposed.

## `agent` options

| Option | Meaning |
| --- | --- |
| `target` | **Required.** A provider or profile name from `devspace agents targets`, or `"auto"` with `coordination` below. |
| `model`, `effort` | Override the target's model or reasoning effort. |
| `label` | Short name shown in `devspace workflow calls`. |
| `schema` | JSON Schema for a structured response (see below). |
| `writeMode` | `"read_only"` or `"allowed"`. Defaults to the run's authority and can never exceed it. |
| `isolation` | `"worktree"`: run this call in its own Git worktree created from committed `HEAD`. |
| `workspace` | A logical name (letters, digits, `_`, `-`; at most 64) for a worktree that later calls in this run reuse. Never a path. The first call that uses a name must also pass `isolation: "worktree"` to create it; later calls pass only `workspace`. |
| `coordination` | Host-authored testing metadata: `kind` (`analysis`, `implementation`, `review`, `verification`), `uncertainty` (`low`, `medium`, `high`; default `medium`), `scope` (`tests_only`, `test_and_fixtures`, `business_code`; default `tests_only`), `routing` (`explicit`, `shadow`, `enabled`; default `enabled`). |

Any other option is rejected. Each prompt should be self-contained: a subagent sees only its prompt and the
project, not the rest of the workflow.

With `target: "auto"`, only low uncertainty test implementation in `enabled` routing selects an enabled DSH
instance with an executable command. Other work stays on an enabled Codex instance. `explicit` routing requires a
concrete target; `shadow` keeps execution on Codex. Each automatic selection emits `routing_decision`, retaining
the requested target, selected target, reason, and fallback suggestion. Calls persist the selected target.
Concrete targets always take precedence. Automatic routing chooses provider instances, not role profiles; pass a
profile explicitly when its instructions matter. Configure provider-specific models on providers or profiles.
If a profile shadows an automatically selected provider name, the call fails with `AMBIGUOUS_TARGET`; select that
profile explicitly or give the provider a distinct instance id.

Executable preflight does not verify SDK compatibility or credentials. If DSH fails during execution, the call
fails and the host or workflow must decide recovery after inspecting any edits. No writing call is retried on
another provider automatically. `scope` is routing metadata, not a filesystem allowlist: validate the resulting
diff before accepting it. For a plan → implementation → review example with blocked handoffs, read the
`testing-coordination` skill and its `workflow.md` reference.

### Structured responses

Pass `schema` when a later step consumes the result. DevSpace validates the response, asks the same agent once to
fix invalid JSON (read-only, and it counts toward the turn budget), then resolves to the parsed value.

```js
const { bugs } = await agent("List the bugs in the diff as JSON.", {
  target: "codex",
  schema: {
    type: "object",
    properties: { bugs: { type: "array", items: { type: "string" } } },
    required: ["bugs"],
  },
});
```

Schemas are strict draft-07 with inline structural constraints only: at most 16 KiB, 512 nodes, and 16 levels deep.
`$ref`, `$dynamicRef`, `$recursiveRef`, `$async`, `pattern`, `patternProperties`, and `format` are rejected.

### Edits

Runs are read-only unless started with `devspace workflow run ... --write-mode allowed`. In a writing run, give
editing calls `writeMode: "allowed"`. Add `isolation: "worktree"` when parallel calls might edit the same files, so
each works in its own worktree; isolated worktrees do not see uncommitted changes. To let several calls work on the
same tree in turn (implement, then review, then fix), create a named worktree once and reuse it:

```js
await agent("Implement the change.", { target: "claude", writeMode: "allowed", isolation: "worktree", workspace: "feature" });
await agent("Review the uncommitted diff.", { target: "codex", writeMode: "read_only", workspace: "feature" });
```

Without `workspace` or `isolation`, calls run in the checkout the workflow was started from. Worktrees are kept for
inspection afterwards.

For proven multi-step engineering loops (plan, implement, review, QA, bake-offs, fan-out), see `patterns.md`.

## Resume

`devspace workflow run --resume <id>` reruns the script with the original arguments. Completed read-only calls are
reused as long as the script makes the same calls in the same order with the same prompts and options; from the first
call that differs, everything runs fresh. Keep prompts deterministic (no timestamps or random values) so resume can
reuse work.

Resume is refused (`RECOVERY_REQUIRED`) for a run that made any call with `writeMode: "allowed"`, `isolation`, or
`workspace`, even a read-only call, because those may have changed a workspace: inspect its calls and preserved
worktrees, then start a new run. It is also refused (`RECOVERY_CONTEXT_CHANGED`) when the project's context changed
since the original run.

## Limits

| Boundary | Limit |
| --- | --- |
| Agent turns per run | 128, including schema corrections |
| Nested `workflow()` calls | 8 per run, one level deep |
| Script wall clock | 15 minutes |
| Script source / arguments | 64 KiB / 128 KiB |
| Agent response / run result | 256 KiB |
| `log` and `phase` events | 64 KiB per run |
| Sandbox heap / stack | 32 MiB / 512 KiB |

Exceeding a run limit ends the whole run, and `try`/`catch` in the script cannot recover from it: the turn, nesting
(a `workflow()` nested past one level), time, size, and event limits, and stack overflow. Running out of sandbox heap
is different: it throws a catchable `InternalError: out of memory`. Ordinary agent failures (unknown target, provider
errors, invalid output) are normal rejections you can catch, and `parallel`/`pipeline` report them per item.
