import { parseArgs } from "../args.js";
import { readLiveAncestryChain, resolveWorkspaceRoot } from "../ancestry.js";
import { DaemonRequestError, daemonPost, ensureDaemon } from "../client.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";
import { CODE_SESSION_REQUIRED } from "@useparley/daemon/session-binding.js";
import { resolveExplicitSessionId } from "../session-state-match.js";

interface EvalAck {
  task_id: string;
  name: string | null;
  state: string;
  eval_score?: number | null;
  eval_baseline?: number | null;
  eval_rubric?: string | null;
  eval_rubric_version?: number | null;
  /** Multi-live most-recent fallback (#280); printed on stderr, not stdout JSON. */
  warning?: string;
}

/**
 * `parley eval <task> --answers '<json>' --feedback "<text>"` — record a
 * structured rubric evaluation (#157). The daemon resolves type → rubric,
 * validates answers, and computes score + baseline. `--score` is hard-removed
 * and errors with a teaching message; historical scores remain stored.
 */
export async function runEval(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--answers": { value: true },
    "--score": { value: true },
    "--feedback": { value: true },
    "--session": { value: true },
    "--json": {},
  });

  const ref = positionals[0];
  if (ref === undefined) {
    throw new UsageError("eval: a task (id or name) is required");
  }
  if (positionals.length > 1) {
    throw new UsageError(`eval: unexpected argument: ${positionals[1]}`);
  }

  if (flags["--score"] !== undefined) {
    throw new UsageError(
      "eval: --score is no longer accepted; use --answers '<json>' with boolean answers for each rubric criterion so the daemon can compute the score",
    );
  }

  const answersFlag = flags["--answers"];
  if (typeof answersFlag !== "string") {
    throw new UsageError(
      "eval: answers are required (--answers '<json>' mapping criterion ids to booleans)",
    );
  }
  let answers: Record<string, boolean>;
  try {
    const parsed: unknown = JSON.parse(answersFlag);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new UsageError(
        "eval: --answers must be a JSON object mapping criterion ids to booleans",
      );
    }
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "boolean") {
        throw new UsageError(
          `eval: --answers.${id} must be a boolean, got: ${typeof value}`,
        );
      }
    }
    answers = parsed as Record<string, boolean>;
  } catch (err) {
    if (err instanceof UsageError) throw err;
    throw new UsageError(
      `eval: --answers must be valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const feedback = flags["--feedback"];
  if (typeof feedback !== "string" || feedback === "") {
    throw new UsageError('eval: feedback is required (--feedback "<text>")');
  }

  // Judge binding (#162 / #190 / #196): independent of the task's spawn-time session.
  // PARLEY_SESSION_ID > --session > state-file > ancestry.
  const sessionFlag = flags["--session"];
  const flagSessionId =
    typeof sessionFlag === "string" && sessionFlag !== "" ? sessionFlag : null;
  const ancestryChain = readLiveAncestryChain(ctx.env);
  const orchestratorSessionId = resolveExplicitSessionId({
    env: ctx.env,
    flagSessionId,
    parleyHome: ctx.paths.home,
    ancestryChain,
    note: (msg) => ctx.stderr(`note: ${msg}\n`),
  });
  const workspaceRoot = resolveWorkspaceRoot(process.cwd());

  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  let ack: EvalAck;
  try {
    const body: Record<string, unknown> = {
      answers,
      feedback,
      ancestry_chain: ancestryChain,
      workspace_root: workspaceRoot,
    };
    if (orchestratorSessionId !== null) {
      body.orchestrator_session_id = orchestratorSessionId;
    }
    ack = await daemonPost<EvalAck>(
      discovery,
      `/tasks/${encodeURIComponent(ref)}/eval`,
      body,
    );
  } catch (err) {
    // No such task / bad answers / session_required are caller mistakes (exit 2).
    if (err instanceof DaemonRequestError && (err.status === 400 || err.status === 404)) {
      if (err.code === CODE_SESSION_REQUIRED) {
        throw new UsageError(`eval: ${err.message}`);
      }
      throw new UsageError(`eval: ${err.message}`);
    }
    throw err;
  }

  // Binding fallback warning (#280): stderr only — leave success stdout shape intact.
  if (typeof ack.warning === "string" && ack.warning !== "") {
    ctx.stderr(`warning: ${ack.warning}\n`);
  }
  const { warning: _warning, ...stdoutAck } = ack;
  printJson(ctx, stdoutAck);
  return 0;
}
