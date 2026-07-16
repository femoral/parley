import {
  formatDuration,
  type JsonSchema,
} from "@useparley/core";
import {
  contextPointers,
  materializeContext,
  type ContextFile,
} from "@useparley/daemon/context.js";
import {
  DEFAULT_REPORT_SCHEMA,
  summarizeReportSchema,
} from "@useparley/daemon/report.js";

/**
 * Protocol preamble for a remote task (mirrors the daemon engine's preamble so
 * children see the same rules). Built after the worktree exists so location
 * facts are accurate.
 */
export function buildProtocolPreamble(options: {
  cwd: string;
  branch: string | null;
  answerTimeoutMs: number;
  reportSchema: JsonSchema;
}): string {
  const timeout = formatDuration(options.answerTimeoutMs);
  const schema = options.reportSchema ?? DEFAULT_REPORT_SCHEMA;
  const location =
    options.branch !== null
      ? `You are working in a git worktree at \`${options.cwd}\` on branch \`${options.branch}\`. Commit your work there; parley never merges — the orchestrator reviews the branch.`
      : `You are working directly in \`${options.cwd}\` (no dedicated branch).`;
  const pointers = contextPointers(options.cwd);
  const contextList =
    pointers.length > 0
      ? pointers.map((p) => `- \`${p}\``).join("\n")
      : "- (none)";

  return [
    "# Parley protocol",
    "",
    "You are an agent working on a task delegated through parley. Read these rules before you begin.",
    "",
    "## Where things are",
    location,
    "- Your task brief is on disk at `.parley/TASK.md` — read it first.",
    "- Supporting context files are under `.parley/context/`:",
    contextList,
    "",
    "## Tools available to you",
    `- \`ask_orchestrator({ question })\` — ask the orchestrator a blocking question when you are genuinely stuck or need a decision only they can make. It blocks until an answer arrives; a question left unanswered for ${timeout} stalls the task (it can be resumed later). Do not use it for anything you can resolve yourself.`,
    "- `submit_report({ ... })` — you MUST finish by calling this exactly once. The task only completes when you submit a report that satisfies the schema below; exiting without one is a failure.",
    "",
    "## Report schema",
    summarizeReportSchema(schema),
    "",
    "The task itself follows below (and in `.parley/TASK.md`); everything above is protocol, not the task.",
  ].join("\n");
}

export function materializeTaskContext(
  cwd: string,
  prompt: string,
  contexts: ContextFile[],
): void {
  materializeContext(cwd, prompt, contexts);
}

export function fullPrompt(
  cwd: string,
  branch: string | null,
  answerTimeoutMs: number,
  reportSchema: JsonSchema,
  brief: string,
): string {
  const preamble = buildProtocolPreamble({
    cwd,
    branch,
    answerTimeoutMs,
    reportSchema,
  });
  return `${preamble}\n\n---\n\n${brief}`;
}
