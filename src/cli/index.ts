import { homePathsFromEnv } from "../home.js";
import { type CliContext } from "./context.js";
import { HelpRequested, UsageError } from "./errors.js";
import { runAnswer } from "./commands/answer.js";
import { runCancel } from "./commands/cancel.js";
import { runClean } from "./commands/clean.js";
import { runDaemon } from "./commands/daemon.js";
import { runDelegate } from "./commands/delegate.js";
import { runEval } from "./commands/eval.js";
import { runLogs } from "./commands/logs.js";
import { runModels } from "./commands/models.js";
import { runSkills } from "./commands/skills.js";
import { runStatus } from "./commands/tasks.js";
import { runWatch } from "./commands/watch.js";

const HELP = `parley — delegate tasks to agent CLIs

Usage:
  parley delegate [flags] "<prompt>"  Delegate a task ('-' reads stdin)
    -v --vendor <id>   Vendor adapter (required)
    -m --model <id>    Model, passed through to the vendor
    --effort <level>   Reasoning effort, passed through to the vendor
    -n --name <label>  Human label; usable wherever a task id is
    --cwd <path>       Run in this dir directly (skips worktree creation)
    --base-ref <ref>   Branch the worktree from <ref> (default: HEAD)
    --context <file>   Copy a file into .parley/context/ (repeatable)
    --report-schema <file>  Validate the child's report against this JSON Schema
    --wait             Block until terminal state; print report envelope
    --answer-timeout <dur>  Stall the task when a question goes unanswered
                            this long (default 30m; e.g. 90s, 250ms)
  parley answer <task> "<text>" Answer a child's question ('-' reads stdin);
                                on a stalled task, resume it with the text
    --wait             Re-block after delivering; return on next question/terminal
  parley eval <task> --score <1-10> --feedback "<text>"
                            Record an orchestrator's quality score/feedback
                            against a task; a later call overwrites the last
  parley cancel <task>          Terminate a task's child; end it cancelled
  parley watch [task…] [--since <seq>] [--until any-change|attention|terminal]
              [--follow] [--json]
                            Block until the watched task set changes state.
                            No task args watches every non-terminal task at
                            start. --since replays a transition that already
                            happened after <seq>. --until any-change (default)
                            returns on the first transition; attention on
                            awaiting_answer/stalled; terminal once all are
                            terminal. --follow streams every transition as JSONL.
                            Exit: 0 returned · 3 awaiting_answer · 4 stalled.
  parley [list]                 Show the task table (alias for bare status)
  parley status [task] [--json] Show all tasks, or one (id or name)
  parley logs <task> [--follow] [--json]
                            Print the captured vendor stream, coalescing
                            token-streamed chunks into readable lines
                            (--json: raw per-event JSONL, untouched)
  parley clean <task>           Remove a finished task's worktree (keeps branch)
  parley clean --all-terminal   Sweep worktrees of all terminal-state tasks
  parley models [--vendor <id>] [--json] [--refresh]
                            Show the model/effort catalog (~/.parley/models.json,
                            hand-editable). --refresh re-probes vendor CLIs;
                            advisory only — delegate never gates on it.
  parley daemon start           Start the background daemon
  parley daemon stop            Stop the background daemon
  parley daemon status          Report daemon port/pid
  parley daemon <cmd> [--json]
  parley skills install         Install the orchestrator skill into a skill dir
    --scope global|project    Where to install (skips the prompt)
    --layout claude|agents|<path>
                              Vendor convention, or a custom directory path
  parley skills list            List the skills parley bundles

Global flags:
  --json    Emit machine-readable JSON
  -h,--help Show this help

Exit codes (delegate --wait): 0 completed · 1 failed · 2 usage · 3 question ·
4 stalled · 5 cancelled.
`;

/**
 * Parse and dispatch a parley command line. Returns the process exit code.
 * Throws `UsageError` for bad invocations (mapped to exit 2 by the caller).
 */
export async function run(argv: string[], ctx: CliContext): Promise<number> {
  const first = argv[0];
  // A leading flag means the implicit `list` command (`parley --json`); each
  // command's own parser handles -h/--help (raising HelpRequested) so flag
  // *values* that merely look like --help are never hijacked.
  const bareFlags = first !== undefined && first.startsWith("-") && first !== "-";
  const command = bareFlags || first === undefined ? "list" : first;
  const rest = bareFlags ? argv : argv.slice(1);

  switch (command) {
    case "delegate":
      return runDelegate(ctx, rest);
    case "answer":
      return runAnswer(ctx, rest);
    case "eval":
      return runEval(ctx, rest);
    case "cancel":
      return runCancel(ctx, rest);
    case "watch":
      return runWatch(ctx, rest);
    case "list":
    case "status":
      return runStatus(ctx, rest);
    case "logs":
      return runLogs(ctx, rest);
    case "clean":
      return runClean(ctx, rest);
    case "models":
      return runModels(ctx, rest);
    case "daemon":
      return runDaemon(ctx, rest);
    case "skills":
      return runSkills(ctx, rest);
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

/**
 * A downstream reader that closes early (`parley status | head`) makes writes
 * to that stream fail with EPIPE. Node's stdout/stderr are Writable streams,
 * so a failed write emits an async 'error' event — outside any try/catch
 * around `run()`. Left unhandled, Node's default behavior is to throw and
 * print a full internal stack trace. Standard CLI behavior is to exit
 * quietly (code 0) instead; swallow only EPIPE here so genuine stream errors
 * still surface.
 */
function ignoreEpipe(stream: NodeJS.WriteStream): void {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") {
      process.exitCode = 0;
      return;
    }
    throw err;
  });
}

async function main(): Promise<void> {
  ignoreEpipe(process.stdout);
  ignoreEpipe(process.stderr);

  const ctx: CliContext = {
    paths: homePathsFromEnv(),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };

  try {
    const code = await run(process.argv.slice(2), ctx);
    process.exitCode = code;
  } catch (err) {
    if (err instanceof HelpRequested) {
      ctx.stdout(HELP);
      process.exitCode = 0;
      return;
    }
    if (err instanceof UsageError) {
      ctx.stderr(`error: ${err.message}\n`);
      process.exitCode = 2;
      return;
    }
    ctx.stderr(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

void main();
