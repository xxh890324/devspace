export const meta = { name: "testing-coordination", description: "Plan, implement, verify and review bounded testing tasks", concurrency: 1 };

const strings = { type: "array", maxItems: 64, items: { type: "string", minLength: 1 } };

const properties = {
  status: { enum: ["completed", "blocked", "failed"] }, artifacts: strings,
  verification: strings, evidence: { ...strings, minItems: 1 }, unresolved: strings,
  nextOwner: { enum: ["codex", "dsh", "human"] },
};

const resultSchema = { type: "object", properties, required: Object.keys(properties), additionalProperties: false };

const planSchema = {
  type: "object", additionalProperties: false,
  properties: { ...properties, uncertainty: { enum: ["low", "medium", "high"] }, testPlan: { type: "string", minLength: 1 }, implementationTask: { type: "string", minLength: 1 } },
  required: [...Object.keys(properties), "uncertainty", "testPlan", "implementationTask"],
};

const diagnosisSchema = {
  type: "object", additionalProperties: false,
  properties: { ...properties, repairable: { type: "boolean" }, instructions: { type: "string" }, uncertainty: { enum: ["low", "medium", "high"] } },
  required: [...Object.keys(properties), "repairable", "instructions", "uncertainty"],
};

const blocked = (reason, nextOwner = args.failureOwner) => ({ status: "blocked", reason, nextOwner });
const usable = result => result.status === "completed" && result.unresolved.length === 0;
const errorData = error => ({ code: error.code || "UNKNOWN", message: error.message || String(error) });
const unsafeFailure = failure => ["TESTING_SCOPE", "TESTING_STALE_EVIDENCE", "RECOVERY_REQUIRED", "PROVIDER_CANCELLED", "PROVIDER_PROTOCOL_ERROR", "PROVIDER_PERMISSION_ERROR", "WORKFLOW_CANCELLED"].includes(failure.code);

// Create all branches before analysis; each receives the same immutable base SHA.
const branches = args.mode === "shadow" ? [args.planner, args.shadowImplementer] : [args.implementer];
const workspaces = branches.map((_, index) => "testing_" + index);

for (const workspace of workspaces) await inspect({ workspace });

const plan = await phase("Analyze", agent => agent(
  `Analyze the committed code for this host-authored testing contract: ${JSON.stringify(args)}\n` +
  "Do not change files or execute tests. Return a self-contained testPlan with scenario IDs, input/expected behavior, and implementationTask. " +
  "Business code is outside scope. Set blocked for missing requirements. Artifacts may be empty because this stage returns its plan as structured text.",
  { target: args.planner, workspace: workspaces[0], writeMode: "read_only", coordination: { kind: "analysis" }, schema: planSchema },
));

if (!usable(plan)) return { ...blocked("Plan has unresolved requirements", plan.nextOwner), plan };

const results = [];
let repairs = 0;

