/**
 * Protocol preamble for vendor children (spec §7, #155).
 *
 * Channel-independent sections (location, on-disk pointers, report-schema
 * summary) are shared; the tools section teaches exactly one child channel
 * (`mcp` | `cli` | `http`). Resume and fresh-fix contexts re-prepend the same
 * channel-matched preamble — call {@link buildProtocolPreamble} rather than
 * re-implementing it.
 */
import {
  formatDuration,
  type ChildChannel,
  type JsonSchema,
} from "@useparley/core";
import { contextPointers } from "./context.js";
import { DEFAULT_REPORT_SCHEMA, summarizeReportSchema } from "./report.js";

/** Inputs needed to render a full protocol preamble. */
export interface PreambleOptions {
  cwd: string;
  branch: string | null;
  answerTimeoutMs: number;
  reportSchema: JsonSchema;
  /**
   * Channel to teach in the tools section. Resolved by the engine as
   * `vendors.<id>.childChannel` override, else the adapter's declared channel.
   */
  childChannel: ChildChannel;
}

/**
 * Tools-section lines for one child channel. Exported so unit tests can pin
 * each variant without re-assembling the full preamble.
 */
export function toolsSectionLines(channel: ChildChannel, timeout: string): string[] {
  switch (channel) {
    case "mcp":
      return [
        "## Tools available to you",
        `- \`ask_orchestrator({ question })\` — ask the orchestrator a blocking question when you are genuinely stuck or need a decision only they can make. It blocks until an answer arrives; a question left unanswered for ${timeout} stalls the task (it can be resumed later). Do not use it for anything you can resolve yourself.`,
        "- `submit_report({ ... })` — you MUST finish by calling this exactly once. The task only completes when you submit a report that satisfies the schema below; exiting without one is a failure.",
      ];
    case "cli":
      return [
        "## Tools available to you",
        "You reach the orchestrator via the `parley child` CLI (hub URL and task id come from `PARLEY_HUB_URL`/`PARLEY_TASK_ID`, or `.parley/child.json` found upward from cwd). Other transports may work but are not taught here.",
        `- \`parley child ask "<question>"\` — ask the orchestrator a blocking question when you are genuinely stuck or need a decision only they can make. It blocks until an answer arrives; a question left unanswered for ${timeout} stalls the task (it can be resumed later). Do not use it for anything you can resolve yourself.`,
        "- `parley child report --summary \"<text>\" --outcome <success|partial|blocked> [--file <path>...]` — you MUST finish by running this exactly once (or `parley child report --json-file <path>` for a custom schema body). The task only completes when you submit a report that satisfies the schema below; exiting without one is a failure.",
        "- `parley child task` — print your own task envelope for self-inspection.",
      ];
    case "http":
      return [
        "## Tools available to you",
        "You reach the orchestrator via HTTP on `$PARLEY_HUB_URL` with the `x-parley-task: $PARLEY_TASK_ID` header (also available in `.parley/child.json`). Other transports may work but are not taught here.",
        `- \`POST /child/ask\` with body \`{"question":"..."}\` — ask the orchestrator a blocking question when you are genuinely stuck or need a decision only they can make. Long-polls until an answer arrives; a question left unanswered for ${timeout} stalls the task (HTTP 504; it can be resumed later). Do not use it for anything you can resolve yourself. Example:`,
        "  ```",
        '  curl -sS -X POST "$PARLEY_HUB_URL/child/ask" \\',
        '    -H "content-type: application/json" \\',
        '    -H "x-parley-task: $PARLEY_TASK_ID" \\',
        `    -d '{"question":"..."}'`,
        "  ```",
        "- `POST /child/report` with the report object as the JSON body — you MUST finish by posting this exactly once. The task only completes when you submit a report that satisfies the schema below; exiting without one is a failure. Example:",
        "  ```",
        '  curl -sS -X POST "$PARLEY_HUB_URL/child/report" \\',
        '    -H "content-type: application/json" \\',
        '    -H "x-parley-task: $PARLEY_TASK_ID" \\',
        `    -d '{"summary":"...","outcome":"success","files_changed":[]}'`,
        "  ```",
        "- `GET /child/task` — your own task envelope for self-inspection.",
      ];
  }
}

/**
 * Closing instruction for a resume (or similar) continuation, matched to the
 * channel the child was taught.
 */
export function finishInstruction(channel: ChildChannel): string {
  switch (channel) {
    case "mcp":
      return "Continue the task from here and finish by calling `submit_report`.";
    case "cli":
      return "Continue the task from here and finish with `parley child report`.";
    case "http":
      return "Continue the task from here and finish by `POST`ing to `/child/report`.";
  }
}

/**
 * The protocol preamble prepended to every vendor prompt (spec §7). Mechanics
 * only — no repo digest or history. Re-prepended on resume and fresh-fix so a
 * respawned child is re-taught the rules. Context pointers are read from disk
 * at build time, so they reflect what was actually materialized.
 */
export function buildProtocolPreamble(options: PreambleOptions): string {
  const schema = options.reportSchema ?? DEFAULT_REPORT_SCHEMA;
  const timeout = formatDuration(options.answerTimeoutMs);
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
    ...toolsSectionLines(options.childChannel, timeout),
    "",
    "## Report schema",
    summarizeReportSchema(schema),
    "",
    "The task itself follows below (and in `.parley/TASK.md`); everything above is protocol, not the task.",
  ].join("\n");
}
