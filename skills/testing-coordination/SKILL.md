---
name: testing-coordination
description: Coordinate software testing tasks between Codex analysis and acceptance and DeepSeek Harness (DSH) implementation. Use for test planning, test case generation, E2E automation, bounded repairs, and explicit provider comparisons through DevSpace.
---

# Testing coordination

Keep the host in charge of decomposition and authority. Read [workflow.md](workflow.md) for the startup contract, command examples, evidence and recovery rules. Use the bundled `testing-coordination` Workflow; do not recreate its state machine in a prompt or add a scheduler.

1. Read the target code and requirements. Establish scenario IDs, expected behavior, uncertainty, inputs, allowed test/fixture paths and acceptance conditions. Do not delegate missing requirements as implementation work.
2. Check the worktree baseline. If target inputs are uncommitted, ask the user to choose a committed baseline or handle them explicitly. Never silently omit changes or commit them. Analysis, implementation, independent verification and review use the same isolated baseline.
3. Prepare the host-authored JSON contract described in the reference. Declare executable + argv verification commands and report paths before launch. Avoid shell interpreters and project commands that do not provide useful assertions. Confirm commands, profiles and compatible DSH runtime are available.
4. Enable experimental Workflows explicitly and start `devspace workflow run --builtin testing-coordination --args-file <contract.json> --write-mode allowed`. Use explicit profiles for role instructions. `auto` selects enabled DSH only for low uncertainty test implementation; uncertain work stays with Codex. Explicit targets take priority.
5. Inspect status, calls and events. Read the actual retained diff, artifacts, independent verification records and review before reporting acceptance. A completed script or an agent's claim alone is insufficient.
6. On interruption, inspect partial changes and confirm processes stopped. Never resume/replay writing calls automatically. Repairs are limited to two for the entire task, each preceded by Codex diagnosis. Missing requirements, uncertain permissions, scope violations and exhausted budgets require an explicit owner.

DSH must acknowledge native permission presets through `session/query` and `/permission`, and restored workspace/authority through `session/resume`. DSH `0.2.2-rc.1` was compatible; `0.2.1-rc.3` lacks the query RPC and fails closed. Use a user-configured SDK profile and credentials, never migrate credentials or upgrade the global runtime implicitly.

Shadow mode requires explicit host selection and independent worktrees. Compare acceptance, repairs, time and available usage; mark unavailable billing data unknown. Report recommendations only; do not enable DSH or change configuration automatically.

Worktrees isolate files, not OS authority. Verification commands run as the local user. Scope checks detect violations and block acceptance; they cannot undo external side effects. Keep commands and tasks bounded and retain failed worktrees, logs and reports for inspection.
