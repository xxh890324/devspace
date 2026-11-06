import * as z from "zod/v4";
import type { SubagentProviderConfig } from "./local-agent-config.js";
import type { WireInput } from "./json-value.js";

export const coordinationTaskSchema = z.object({
  kind: z.enum(["analysis", "implementation", "review", "verification"]),
  uncertainty: z.enum(["low", "medium", "high"]).default("medium"),
  scope: z.enum(["tests_only", "test_and_fixtures", "business_code"]).default("tests_only"),
  routing: z.enum(["explicit", "shadow", "enabled"]).default("enabled"),
}).strict();

export const coordinationResultSchema = z.object({
  status: z.enum(["completed", "blocked", "failed"]),
  artifacts: z.array(z.string().trim().min(1)).default([]),
  verification: z.array(z.string().trim().min(1)).default([]),
  evidence: z.array(z.string().trim().min(1)).min(1),
  unresolved: z.array(z.string().trim().min(1)).default([]),
  nextOwner: z.enum(["codex", "dsh", "human"]).optional(),
}).strict().superRefine((result, context) => {
  if (result.status !== "completed" && (!result.nextOwner || result.unresolved.length === 0)) {
    context.addIssue({ code: "custom", message: "Blocked or failed results require unresolved questions and a nextOwner." });
  }
});

export type CoordinationTask = z.infer<typeof coordinationTaskSchema>;

export type CoordinationResult = z.infer<typeof coordinationResultSchema>;

export interface RoutingDecision {
  target: string;
  reason: "explicit" | "codex_review" | "dsh_implementation" | "dsh_unavailable" | "high_uncertainty" | "medium_uncertainty" | "business_code" | "shadow";
  fallback?: string;
}

/**
 * Chooses a provider only for an explicit `auto` workflow call. The host still
 * owns decomposition and can always pass a concrete target to bypass this
 * policy. DSH is selected for bounded implementation work; analysis, review,
 * verification, and uncertain work stay with Codex.
 */
export function chooseTestingTarget(input: {
  requestedTarget: string;
  task: CoordinationTask;
  providers: readonly SubagentProviderConfig[];
  available?: (provider: SubagentProviderConfig) => boolean;
}): RoutingDecision {
  if (input.requestedTarget !== "auto") {
    return { target: input.requestedTarget, reason: "explicit" };
  }

  if (input.task.routing === "explicit") throw new Error("Explicit coordination routing requires a concrete target, not auto.");

  const codex = input.providers.find((provider) => provider.driver === "codex" && provider.enabled);
  const dsh = input.providers.find((provider) => provider.driver === "dsh" && provider.enabled && (input.available?.(provider) ?? true));
  const codexTarget = codex?.id ?? "codex";

  if (input.task.routing === "shadow") return { target: codexTarget, reason: "shadow" };

  if (input.task.uncertainty === "high") return { target: codexTarget, reason: "high_uncertainty" };

  if (input.task.kind !== "implementation") return { target: codexTarget, reason: "codex_review" };

  if (input.task.uncertainty !== "low") return { target: codexTarget, reason: "medium_uncertainty" };

  if (input.task.scope === "business_code") return { target: codexTarget, reason: "business_code" };

  if (dsh) return { target: dsh.id, reason: "dsh_implementation", fallback: codexTarget };

  return { target: codexTarget, reason: "dsh_unavailable", fallback: "dsh" };
}

export function parseCoordinationTask(value: WireInput): CoordinationTask {
  return coordinationTaskSchema.parse(value);
}

export function parseCoordinationResult(value: WireInput): CoordinationResult {
  return coordinationResultSchema.parse(value);
}
