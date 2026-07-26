import fs from "node:fs";
import { TASK_HEADER } from "@useparley/core";
import {
  findChildHubOnDisk,
  SharedWorkspaceChildHubError,
} from "@useparley/daemon/run-workspace.js";
import { parseArgs } from "../args.js";
import { type CliContext, printJson } from "../context.js";
import { HelpRequested, UsageError } from "../errors.js";

interface ChildHub {
  url: string;
  taskId: string;
}

/**
 * Resolve hub base URL + task id: env first (`PARLEY_HUB_URL` +
 * `PARLEY_TASK_ID`), else `.parley/child.json` walking up from cwd.
 *
 * A shared run checkout writes no `child.json` (concurrent read-only siblings
 * cannot be disambiguated by walk-up — ADR-0018 / #234). That case fails
 * loudly with {@link SharedWorkspaceChildHubError} rather than guessing.
 */
function resolveChildHub(env: NodeJS.ProcessEnv, cwd: string): ChildHub {
  const envUrl = env.PARLEY_HUB_URL;
  const envTask = env.PARLEY_TASK_ID;
  if (typeof envUrl === "string" && envUrl !== "" && typeof envTask === "string" && envTask !== "") {
    return { url: envUrl.replace(/\/$/, ""), taskId: envTask };
  }

  try {
    const found = findChildHubOnDisk(cwd);
    if (found !== null) return found;
  } catch (err) {
    // Name check (not instanceof) so a second module load of the daemon
    // package still maps the shared-workspace failure to a usage error.
    if (
      err instanceof SharedWorkspaceChildHubError ||
      (err instanceof Error && err.name === "SharedWorkspaceChildHubError")
    ) {
      throw new UsageError(`child: ${err.message}`);
    }
    throw err;
  }

  throw new UsageError(
    "child: cannot find hub — set PARLEY_HUB_URL and PARLEY_TASK_ID, or run inside a task workspace with .parley/child.json",
  );
}

async function childFetch(
  hub: ChildHub,
  pathname: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${hub.url}${pathname}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      [TASK_HEADER]: hub.taskId,
      ...(init?.headers ?? {}),
    },
  });
  const raw = await res.text();
  let body: unknown;
  try {
    body = raw === "" ? undefined : JSON.parse(raw);
  } catch {
    body = { error: raw.slice(0, 200) };
  }
  return { status: res.status, body };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * `parley child report` — submit the final task report via the child REST
 * surface. Exit 0 accepted · 5 rejected · 2 usage.
 */
async function runChildReport(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--summary": { value: true },
    "--outcome": { value: true },
    "--file": { value: true, multi: true },
    "--json-file": { value: true },
  });
  if (positionals.length > 0) {
    throw new UsageError(`child report: unexpected argument: ${positionals[0]}`);
  }

  let report: unknown;
  const jsonFile = flags["--json-file"];
  if (typeof jsonFile === "string") {
    const raw =
      jsonFile === "-"
        ? fs.readFileSync(0, "utf8")
        : fs.readFileSync(jsonFile, "utf8");
    try {
      report = JSON.parse(raw);
    } catch {
      throw new UsageError("child report: --json-file is not valid JSON");
    }
  } else {
    const summary = flags["--summary"];
    const outcome = flags["--outcome"];
    if (typeof summary !== "string" || summary === "") {
      throw new UsageError(
        "child report: --summary is required (or pass --json-file for a custom schema)",
      );
    }
    if (typeof outcome !== "string" || outcome === "") {
      throw new UsageError(
        "child report: --outcome is required (success|partial|blocked)",
      );
    }
    if (outcome !== "success" && outcome !== "partial" && outcome !== "blocked") {
      throw new UsageError(
        `child report: --outcome must be success|partial|blocked, got: ${outcome}`,
      );
    }
    const files = flags["--file"];
    const filesChanged = Array.isArray(files) ? files : typeof files === "string" ? [files] : [];
    report = { summary, outcome, files_changed: filesChanged };
  }

  const hub = resolveChildHub(ctx.env, process.cwd());
  const { status, body } = await childFetch(hub, "/child/report", {
    method: "POST",
    body: JSON.stringify(report),
  });

  if (status === 200) {
    if (isRecord(body) && body.accepted === true) {
      ctx.stdout("report accepted\n");
      return 0;
    }
    // Unexpected 200 shape — still treat as success if the daemon said ok.
    printJson(ctx, body);
    return 0;
  }
  if (status === 400 && isRecord(body) && Array.isArray(body.errors)) {
    ctx.stderr(`report rejected:\n- ${body.errors.map(String).join("\n- ")}\n`);
    return 5;
  }
  const detail =
    isRecord(body) && body.error !== undefined
      ? String(body.error)
      : `daemon returned ${status}`;
  throw new UsageError(`child report: ${detail}`);
}

/**
 * `parley child ask "<question>"` — long-poll until the orchestrator answers.
 * Exit 0 with answer on stdout · 4 on 504 stall · 2 usage.
 */
async function runChildAsk(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals } = parseArgs(args, {});
  let question = positionals[0];
  if (question === "-") question = fs.readFileSync(0, "utf8");
  if (question === undefined || question.trim() === "") {
    throw new UsageError('child ask: a question is required (use "-" to read stdin)');
  }
  if (positionals.length > 1) {
    throw new UsageError(`child ask: unexpected argument: ${positionals[1]}`);
  }

  const hub = resolveChildHub(ctx.env, process.cwd());
  // No client timeout — the daemon long-polls until answer or engine stall.
  const { status, body } = await childFetch(hub, "/child/ask", {
    method: "POST",
    body: JSON.stringify({ question }),
  });

  if (status === 200 && isRecord(body) && typeof body.answer === "string") {
    ctx.stdout(body.answer.endsWith("\n") ? body.answer : `${body.answer}\n`);
    return 0;
  }
  if (status === 504) {
    const note =
      isRecord(body) && body.error !== undefined
        ? String(body.error)
        : "answer timeout — the task is stalled";
    ctx.stderr(`child ask: ${note}\n`);
    return 4;
  }
  const detail =
    isRecord(body) && body.error !== undefined
      ? String(body.error)
      : `daemon returned ${status}`;
  throw new UsageError(`child ask: ${detail}`);
}

/**
 * `parley child task` — print the child's own task envelope as JSON.
 */
async function runChildTask(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals } = parseArgs(args, {});
  if (positionals.length > 0) {
    throw new UsageError(`child task: unexpected argument: ${positionals[0]}`);
  }

  const hub = resolveChildHub(ctx.env, process.cwd());
  const { status, body } = await childFetch(hub, "/child/task", { method: "GET" });
  if (status !== 200) {
    const detail =
      isRecord(body) && body.error !== undefined
        ? String(body.error)
        : `daemon returned ${status}`;
    throw new UsageError(`child task: ${detail}`);
  }
  printJson(ctx, body);
  return 0;
}

/**
 * `parley child <report|ask|task>` — child-side namespace wrapping the REST
 * surface (ADR-0011 / #110). Does not auto-spawn the daemon: hub + task id
 * come from env or `.parley/child.json` written by the engine at spawn.
 */
export async function runChild(ctx: CliContext, args: string[]): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case "report":
      return runChildReport(ctx, args.slice(1));
    case "ask":
      return runChildAsk(ctx, args.slice(1));
    case "task":
      return runChildTask(ctx, args.slice(1));
    case "-h":
    case "--help":
      throw new HelpRequested(sub);
    default:
      throw new UsageError(
        sub === undefined
          ? "usage: parley child report|ask|task"
          : `child: unknown subcommand: ${sub}`,
      );
  }
}
