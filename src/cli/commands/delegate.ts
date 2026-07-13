import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "../args.js";
import { DaemonRequestError, daemonPost, ensureDaemon } from "../client.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";
import { parseDuration } from "@useparley/core";
import { waitForOutcome } from "../wait.js";
import { DEFAULT_SANDBOX, SANDBOX_MODES, isSandboxMode } from "../../daemon/adapters/types.js";

interface DelegateAck {
  task_id: string;
  name: string | null;
  state: string;
}

/**
 * `parley delegate [flags] "<prompt>"` — create a task; with `--wait`, block on
 * the task's event stream and return the first outcome: a question (exit 3 with
 * `{task_id, name, question_id, question}`) or a terminal state (report envelope
 * + its typed code). See `waitForOutcome` for the shared blocking contract.
 */
export async function runDelegate(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--vendor": { aliases: ["-v"], value: true },
    "--model": { aliases: ["-m"], value: true },
    "--effort": { value: true },
    "--name": { aliases: ["-n"], value: true },
    "--session": { value: true },
    "--cwd": { value: true },
    "--base-ref": { value: true },
    "--sandbox": { value: true },
    "--no-network": {},
    "--context": { value: true, multi: true },
    "--report-schema": { value: true },
    "--wait": {},
    "--json": {},
    "--answer-timeout": { value: true },
  });

  let prompt = positionals[0];
  if (prompt === "-") prompt = fs.readFileSync(0, "utf8");
  if (prompt === undefined || prompt.trim() === "") {
    throw new UsageError('delegate: a prompt is required (use "-" to read stdin)');
  }
  if (positionals.length > 1) {
    throw new UsageError(`delegate: unexpected argument: ${positionals[1]}`);
  }
  const vendor = flags["--vendor"];
  if (typeof vendor !== "string") {
    throw new UsageError("delegate: a vendor is required (-v/--vendor)");
  }
  // Orchestrator-run identity, so every task this run spawns can be grouped
  // later. `--session` overrides `PARLEY_SESSION_ID`; neither set is a usage
  // error (exit 2) — no silent ungrouped task. Harness-agnostic on purpose: a
  // harness maps its own session concept onto `PARLEY_SESSION_ID` (see skill).
  const sessionFlag = flags["--session"];
  const orchestratorSessionId =
    typeof sessionFlag === "string" ? sessionFlag : ctx.env.PARLEY_SESSION_ID;
  if (typeof orchestratorSessionId !== "string" || orchestratorSessionId === "") {
    throw new UsageError(
      "delegate: an orchestrator session is required (--session or PARLEY_SESSION_ID)",
    );
  }
  // An unanswered question at this timeout stalls the task (spec §2). Omitted
  // means the daemon default (30m).
  let answerTimeoutMs: number | null = null;
  const timeoutFlag = flags["--answer-timeout"];
  if (typeof timeoutFlag === "string") {
    const parsed = parseDuration(timeoutFlag);
    if (parsed === null || parsed <= 0) {
      throw new UsageError(
        `delegate: invalid --answer-timeout: ${timeoutFlag} (expected e.g. 30m, 90s, 250ms)`,
      );
    }
    answerTimeoutMs = parsed;
  }

  // `--cwd` runs the child directly in that directory (no worktree). Its
  // absence is the default path: parley cuts an isolated worktree from the
  // repo the caller is in, which the daemon detects at the invocation cwd.
  const explicitCwd = typeof flags["--cwd"] === "string";
  const cwd = explicitCwd ? (flags["--cwd"] as string) : process.cwd();

  // Sandbox posture (spec §8, ADR-0006): default workspace + network on. An
  // unknown mode is a usage error (exit 2), caught before the daemon is asked.
  const sandbox = typeof flags["--sandbox"] === "string" ? flags["--sandbox"] : DEFAULT_SANDBOX;
  if (!isSandboxMode(sandbox)) {
    throw new UsageError(
      `delegate: unknown sandbox mode: ${sandbox} (expected ${SANDBOX_MODES.join("|")})`,
    );
  }
  const network = flags["--no-network"] !== true;

  // `--report-schema <file>` replaces the default report schema. Read and parse
  // it here so an unreadable / non-JSON file is a caller mistake (exit 2) before
  // the task is created; the daemon rejects a syntactically-valid-JSON file that
  // is not a valid JSON Schema.
  let reportSchema: unknown = null;
  const schemaFile = flags["--report-schema"];
  if (typeof schemaFile === "string") {
    let raw: string;
    try {
      raw = fs.readFileSync(schemaFile, "utf8");
    } catch (err) {
      throw new UsageError(
        `delegate: cannot read report schema ${schemaFile}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    try {
      reportSchema = JSON.parse(raw);
    } catch {
      throw new UsageError(`delegate: report schema ${schemaFile} is not valid JSON`);
    }
  }

  // `--context <file>` (repeatable): the caller's supporting files. Read here so
  // a missing/unreadable file is a caller mistake (exit 2) before any task is
  // created; the daemon materializes them under `.parley/context/` by basename.
  const contextFlag = flags["--context"];
  const contextPaths = Array.isArray(contextFlag)
    ? contextFlag
    : typeof contextFlag === "string"
      ? [contextFlag]
      : [];
  const contexts = contextPaths.map((file) => {
    let contents: string;
    try {
      contents = fs.readFileSync(file, "utf8");
    } catch (err) {
      throw new UsageError(
        `delegate: cannot read context file ${file}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return { name: path.basename(file), contents };
  });
  // Files are materialized under `.parley/context/<basename>`, so two inputs
  // that share a basename would silently clobber. Reject that up front (exit 2)
  // rather than lose one under the child's feet.
  const seen = new Set<string>();
  for (const { name } of contexts) {
    if (seen.has(name)) {
      throw new UsageError(`delegate: duplicate --context basename: ${name}`);
    }
    seen.add(name);
  }

  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  let ack: DelegateAck;
  try {
    ack = await daemonPost<DelegateAck>(discovery, "/tasks", {
      prompt,
      vendor,
      orchestrator_session_id: orchestratorSessionId,
      model: flags["--model"] ?? null,
      effort: flags["--effort"] ?? null,
      name: flags["--name"] ?? null,
      cwd,
      use_worktree: !explicitCwd,
      base_ref: flags["--base-ref"] ?? null,
      sandbox,
      network,
      answer_timeout_ms: answerTimeoutMs,
      report_schema: reportSchema,
      contexts,
    });
  } catch (err) {
    // Daemon-side request rejections (unknown vendor, bad cwd) are usage errors.
    if (err instanceof DaemonRequestError && err.status === 400) {
      throw new UsageError(`delegate: ${err.message}`);
    }
    throw err;
  }

  if (flags["--wait"] !== true) {
    printJson(ctx, ack);
    return 0;
  }

  return waitForOutcome(ctx, discovery, ack.task_id);
}
