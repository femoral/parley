import {
  type ChildChannel,
  type JsonSchema,
} from "@useparley/core";
import {
  materializeContext,
  type ContextFile,
} from "@useparley/daemon/context.js";
import { DEFAULT_REPORT_SCHEMA } from "@useparley/daemon/report.js";
import { buildProtocolPreamble as buildDaemonPreamble } from "@useparley/daemon/preamble.js";

/**
 * Protocol preamble for a remote task (mirrors the daemon engine's preamble so
 * children see the same rules). Built after the worktree exists so location
 * facts are accurate. Channel-matched tools section (#155).
 */
export function buildProtocolPreamble(options: {
  cwd: string;
  branch: string | null;
  answerTimeoutMs: number;
  reportSchema: JsonSchema;
  /** Defaults to `mcp` when the runner has no adapter channel context. */
  childChannel?: ChildChannel;
}): string {
  return buildDaemonPreamble({
    cwd: options.cwd,
    branch: options.branch,
    answerTimeoutMs: options.answerTimeoutMs,
    reportSchema: options.reportSchema ?? DEFAULT_REPORT_SCHEMA,
    childChannel: options.childChannel ?? "mcp",
  });
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
  childChannel: ChildChannel = "mcp",
): string {
  const preamble = buildProtocolPreamble({
    cwd,
    branch,
    answerTimeoutMs,
    reportSchema,
    childChannel,
  });
  return `${preamble}\n\n---\n\n${brief}`;
}
