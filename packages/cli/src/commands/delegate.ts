import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "../args.js";
import { readLiveAncestryChain, resolveWorkspaceRoot } from "../ancestry.js";
import { DaemonRequestError, daemonPost, ensureDaemon } from "../client.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";
import { parseDuration } from "@useparley/core";
import { SANDBOX_MODES, isSandboxMode } from "@useparley/daemon/adapters/types.js";
import { CODE_SESSION_REQUIRED } from "@useparley/daemon/session-binding.js";

interface DelegateAck {
  task_id: string;
  name: string | null;
  state: string;
}

/**
 * `parley delegate [flags] "<prompt>"` — create a task and return immediately
 * with `{task_id, name, state: "pending", seq}` (ADR-0008). Block on outcomes
 * with `parley watch`. Passing the removed `--wait` flag is a usage error.
 */
export async function runDelegate(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--vendor": { aliases: ["-v"], value: true },
    "--profile": { value: true },
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
    // Remote runner affinity (#111 / ADR-0012): task stays pending until the
    // named runner leases it; never locally spawned.
    "--runner": { value: true },
    // Removed (ADR-0008); recognized only so the error points at `parley watch`.
    "--wait": {},
    "--json": {},
    "--answer-timeout": { value: true },
    "--size": { value: true },
    "--difficulty": { value: true },
    "--type": { value: true },
    // #161: run the task but purge the row on terminal (wizard smoke path).
    "--dry-run": {},
  });

  if (flags["--wait"] === true) {
    throw new UsageError(
      "delegate: --wait is removed; use `parley watch` to wait on tasks (ADR-0008)",
    );
  }

  let prompt = positionals[0];
  if (prompt === "-") prompt = fs.readFileSync(0, "utf8");
  if (prompt === undefined || prompt.trim() === "") {
    throw new UsageError('delegate: a prompt is required (use "-" to read stdin)');
  }
  if (positionals.length > 1) {
    throw new UsageError(`delegate: unexpected argument: ${positionals[1]}`);
  }
  // Vendor optional when --profile is given; the daemon resolves vendor from
  // the profile (and applies profile defaults). Explicit flags beat the profile.
  // When both are omitted, the daemon falls back to defaults.profile (wins)
  // or defaults.vendor (#175); missing both flags and defaults is exit 2.
  const vendor = typeof flags["--vendor"] === "string" ? flags["--vendor"] : null;
  const profile = typeof flags["--profile"] === "string" ? flags["--profile"] : null;
  // Orchestrator-run identity (#162): `--session` overrides `PARLEY_SESSION_ID`.
  // When neither is set the daemon binds via process ancestry (or single-live
  // fallback). When evals are on and nothing resolves, the daemon returns
  // `session_required`. Evals off ⇒ session optional.
  const sessionFlag = flags["--session"];
  const orchestratorSessionId =
    typeof sessionFlag === "string" && sessionFlag !== ""
      ? sessionFlag
      : typeof ctx.env.PARLEY_SESSION_ID === "string" && ctx.env.PARLEY_SESSION_ID !== ""
        ? ctx.env.PARLEY_SESSION_ID
        : null;
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

  // Sandbox posture (spec §8, ADR-0006). Only send when the caller set the flag
  // so a profile's sandbox/network can apply; otherwise the daemon uses profile
  // then ADR defaults. An unknown mode is a usage error (exit 2).
  let sandbox: string | undefined;
  if (typeof flags["--sandbox"] === "string") {
    sandbox = flags["--sandbox"];
    if (!isSandboxMode(sandbox)) {
      throw new UsageError(
        `delegate: unknown sandbox mode: ${sandbox} (expected ${SANDBOX_MODES.join("|")})`,
      );
    }
  }
  // Only send network when the caller opted out — omitting it lets a profile
  // set network:false. There is no --network flag to force-on over a profile.
  const networkExplicit = flags["--no-network"] === true ? false : undefined;

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

  // Classification (#118 / #161): optional size/difficulty; project-set
  // validation is daemon-side (hot-read of `.parley/classification.json`).
  // Empty string is a usage error; omitted ⇒ null.
  let size: string | null = null;
  if (typeof flags["--size"] === "string") {
    size = flags["--size"];
    if (size === "") {
      throw new UsageError("delegate: --size requires a non-empty value");
    }
  }
  let difficulty: string | null = null;
  if (typeof flags["--difficulty"] === "string") {
    difficulty = flags["--difficulty"];
    if (difficulty === "") {
      throw new UsageError("delegate: --difficulty requires a non-empty value");
    }
  }
  // Work-domain type (#151): optional; project-set validation is daemon-side
  // (hot-read of `.parley/config.json` taskTypes). Empty string is a usage error;
  // omitted ⇒ daemon stores `other`.
  let type: string | null = null;
  if (typeof flags["--type"] === "string") {
    type = flags["--type"];
    if (type === "") {
      throw new UsageError("delegate: --type requires a non-empty value");
    }
  }
  const dryRun = flags["--dry-run"] === true;

  const ancestryChain = readLiveAncestryChain(ctx.env);
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  let ack: DelegateAck;
  try {
    const body: Record<string, unknown> = {
      prompt,
      ancestry_chain: ancestryChain,
      workspace_root: workspaceRoot,
      model: typeof flags["--model"] === "string" ? flags["--model"] : null,
      effort: typeof flags["--effort"] === "string" ? flags["--effort"] : null,
      name: typeof flags["--name"] === "string" ? flags["--name"] : null,
      cwd,
      use_worktree: !explicitCwd,
      base_ref: typeof flags["--base-ref"] === "string" ? flags["--base-ref"] : null,
      answer_timeout_ms: answerTimeoutMs,
      report_schema: reportSchema,
      contexts,
      size,
      difficulty,
      type,
      dry_run: dryRun,
    };
    if (orchestratorSessionId !== null) {
      body.orchestrator_session_id = orchestratorSessionId;
    }
    if (vendor !== null) body.vendor = vendor;
    if (profile !== null) body.profile = profile;
    if (sandbox !== undefined) body.sandbox = sandbox;
    if (networkExplicit !== undefined) body.network = networkExplicit;
    if (typeof flags["--runner"] === "string") body.runner = flags["--runner"];
    ack = await daemonPost<DelegateAck>(discovery, "/tasks", body);
  } catch (err) {
    // Daemon-side request rejections (unknown vendor, bad cwd, session_required)
    // are usage errors (exit 2). session_required keeps its stable code in the
    // message body for agent branching.
    if (err instanceof DaemonRequestError && err.status === 400) {
      if (err.code === CODE_SESSION_REQUIRED) {
        throw new UsageError(`delegate: ${err.message}`);
      }
      throw new UsageError(`delegate: ${err.message}`);
    }
    throw err;
  }

  printJson(ctx, ack);
  return 0;
}
