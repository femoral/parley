import { homePathsFromEnv } from "@useparley/core";
import { type CliContext } from "./context.js";
import { HelpRequested, UsageError } from "./errors.js";
import { runAnswer } from "./commands/answer.js";
import { runCancel } from "./commands/cancel.js";
import { runChild } from "./commands/child.js";
import { runClean } from "./commands/clean.js";
import { runConfig } from "./commands/config.js";
import { runDaemon } from "./commands/daemon.js";
import { runDelegate } from "./commands/delegate.js";
import { runEval } from "./commands/eval.js";
import { runGc } from "./commands/gc.js";
import { runFix } from "./commands/fix.js";
import { runLogs } from "./commands/logs.js";
import { runMetrics } from "./commands/metrics.js";
import { runModels } from "./commands/models.js";
import { runSkills } from "./commands/skills/index.js";
import { runStatus } from "./commands/tasks.js";
import { runUi } from "./commands/ui.js";
import { runWatch } from "./commands/watch.js";
import { runPrompt } from "./commands/prompt.js";
import { runLint } from "./commands/lint.js";
import { VERSION_LINE } from "./version.js";

const HELP = `parley — delegate tasks to agent CLIs

Usage:
  parley delegate [flags] "<prompt>"  Delegate a task ('-' reads stdin);
                                returns immediately with pending-task JSON
    -v --vendor <id>   Vendor adapter (required)
    -m --model <id>    Model, passed through to the vendor
    --effort <level>   Reasoning effort, passed through to the vendor
    -n --name <label>  Human label; usable wherever a task id is
    --cwd <path>       Run in this dir directly (skips worktree creation)
    --base-ref <ref>   Branch the worktree from <ref> (default: HEAD)
    --context <file>   Copy a file into .parley/context/ (repeatable)
    --report-schema <file>  Validate the child's report against this JSON Schema
    --answer-timeout <dur>  Stall the task when a question goes unanswered
                            this long (default 30m; e.g. 90s, 250ms)
    --size <id>             Task size classification (optional; for metrics;
                            project-configurable via classification.json)
    --difficulty <id>       Task difficulty (optional; project-configurable)
    --type <t>              Work-domain type (coding|design|…|other; optional,
                            default other; project-configurable via taskTypes)
    --dry-run               Run the task but record nothing (no task row left)
  parley fix [--fresh] <task> "<brief>"
                            Create a linked reattempt that inherits the
                            parent's profile/workspace and resumes its
                            vendor session when resume.enabled (default on).
                            --fresh: blank session, uncapped by retry limits,
                            with daemon-composed context (original brief +
                            attempt history + fix request). Returns immediately;
                            wait with parley watch.
  parley answer <task> "<text>" Answer a child's question ('-' reads stdin);
                                on a stalled task, resume it with the text.
                                Returns immediately; wait with parley watch.
  parley eval <task> --answers '<json>' --feedback "<text>"
                            Record a structured rubric evaluation (boolean
                            answers per criterion); daemon computes score +
                            baseline. A later call overwrites the last.
  parley cancel <task>          Terminate a task's child; end it cancelled
  parley watch [task…] [--ack <event-id>] [--session <id>|latest]
              [--follow] [--json]
                            The only wait primitive (ADR-0008). Deliver the
                            next pending attention-inbox event
                            (awaiting_answer / stalled / failed / completed)
                            for the orchestrator session (--session, else
                            PARLEY_SESSION_ID, else latest). Level-triggered:
                            an already-pending event returns immediately.
                            --ack records handling of a prior event id (seq),
                            then returns the next. Positional task refs filter
                            the session inbox. --follow streams every transition
                            as JSONL (no ack). Exit: 0 all-done · 3
                            awaiting_answer · 4 stalled · 5 failed · 6 completed.
  parley [list]                 Show the task table (alias for bare status)
  parley status [task] [--json] [--session <id>|latest] [--all]
                            Show tasks, or one (id or name). Bare status
                            narrows to your orchestrator session (--session,
                            else PARLEY_SESSION_ID, else the newest session);
                            --all shows every task.
  parley metrics [--session <id>|latest|all] [--group-by vendor|model|profile|size|difficulty|type]
              [--json]      Aggregate task metrics (counts, evals, tokens,
                            duration) by group. Defaults: session=all,
                            group-by=vendor.
  parley logs <task> [--follow] [--json]
                            Print the captured vendor stream, coalescing
                            token-streamed chunks into readable lines
                            (--json: raw per-event JSONL, untouched)
  parley clean <task>           Remove a finished task's worktree (keeps branch)
  parley clean --all-terminal   Sweep worktrees of all terminal-state tasks
  parley gc [--dry-run]         Purge expired terminal tasks (rows, logs,
                            worktrees; never branches). --dry-run lists only.
  parley models [--vendor <id>] [--json] [--refresh]
                            Show the model/effort catalog (~/.parley/models.json,
                            hand-editable). --refresh re-probes vendor CLIs;
                            advisory only — delegate never gates on it.
  parley daemon start           Start the background daemon (--replace takes over a running one)
  parley daemon stop            Stop the background daemon
  parley daemon status          Report daemon identity (pid, port, id, home, version, provenance)
  parley daemon <cmd> [--json]
  parley config show            Show the daemon's effective config (via endpoints)
  parley config get <key>       Read a dotted key (e.g. daemon.url, profiles.fast.vendor)
  parley config set <key> <val> Set a dotted key (JSON when parseable; else string)
  parley config unset <key>     Remove a dotted key
  parley config push <file>     Validate then replace the daemon config wholesale
  parley config pull [file]     Write the current daemon config to a file (or stdout)
  parley ui [--no-open]        Print the cockpit URL and open it in a browser
  parley prompt [--vendor <id>] [--profile <name>] [--orchestrator]
                            Preview the composed prompt a child would get from
                            this cwd (protocol preamble + PROMPT.md layers).
                            --orchestrator shows compounded orchestrator
                            PROMPT.md instead (never injected into children).
  parley lint [dir]             Validate project .parley surfaces (config,
                            classification, rubrics). Exit 1 on error (CI).
  parley skills install         Install bundled orchestrator skill(s)
    --layout claude|agents|<path>
                              Vendor convention, or a custom directory path
                              (required non-interactive / CI)
    --scope global|project    Where to install for a known layout
                              (required non-interactive with --layout)
    --skill <name>            Skill to install (repeatable; default: all)
    --yes                     Accept defaults; skip confirm prompts
  parley skills list            List bundled skills (name + description)
  parley child report --summary <text> --outcome <success|partial|blocked>
              [--file <path>…]  Submit the final report (default schema)
  parley child report --json-file <path>|-
                            Submit an arbitrary JSON report (custom schemas)
  parley child ask "<question>" Ask the orchestrator (blocks; '-' = stdin)
  parley child task             Print this task's envelope as JSON
                            Child commands resolve hub + task id from
                            PARLEY_HUB_URL + PARLEY_TASK_ID, else
                            .parley/child.json walking up from cwd.

Global flags:
  --json    Emit machine-readable JSON
  -h,--help Show this help
  -V,--version Show the version

Exit codes: delegate/answer 0 accepted · 2 usage. fix: 0 accepted · 2 usage ·
7 retry_limit_exceeded · 8 reattempt_window_expired. watch: 0 all-done · 2 usage ·
3 awaiting_answer · 4 stalled · 5 failed · 6 completed. child report: 0
accepted · 5 rejected · 2 usage. child ask: 0 answered · 4 stalled · 2 usage.
`;

