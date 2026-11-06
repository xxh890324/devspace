import * as z from "zod/v4";
import { WorkflowError } from "./workflow-types.js";
import type { WireInput } from "./json-value.js";

const relativePath = z.string().min(1).max(512).refine((path) =>
  !path.includes("\\") && !path.includes(":") && !path.includes("\0") && !path.startsWith("/") && !/^[a-z]:/i.test(path)
  && path.split("/").every((part) => part !== ".." && part.toLowerCase() !== ".git" && part !== "" && part !== "." && !/[ .]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part)), "Use a workspace-relative path without traversal or .git.");

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);

const checkSchema = z.object({
  id, executable: z.string().min(1).max(1024).refine((value) => !value.includes("\0")), args: z.array(z.string().max(8192).refine((value) => !value.includes("\0"))).max(128).default([]),
  cwd: relativePath.optional(), timeoutMs: z.number().int().min(1).max(300_000).default(120_000),
  maxOutputBytes: z.number().int().min(256).max(131_072).default(32_768),
  reports: z.array(relativePath).max(32).default([]),
}).strict();

export const testingRunSchema = z.object({
  task: z.string().trim().min(1).max(16_384), taskId: id.default("testing"),
  allowedPaths: z.array(relativePath).min(1).max(64),
  artifacts: z.array(relativePath).min(1).max(64),
  checks: z.array(checkSchema).min(1).max(16),
  inputs: z.array(relativePath).max(64).default([]),
  acceptance: z.array(z.string().trim().min(1).max(2048)).min(1).max(64),
  failureOwner: z.enum(["codex", "human"]).default("codex"),
  maxRepairs: z.number().int().min(0).max(2).default(2),
  maxCalls: z.number().int().min(1).max(12).default(12),
  timeoutMs: z.number().int().min(1000).max(1_200_000).default(1_200_000),
  planner: z.string().min(1).max(128).default("codex"),
  implementer: z.string().min(1).max(128).default("auto"),
  shadowImplementer: z.string().min(1).max(128).default("dsh"),
  reviewer: z.string().min(1).max(128).default("codex"),
  mode: z.enum(["enabled", "shadow"]).default("enabled"),
  baseRef: z.string().min(1).max(256).optional(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.checks.map((check) => check.id)).size !== value.checks.length) ctx.addIssue({ code: "custom", message: "Verification check ids must be unique." });
  const reports = value.checks.flatMap((check) => check.reports);

  if (new Set(reports).size !== reports.length) ctx.addIssue({ code: "custom", message: "Checks must not share report paths." });

  if (reports.some((path) => value.artifacts.includes(path))) ctx.addIssue({ code: "custom", message: "Implementation artifacts and verification reports must be distinct." });

  for (const path of [...value.artifacts, ...value.checks.flatMap((check) => check.reports)]) {
    if (!allowedTestingPath(path, value.allowedPaths)) ctx.addIssue({ code: "custom", message: `Artifact/report outside allowedPaths: ${path}` });
  }
});

export type TestingRunConfig = z.infer<typeof testingRunSchema>;

export type TestingCheck = z.infer<typeof checkSchema>;

export function parseTestingRun(value: WireInput): TestingRunConfig {
  const parsed = testingRunSchema.safeParse(value);

  if (!parsed.success) throw new WorkflowError("INVALID_TESTING_CONTRACT", parsed.error.message);

  return parsed.data;
}

export function allowedTestingPath(path: string, allowed: readonly string[]): boolean {
  return allowed.some((entry) => path === entry || path.startsWith(`${entry}/`));
}

export const inspectionRequestSchema = z.object({
  workspace: id,
  artifacts: z.array(relativePath).max(128).default([]),
}).strict();

export const verificationRequestSchema = z.object({ workspace: id, checkId: id }).strict();
