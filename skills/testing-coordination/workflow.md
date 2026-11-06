# Builtin testing Workflow

Install with `devspace agents skill --skill testing-coordination --install codex --project` (or another supported installation target). The original skill command still defaults to subagents. `workflow.js` is the bundled implementation; invoke it through the builtin entry so the runtime can enforce its contract.

Enable `DEVSPACE_EXPERIMENTAL_WORKFLOWS=1` and enabled subagents. Configure DSH explicitly, for example:

```json
{"id":"dsh","driver":"dsh","enabled":true,"command":"/absolute/path/to/compatible/dsh","config":{"profile":"sdk"}}
```

Prepare a JSON file outside the target checkout, using real project paths and commands:

```json
{
  "taskId": "contact-form",
  "task": "Analyze the form and implement scenario-linked test cases and browser E2E tests.",
  "baseRef": "HEAD",
  "inputs": ["app.js"],
  "allowedPaths": ["test", "test-results"],
  "artifacts": ["test/CASES.md", "test/form.spec.js"],
  "acceptance": ["Valid submission succeeds", "Invalid input is rejected", "Maximum-length boundary is asserted"],
  "checks": [{
    "id": "e2e", "executable": "node", "args": ["test/run-e2e.js"],
    "timeoutMs": 120000, "maxOutputBytes": 32768,
    "reports": ["test-results/results.json"]
  }],
  "planner": "codex", "implementer": "auto", "reviewer": "codex",
  "mode": "enabled", "maxRepairs": 2, "maxCalls": 12, "timeoutMs": 1200000
}
```

`baseRef` resolves once to a commit. Omit it only for a clean checkout. With uncommitted inputs the host must confirm the intended committed base and explicitly supply it; the runtime does not include dirty files. No auto-commit occurs. Do not pass `HEAD` without reviewing relevant dirty inputs.

`inputs` must be readable regular files. All paths are workspace-relative without traversal or `.git`. `allowedPaths` entries match exact paths or directory prefixes. Implementation artifacts and verification reports must be distinct; checks must have unique IDs and separate report paths. Commands use executable + argv, optional workspace-relative cwd, bounded timeout/output and no implicit shell. Host-authored executable/argv remain immutable during a run. Run only commands whose authority and side effects the user authorized.

```sh
devspace workflow run --builtin testing-coordination --args-file /absolute/path/contract.json --write-mode allowed
devspace workflow wait <id> --timeout 60
devspace workflow status <id> --json
devspace workflow calls <id> --json
devspace workflow events <id> --json
```

The builtin flag is mutually exclusive with `--file`, `--name` and `--resume`. No additional MCP tool is needed. Calls and events preserve ownership and worktree locations. `testing_task_contract` events link phase IDs, dependencies, inputs, allowed paths, artifacts, checks, acceptance conditions, failure owner and repair budget. Inspection, verification and acceptance records are private JSON files under the state directory's `workflow-evidence/<run-id>`; events point to them. Failed worktrees and records are retained.

The planner returns a structured plan with scenario IDs and an implementation task. Downstream work requires a completed upstream result with no unresolved issues and readable reported artifacts. Runtime inspection checks changes, deletions, renames (as delete/add), untracked files including ignored files, modes, symlinks, index and HEAD. Repositories exceeding bounded inspection limits block rather than silently omit files. Symlinks cannot serve as evidence.

Independent checks run by declared ID. Evidence includes actual command, exit code, timeout, duration, bounded redacted output, report hashes and source digest. Report files must be fresh. Checks may write their declared reports but must not alter test or business source. Any later source change invalidates earlier checks; review binds current files and current report hashes. Codex reviews read-only against real diffs and evidence. No zero-exit-only acceptance.

Implementation failure or failed verification leads to Codex diagnosis after the old turn stops. Only precise in-scope test defects are repairable; the two-round budget is shared across provider changes and Shadow branches. Schema corrections count against the model-call budget. Workflow cancellation stops owned work; restarting does not replay writes.

Malformed testing responses produce `testing_invalid_output` events linking the agent, turn and initial/correction stage to a redacted response excerpt (at most 2048 characters), truncation flag and remaining call budget. The failure passed to diagnosis includes this evidence as untrusted data. Format corrections remain read-only; Markdown fences are rejected rather than silently stripped, and repeated invalid output cannot count as acceptance.

For explicit comparison set `mode: "shadow"`, `planner` to a Codex target/profile and `shadowImplementer` to an enabled DSH target/profile. Both branches start from the same commit and task input, share one plan and the total call/time/repair budgets, and receive independent verification and review. Cost/usage stay `null` when unavailable. The result is a recommendation, never a configuration change.

Report four separate statuses: code implementation, offline validation, real model acceptance, and cross-platform validation. Live acceptance is capped cumulatively at 20 minutes and 12 model calls, including repairs and comparisons. Stop on missing credentials or browser/platform prerequisites, retaining evidence and an explicit next owner.
