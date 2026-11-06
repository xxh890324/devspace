# Testing collaboration acceptance fixture

The fixture is deliberately separate from DevSpace production dependencies. Install its pinned lockfile using `npm ci --prefix test/testing-coordination-fixture`, then install Playwright Chromium into a separate cache, for example:

```sh
PLAYWRIGHT_BROWSERS_PATH=/tmp/devspace-testing-browsers node test/testing-coordination-fixture/node_modules/playwright/cli.js install chromium --only-shell
PLAYWRIGHT_BROWSERS_PATH=/tmp/devspace-testing-browsers pnpm exec tsx test/testing-coordination-live.ts --smoke
```

The smoke uses independently authored browser assertions and makes no model calls. It verifies normal trimmed submission, invalid whitespace input and the exact 20-character boundary against a loopback-only server.

For real collaboration use an isolated compatible DSH SDK and existing process credential. The optional credential-store argument reads only an existing `refs.DEEPSEEK_API_KEY` into child-process memory; it never copies or rewrites the store. Do not supply credentials on the command line.

```sh
PLAYWRIGHT_BROWSERS_PATH=/tmp/devspace-testing-browsers pnpm exec tsx test/testing-coordination-live.ts --dsh-command /absolute/path/to/isolated/dsh --ledger /tmp/devspace-testing-live-budget.json
```

The harness requires an explicit `--ledger`, creates a temporary Git fixture commit, separate DevSpace configuration/state and DSH_HOME. It exclusively locks and atomically reserves the remaining 20-minute/12-call allowance before starting. Malformed, unreadable, non-file, exhausted or already reserved ledgers block new dispatch. It records actual observed turns, including JSON corrections, only after terminal workflow/call records, complete event collection and dedicated daemon termination are confirmed. Reuse the same ledger for the entire acceptance exercise and any explicit Shadow comparison. An interrupted reserved ledger or stale `.lock` blocks further runs until a human inspects and reconciles its records; do not delete them to reset the budget. A counter below the limit does not override an explicit exhausted/reserved flag.

Codex writes the structured plan, DSH writes `tests/CASES.md` and `tests/form.spec.cjs`, the host executes Chromium using the fixed executable/argv, and Codex reviews the actual diff/evidence. Generated tests use CommonJS `require('@playwright/test')`; dependencies are resolved from this fixture through NODE_PATH, keeping them out of the target checkout. No production business-code changes are permitted.

The harness retains worktrees, contracts, calls, events, independent JSON evidence, browser reports and a status summary in the reported temporary directory. `commands.json` preserves redacted stdout/stderr, exit code, kill signal and errors; `observation.json` records collection and stop confirmation. An errored CLI command never becomes a success just because stdout contains valid JSON. Its receipt may only identify a run for cancellation and evidence collection. Failed waits still trigger bounded cancellation, status/calls/events collection and dedicated-daemon shutdown. Unconfirmed cleanup or incomplete evidence retains the reservation. If the harness itself is killed before it can write an observation, inspect the reserved ledger's root and durable daemon records; no task is automatically replayed.

`pnpm test` includes deterministic harness regression tests (budget concurrency/corruption/interruption, CLI errors/timeouts, business blocking and cleanup). These use simulated providers and local child processes, with no model credentials or calls. The browser smoke is separate. Process timeouts and deadline checks require the OS to schedule the process; sleep/suspension is not a proven hard real-time termination guarantee.

Test-only process configurations and secrets never enter repository configuration. CI runs deterministic offline tests and replay without model credentials; live acceptance and remote platform results must be reported separately.
