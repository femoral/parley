import {
  homePathsFromEnv,
  type ChildChannel,
  type JsonSchema,
} from "@useparley/core";
import {
  materializeContext,
  type ContextFile,
} from "@useparley/daemon/context.js";
import { DEFAULT_REPORT_SCHEMA } from "@useparley/daemon/report.js";
import { buildProtocolPreamble as buildDaemonPreamble } from "@useparley/daemon/preamble.js";
import {
  assembleChildPrompt,
  composeOperatorInstructions,
} from "@useparley/daemon/prompt-layers.js";

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

/**
 * Full child prompt for a remote-runner spawn (#159). Project PROMPT.md layers
 * are read from the workspace (`cwd`) at spawn; home layers from the runner
 * host's parley home (`PARLEY_HOME` / `~/.parley`). Operator section order
 * matches the daemon engine.
 */
export function fullPrompt(
  cwd: string,
  branch: string | null,
  answerTimeoutMs: number,
  reportSchema: JsonSchema,
  brief: string,
  childChannel: ChildChannel = "mcp",
  options: {
    vendorId?: string | null;
    profileName?: string | null;
    /** Override home dir (tests); default is the runner host's parley home. */
    homeDir?: string;
  } = {},
): string {
  const preamble = buildProtocolPreamble({
    cwd,
    branch,
    answerTimeoutMs,
    reportSchema,
    childChannel,
  });
  const homeDir = options.homeDir ?? homePathsFromEnv().home;
  const operator = composeOperatorInstructions({
    homeDir,
    projectDir: cwd,
    vendorId: options.vendorId ?? null,
    profileName: options.profileName ?? null,
  });
  return assembleChildPrompt(preamble, operator, brief);
}