for (let branch = 0; branch < branches.length; branch++) {
  const workspace = workspaces[branch];
  const startedAt = Date.now();
  let owner = branches[branch];
  let instructions = plan.implementationTask;
  let uncertainty = plan.uncertainty;
  let outcome;

  for (let attempt = 0; attempt <= args.maxRepairs; attempt++) {
    let implementation;
    let inspection;
    let verification = [];
    let failure;

    try {
      implementation = await phase("Implement " + workspace + " attempt " + attempt, agent => agent(
        `Implement test cases and E2E automation for task ${args.taskId}.\nContract: ${JSON.stringify(args)}\nPlan: ${JSON.stringify(plan)}\nInstructions: ${instructions}\n` +
        "Change only declared allowedPaths. Do not change business code, commits, dependencies, verification commands, or weaken existing assertions. " +
        "Independent verification runs after you finish. Return changed paths and evidence; do not claim tests passed without running them. Stop on ambiguity.",
        { target: owner, workspace, writeMode: "allowed", coordination: { kind: "implementation", uncertainty, scope: "test_and_fixtures" }, schema: resultSchema },
      ));
      inspection = await inspect({ workspace, artifacts: Array.from(new Set(args.artifacts.concat(implementation.artifacts))) });

      if (inspection.violations.length) return { ...blocked("Changes or artifacts violate scope", "human"), workspace, inspection, results };

      if (implementation.status === "blocked" || implementation.unresolved.length) { outcome = { ...blocked("Implementation requires clarification", implementation.nextOwner), workspace, implementation }; break; }

      if (!usable(implementation)) failure = { code: "IMPLEMENTATION_FAILED", message: JSON.stringify(implementation) };
      else {
        for (const check of args.checks) verification.push(await verify({ workspace, checkId: check.id }));

        if (verification.some(check => !check.passed)) failure = { code: "VERIFICATION_FAILED", message: JSON.stringify(verification) };
        else {
          const review = await phase("Review " + workspace + " attempt " + attempt, agent => agent(
            `Read the actual diff and independently assess the tests against this plan. Do not change files or run commands that write.\n` +
            `Contract: ${JSON.stringify(args)}\nPlan: ${JSON.stringify(plan)}\nImplementation: ${JSON.stringify(implementation)}\nInspection: ${JSON.stringify(inspection)}\nVerification: ${JSON.stringify(verification)}\n` +
            "Return completed only if coverage, assertions, allowed paths and independent evidence meet every acceptance condition. Missing evidence is blocked.",
            { target: args.reviewer, workspace, writeMode: "read_only", coordination: { kind: "review" }, schema: resultSchema },
          ));

          if (usable(review)) {
            const current = await inspect({ workspace, artifacts: args.artifacts });
            outcome = { status: "completed", workspace, owner, attempts: attempt, implementation, verification, review, digest: current.digest };
            break;
          }

          if (review.status === "blocked" || review.unresolved.length) { outcome = { ...blocked("Review requires clarification", review.nextOwner), workspace, review }; break; }

          failure = { code: "REVIEW_REJECTED", message: JSON.stringify(review) };
        }
      }
    } catch (error) { failure = errorData(error); }

    if (unsafeFailure(failure)) { outcome = { ...blocked(failure.message, "human"), workspace, failure, attempts: attempt }; break; }

    if (repairs >= args.maxRepairs) { outcome = { ...blocked("Repair budget exhausted", args.failureOwner), workspace, failure, attempts: attempt }; break; }

    const current = await inspect({ workspace });

    if (current.violations.length) { outcome = { ...blocked("Out-of-scope partial changes", "human"), workspace, inspection: current }; break; }

    const diagnosis = await phase("Diagnose " + workspace + " attempt " + attempt, agent => agent(
      `Diagnose this failed testing step without changing files. Contract: ${JSON.stringify(args)}\nPlan: ${JSON.stringify(plan)}\nFailure: ${JSON.stringify(failure)}\nPartial work: ${JSON.stringify(current)}\n` +
      "Set repairable only for a precise test implementation defect within allowedPaths. Missing requirements or uncertain permissions are not repairable. Give bounded repair instructions, uncertainty and the next owner.",
      { target: args.planner, workspace, writeMode: "read_only", coordination: { kind: "analysis" }, schema: diagnosisSchema },
    ));

    if (repairs >= args.maxRepairs || !usable(diagnosis) || !diagnosis.repairable || diagnosis.unresolved.length || !diagnosis.instructions.trim() || diagnosis.nextOwner === "human") {
      outcome = { ...blocked("Repair budget exhausted or diagnosis requires host input", diagnosis.nextOwner), workspace, failure, diagnosis, attempts: attempt }; break;
    }

    repairs++;
    instructions = diagnosis.instructions;
    uncertainty = diagnosis.uncertainty;
    // Provider failure may move ownership to Codex only after diagnosis inspected partial work.
    owner = diagnosis.nextOwner === "codex" ? args.planner : args.mode === "shadow" ? branches[branch] : args.implementer;
  }

  results.push({ ...outcome, durationMs: Date.now() - startedAt, usage: null, cost: null });
}

const completed = results.every(result => result.status === "completed");

return { status: completed ? "completed" : "blocked", nextOwner: completed ? "codex" : "human", taskId: args.taskId,
  mode: args.mode, repairCount: repairs, plan, results, recommendation: args.mode === "shadow" ? "Inspect quality and duration before explicitly enabling a route; cost is unknown when providers omit usage." : null };