/**
 * Parse and dispatch a parley command line. Returns the process exit code.
 * Throws `UsageError` for bad invocations (mapped to exit 2 by the caller).
 */
export async function run(argv: string[], ctx: CliContext): Promise<number> {
  const first = argv[0];
  if (first === "--version" || first === "-V") {
    ctx.stdout(`${VERSION_LINE}\n`);
    return 0;
  }

  // A leading flag means the implicit `list` command (`parley --json`); each
  // command's own parser handles -h/--help (raising HelpRequested) so flag
  // *values* that merely look like --help are never hijacked.
  const bareFlags = first !== undefined && first.startsWith("-") && first !== "-";
  const command = bareFlags || first === undefined ? "list" : first;
  const rest = bareFlags ? argv : argv.slice(1);

  switch (command) {
    case "delegate":
      return runDelegate(ctx, rest);
    case "fix":
      return runFix(ctx, rest);
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
    case "metrics":
      return runMetrics(ctx, rest);
    case "logs":
      return runLogs(ctx, rest);
    case "clean":
      return runClean(ctx, rest);
    case "gc":
      return runGc(ctx, rest);
    case "models":
      return runModels(ctx, rest);
    case "daemon":
      return runDaemon(ctx, rest);
    case "config":
      return runConfig(ctx, rest);
    case "ui":
      return runUi(ctx, rest);
    case "prompt":
      return runPrompt(ctx, rest);
    case "lint":
      return runLint(ctx, rest);
    case "skills":
      return runSkills(ctx, rest);
    case "child":
      return runChild(ctx, rest);
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
