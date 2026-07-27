/**
 * `parley run <verb> …` — gate verbs (#238) + re-entry (#242) + query surface
 * (ADR-0021 / #241) + whole-run eval / run metrics (#243 / ADR-0020).
 *
 * Gate verbs (blocked run): approve | reject | redirect | finish
 * Re-entry verbs:
 *   cancel <run>               abandon a live run (makes fork legal)
 *   fork <run> [--to] [--note] new run from a terminal parent
 * Query verbs:
 *   status                     every run
 *   status <run>               one run's node table
 *   status <run> --node <node> one node's tasks
 *   get <id|address>           one deliverable (or collected fan-out)
 * Eval / metrics (#243):
 *   eval <run>                 structured whole-run rubric score
 *   metrics                    run metrics (separate from `parley metrics`)
 *
 * Joins the existing `parley run` namespace — not a new `parley workflow`.
 */
import type {
  DeliverableValue,
  NodeDetailResponse,
  RunDetailResponse,
  RunMetricsGroup,
  RunMetricsResponse,
  RunsResponse,
} from "@useparley/core";
import {
  isRunMetricsGroupBy,
  RUN_METRICS_GROUP_BY,
  runFiltersToSearchParams,
  type RunMetricsFilters,
} from "@useparley/core";
import { CODE_SESSION_REQUIRED } from "@useparley/daemon/session-binding.js";
import {
  EXIT_DELIVERABLE_PURGED,
  formatRunListState,
  renderDeliverableBare,
  renderNodeDetail,
  renderRunList,
  renderRunSummary,
} from "@useparley/daemon/run-query.js";
import { parseArgs } from "../args.js";
import { readLiveAncestryChain, resolveWorkspaceRoot } from "../ancestry.js";
import { DaemonRequestError, daemonGet, daemonPost, ensureDaemon } from "../client.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";
import { resolveExplicitSessionId } from "../session-state-match.js";

/**
 * `parley run get` exit when the address resolves but retention purged the
 * value. Re-export for CLI callers/tests; defined next to the render contract.
 * @see EXIT_DELIVERABLE_PURGED in `@useparley/daemon/run-query`
 */
export { EXIT_DELIVERABLE_PURGED };

const GATE_VERBS = ["approve", "reject", "redirect", "finish"] as const;
type GateVerb = (typeof GATE_VERBS)[number];

/** Live redirect stays a gate verb; fork/cancel are re-entry (ADR-0017). */
const REENTRY_VERBS = ["fork", "cancel"] as const;
type ReentryVerb = (typeof REENTRY_VERBS)[number];

const QUERY_VERBS = ["status", "get"] as const;
type QueryVerb = (typeof QUERY_VERBS)[number];

/** #243 whole-run eval + run metrics (separate from task `parley metrics`). */
const EVAL_METRICS_VERBS = ["eval", "metrics"] as const;
type EvalMetricsVerb = (typeof EVAL_METRICS_VERBS)[number];

function isGateVerb(value: string): value is GateVerb {
  return (GATE_VERBS as readonly string[]).includes(value);
}

function isReentryVerb(value: string): value is ReentryVerb {
  return (REENTRY_VERBS as readonly string[]).includes(value);
}

function isQueryVerb(value: string): value is QueryVerb {
  return (QUERY_VERBS as readonly string[]).includes(value);
}

function isEvalMetricsVerb(value: string): value is EvalMetricsVerb {
  return (EVAL_METRICS_VERBS as readonly string[]).includes(value);
}

const VERB_HELP =
  "status | get | eval | metrics | approve | reject | redirect | finish | fork | cancel";

interface RunVerbAck {
  run_id: string;
  state: string;
  current_node: string | null;
  iteration: number;
  decision: unknown;
  error: string | null;
  parent_run_id?: string | null;
  attempt?: number;
}

/**
 * `parley run approve|reject|redirect|finish|fork|cancel|status|get|eval|metrics …`
 */
export async function runRun(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--json": {},
    "--to": { value: true },
    "--note": { value: true },
    "--node": { value: true },
    "--iteration": { value: true },
    "--slot": { value: true },
    "--session": { value: true },
    "--all": {},
    "--workflow": { value: true },
    "--state": { value: true },
    "--blocked": {},
    "--run": { value: true },
    "--failed": {},
    // #243 run eval
    "--answers": { value: true },
    "--score": { value: true },
    "--feedback": { value: true },
    "--type": { value: true },
    // #243 run metrics
    "--group-by": { value: true },
    "--size": { value: true },
    "--difficulty": { value: true },
    "--orch-harness": { value: true },
    "--orch-model": { value: true },
    "--orch-effort": { value: true },
    "--eval-harness": { value: true },
    "--eval-model": { value: true },
    "--eval-effort": { value: true },
    "--rubric": { value: true },
    "--rubric-version": { value: true },
    "--workflow-version": { value: true },
    "--first-run": {},
    "--below-baseline": {},
  });

  const verbRaw = positionals[0];
  if (verbRaw === undefined) {
    throw new UsageError(`run: a verb is required (${VERB_HELP})`);
  }

  if (isQueryVerb(verbRaw)) {
    if (verbRaw === "status") {
      return runStatus(ctx, positionals.slice(1), flags);
    }
    return runGet(ctx, positionals.slice(1), flags);
  }

  // #243 — eval / metrics resolve before the gate + re-entry verbs (#238/#242).
  if (isEvalMetricsVerb(verbRaw)) {
    if (verbRaw === "eval") {
      return runEvalRun(ctx, positionals.slice(1), flags);
    }
    return runRunMetrics(ctx, positionals.slice(1), flags);
  }

  if (!isGateVerb(verbRaw) && !isReentryVerb(verbRaw)) {
    throw new UsageError(`run: unknown verb "${verbRaw}" (expected ${VERB_HELP})`);
  }
  const verb = verbRaw as GateVerb | ReentryVerb;

  const runId = positionals[1];
  if (runId === undefined) {
    throw new UsageError(`run ${verb}: a run id is required`);
  }
  if (positionals.length > 2) {
    throw new UsageError(`run ${verb}: unexpected argument: ${positionals[2]}`);
  }

  const to = typeof flags["--to"] === "string" ? flags["--to"] : null;
  const note = typeof flags["--note"] === "string" ? flags["--note"] : null;

  if (verb === "redirect" && (to === null || to === "")) {
    throw new UsageError("run redirect: --to <node> is required");
  }
  // fork accepts optional --to (defaults to definition reentry); cancel never.
  if (verb !== "redirect" && verb !== "fork" && to !== null) {
    throw new UsageError(`run ${verb}: --to is only valid with redirect or fork`);
  }
  if (verb === "cancel" && note !== null) {
    throw new UsageError("run cancel: --note is not valid");
  }
  if (verb !== "redirect" && verb !== "fork" && note !== null) {
    throw new UsageError(`run ${verb}: --note is only valid with redirect or fork`);
  }

  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  let ack: RunVerbAck;
  try {
    const body =
      verb === "cancel"
        ? {}
        : {
            to,
            note,
          };
    ack = await daemonPost<RunVerbAck>(
      discovery,
      `/runs/${encodeURIComponent(runId)}/${verb}`,
      body,
    );
  } catch (err) {
    if (err instanceof DaemonRequestError && (err.status === 400 || err.status === 404)) {
      throw new UsageError(`run ${verb}: ${err.message}`);
    }
    throw err;
  }

  if (flags["--json"] === true) {
    printJson(ctx, ack);
  } else if (verb === "fork") {
    const node = ack.current_node ?? "—";
    const parent = ack.parent_run_id ?? runId;
    const attempt = ack.attempt ?? "?";
    ctx.stdout(
      `Run ${ack.run_id} forked from ${parent} (attempt ${attempt}) → ${ack.state}  node=${node}  iteration=${ack.iteration}\n`,
    );
  } else {
    const node = ack.current_node ?? "—";
    ctx.stdout(
      `Run ${ack.run_id} ${verb} → ${ack.state}  node=${node}  iteration=${ack.iteration}\n`,
    );
  }
  return 0;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function runStatus(
  ctx: CliContext,
  positionals: string[],
  flags: Record<string, string | boolean | string[]>,
): Promise<number> {
  const runRef = positionals[0];
  const node =
    typeof flags["--node"] === "string" ? flags["--node"] : null;
  const iterationRaw =
    typeof flags["--iteration"] === "string" ? flags["--iteration"] : null;
  const slot = typeof flags["--slot"] === "string" ? flags["--slot"] : null;
  const asJson = flags["--json"] === true;

  if (node !== null && runRef === undefined) {
    throw new UsageError("run status: --node requires a run id");
  }
  if (positionals.length > 1) {
    throw new UsageError(`run status: unexpected argument: ${positionals[1]}`);
  }

  const discovery = await ensureDaemon(ctx.paths, ctx.env);

  // Node detail zoom
  if (runRef !== undefined && node !== null) {
    const qs = new URLSearchParams();
    if (iterationRaw) qs.set("iteration", iterationRaw);
    if (slot) qs.set("slot", slot);
    const q = qs.toString() ? `?${qs.toString()}` : "";
    let detail: NodeDetailResponse;
    try {
      detail = await daemonGet<NodeDetailResponse>(
        discovery,
        `/runs/${encodeURIComponent(runRef)}/nodes/${encodeURIComponent(node)}${q}`,
      );
    } catch (err) {
      if (err instanceof DaemonRequestError && (err.status === 400 || err.status === 404)) {
        throw new UsageError(`run status: ${err.message}`);
      }
      throw err;
    }
    if (asJson) {
      printJson(ctx, detail);
    } else {
      ctx.stdout(renderNodeDetail(detail));
    }
    return 0;
  }

  // Run summary
  if (runRef !== undefined) {
    let detail: RunDetailResponse;
    try {
      detail = await daemonGet<RunDetailResponse>(
        discovery,
        `/runs/${encodeURIComponent(runRef)}`,
      );
    } catch (err) {
      if (err instanceof DaemonRequestError && (err.status === 400 || err.status === 404)) {
        throw new UsageError(`run status: ${err.message}`);
      }
      throw err;
    }
    // Optional client-side node filter (composable with --failed later).
    if (flags["--failed"] === true) {
      detail = {
        ...detail,
        nodes: detail.nodes.filter(
          (n) =>
            n.state === "failed" ||
            (n.fanout !== null && n.fanout.failed.length > 0) ||
            (n.tasks_total > 0 && n.tasks_settled < n.tasks_total && n.state === "completed"),
        ),
      };
    }
    if (asJson) {
      printJson(ctx, detail);
    } else {
      ctx.stdout(renderRunSummary(detail));
    }
    return 0;
  }

  // List
  const qs = new URLSearchParams();
  const sessionFlag =
    typeof flags["--session"] === "string" ? flags["--session"] : null;
  const all = flags["--all"] === true;
  if (!all) {
    const session =
      sessionFlag ??
      (typeof ctx.env.PARLEY_SESSION_ID === "string" && ctx.env.PARLEY_SESSION_ID !== ""
        ? ctx.env.PARLEY_SESSION_ID
        : null);
    if (session && session !== "latest") {
      qs.set("session", session);
    }
    // `latest` / unset: server returns all; CLI could filter to newest session
    // client-side — for now list all when no session is bound (same as tasks).
  }
  if (typeof flags["--workflow"] === "string") {
    qs.set("workflow", flags["--workflow"]);
  }
  if (typeof flags["--state"] === "string") {
    qs.set("state", flags["--state"]);
  }
  if (flags["--blocked"] === true) {
    qs.set("blocked", "true");
  }
  const q = qs.toString() ? `?${qs.toString()}` : "";
  let body: RunsResponse;
  try {
    body = await daemonGet<RunsResponse>(discovery, `/runs${q}`);
  } catch (err) {
    if (err instanceof DaemonRequestError && err.status === 400) {
      throw new UsageError(`run status: ${err.message}`);
    }
    throw err;
  }

  // Session `latest`: keep only the newest session's runs.
  let runs = body.runs;
  if (!all && (sessionFlag === "latest" || sessionFlag === null)) {
    if (sessionFlag === "latest" || !ctx.env.PARLEY_SESSION_ID) {
      const newest = runs[0]?.orchestrator_session_id ?? null;
      if (newest) {
        runs = runs.filter((r) => r.orchestrator_session_id === newest);
      }
    }
  }

  if (asJson) {
    printJson(ctx, runs);
  } else {
    ctx.stdout(renderRunList(runs));
  }
  return 0;
}

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

async function runGet(
  ctx: CliContext,
  positionals: string[],
  flags: Record<string, string | boolean | string[]>,
): Promise<number> {
  if (positionals.length === 0) {
    throw new UsageError(
      "run get: a deliverable id or address is required (e.g. d104 or r7/search/sources/1)",
    );
  }
  if (positionals.length > 2) {
    throw new UsageError(`run get: unexpected argument: ${positionals[2]}`);
  }

  const asJson = flags["--json"] === true;
  const runFlag = typeof flags["--run"] === "string" ? flags["--run"] : null;
  const iterationFlag =
    typeof flags["--iteration"] === "string" ? flags["--iteration"] : null;
  const slotFlag = typeof flags["--slot"] === "string" ? flags["--slot"] : null;

  // Forms:
  //   get d104
  //   get r7/search/sources/1
  //   get r7 search.sources
  //   get search.sources --run r7
  let path: string;
  if (positionals.length === 2) {
    // runId + address
    const runId = positionals[0]!;
    const address = positionals[1]!;
    const qs = new URLSearchParams({ run: runId, address });
    if (iterationFlag) qs.set("iteration", iterationFlag);
    if (slotFlag) qs.set("slot", slotFlag);
    path = `/deliverables?${qs.toString()}`;
  } else {
    const ref = positionals[0]!;
    const qs = new URLSearchParams();
    if (runFlag) qs.set("run", runFlag);
    if (iterationFlag) qs.set("iteration", iterationFlag);
    if (slotFlag) qs.set("slot", slotFlag);
    const q = qs.toString() ? `?${qs.toString()}` : "";
    path = `/deliverables/${encodeURIComponent(ref)}${q}`;
  }

  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  let value: DeliverableValue;
  try {
    value = await daemonGet<DeliverableValue>(discovery, path);
  } catch (err) {
    if (err instanceof DaemonRequestError && (err.status === 400 || err.status === 404)) {
      throw new UsageError(`run get: ${err.message}`);
    }
    throw err;
  }

  if (asJson) {
    printJson(ctx, value);
    return 0;
  }

  const rendered = renderDeliverableBare(value);
  if (rendered.stdout) ctx.stdout(rendered.stdout);
  if (rendered.stderr) ctx.stderr(rendered.stderr);
  return rendered.exitCode;
}

// Re-export for tests that want list state formatting without a daemon.
export { formatRunListState };

// ---------------------------------------------------------------------------
// #243 eval + metrics
// ---------------------------------------------------------------------------

interface RunEvalAck {
  run_id: string;
  state: string;
  workflow: string;
  version: number;
  type: string;
  eval_score?: number | null;
  eval_baseline?: number | null;
  eval_rubric?: string | null;
  eval_rubric_version?: number | null;
}

/**
 * `parley run eval <run> --answers '<json>' --feedback "<text>" [--type <type>]`
 * — whole-run structured rubric evaluation (#243 / ADR-0020). Terminal runs
 * only. Judge reads run-level artifacts via `run status` / `run get`; this
 * verb only records the score.
 */
async function runEvalRun(
  ctx: CliContext,
  positionals: string[],
  flags: Record<string, string | boolean | string[]>,
): Promise<number> {
  const ref = positionals[0];
  if (ref === undefined) {
    throw new UsageError("run eval: a run id is required");
  }
  if (positionals.length > 1) {
    throw new UsageError(`run eval: unexpected argument: ${positionals[1]}`);
  }

  if (flags["--score"] !== undefined) {
    throw new UsageError(
      "run eval: --score is no longer accepted; use --answers '<json>' with boolean answers for each rubric criterion so the daemon can compute the score",
    );
  }

  const answersFlag = flags["--answers"];
  if (typeof answersFlag !== "string") {
    throw new UsageError(
      "run eval: answers are required (--answers '<json>' mapping criterion ids to booleans)",
    );
  }
  let answers: Record<string, boolean>;
  try {
    const parsed: unknown = JSON.parse(answersFlag);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new UsageError(
        "run eval: --answers must be a JSON object mapping criterion ids to booleans",
      );
    }
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "boolean") {
        throw new UsageError(
          `run eval: --answers.${id} must be a boolean, got: ${typeof value}`,
        );
      }
    }
    answers = parsed as Record<string, boolean>;
  } catch (err) {
    if (err instanceof UsageError) throw err;
    throw new UsageError(
      `run eval: --answers must be valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const feedback = flags["--feedback"];
  if (typeof feedback !== "string" || feedback === "") {
    throw new UsageError('run eval: feedback is required (--feedback "<text>")');
  }

  const typeOverride =
    typeof flags["--type"] === "string" && flags["--type"] !== ""
      ? flags["--type"]
      : null;

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
  let ack: RunEvalAck;
  try {
    const body: Record<string, unknown> = {
      answers,
      feedback,
      ancestry_chain: ancestryChain,
      workspace_root: workspaceRoot,
    };
    if (typeOverride !== null) body.type = typeOverride;
    if (orchestratorSessionId !== null) {
      body.orchestrator_session_id = orchestratorSessionId;
    }
    ack = await daemonPost<RunEvalAck>(
      discovery,
      `/runs/${encodeURIComponent(ref)}/eval`,
      body,
    );
  } catch (err) {
    if (err instanceof DaemonRequestError && (err.status === 400 || err.status === 404)) {
      if (err.code === CODE_SESSION_REQUIRED) {
        throw new UsageError(`run eval: ${err.message}`);
      }
      throw new UsageError(`run eval: ${err.message}`);
    }
    throw err;
  }

  if (flags["--json"] === true) {
    printJson(ctx, ack);
  } else {
    const score = ack.eval_score ?? "?";
    const base = ack.eval_baseline ?? "?";
    const rubric = ack.eval_rubric ?? "?";
    ctx.stdout(
      `Run ${ack.run_id} eval → score=${score} baseline=${base} rubric=${rubric}@${ack.eval_rubric_version ?? "?"}\n`,
    );
  }
  return 0;
}

/** Read run-metrics filter flags into a {@link RunMetricsFilters} object. */
function runMetricsFiltersFromFlags(
  flags: Record<string, string | boolean | string[]>,
): RunMetricsFilters {
  const str = (name: string): string | undefined => {
    const v = flags[name];
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  const out: RunMetricsFilters = {};
  const type = str("--type");
  if (type !== undefined) out.type = type;
  const size = str("--size");
  if (size !== undefined) out.size = size;
  const difficulty = str("--difficulty");
  if (difficulty !== undefined) out.difficulty = difficulty;
  const orchHarness = str("--orch-harness");
  if (orchHarness !== undefined) out.orch_harness = orchHarness;
  const orchModel = str("--orch-model");
  if (orchModel !== undefined) out.orch_model = orchModel;
  const orchEffort = str("--orch-effort");
  if (orchEffort !== undefined) out.orch_effort = orchEffort;
  const evalHarness = str("--eval-harness");
  if (evalHarness !== undefined) out.eval_harness = evalHarness;
  const evalModel = str("--eval-model");
  if (evalModel !== undefined) out.eval_model = evalModel;
  const evalEffort = str("--eval-effort");
  if (evalEffort !== undefined) out.eval_effort = evalEffort;
  const rubric = str("--rubric");
  if (rubric !== undefined) out.rubric = rubric;
  const workflow = str("--workflow");
  if (workflow !== undefined) out.workflow = workflow;
  const rv = str("--rubric-version");
  if (rv !== undefined) {
    const n = Number(rv);
    if (!Number.isInteger(n) || n < 1) {
      throw new UsageError(`invalid --rubric-version: ${rv} (expected a positive integer)`);
    }
    out.rubric_version = n;
  }
  const wv = str("--workflow-version");
  if (wv !== undefined) {
    const n = Number(wv);
    if (!Number.isInteger(n) || n < 1) {
      throw new UsageError(`invalid --workflow-version: ${wv} (expected a positive integer)`);
    }
    out.workflow_version = n;
  }
  if (flags["--first-run"] === true) out.first_run = true;
  if (flags["--below-baseline"] === true) out.below_baseline = true;
  return out;
}

function formatPct(rate: number | null): string {
  if (rate === null) return "-";
  return `${Math.round(rate * 1000) / 10}%`;
}

function formatNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  if (Number.isInteger(n)) return String(n);
  return (Math.round(n * 10) / 10).toString();
}

function formatTokens(n: number): string {
  if (n === 0) return "0";
  if (n < 1000) return String(Math.round(n));
  const k = Math.round((n / 1000) * 10) / 10;
  return `${k}k`;
}

function renderRunMetricsHuman(ctx: CliContext, groups: RunMetricsGroup[]): void {
  if (groups.length === 0) {
    ctx.stdout("No runs.\n");
    return;
  }
  const header = [
    "GROUP",
    "DONE",
    "FAIL",
    "BLOCK",
    "SUCCESS",
    "EVAL",
    "BELOW",
    "COST/DONE",
    "TOKENS_IN",
    "TOKENS_OUT",
  ];
  const rows = groups.map((g) => {
    const evalCell =
      g.evals.count === 0
        ? "-"
        : `${formatNum(g.evals.avg)}/${formatNum(g.evals.avg_baseline)} (n=${g.evals.count})`;
    return [
      g.key ?? "(none)",
      String(g.runs.completed),
      String(g.runs.failed),
      String(g.runs.blocked),
      formatPct(g.success_rate),
      evalCell,
      g.evals.count === 0 ? "-" : formatPct(g.evals.below_baseline_rate),
      g.cost_per_completed_run === null ? "-" : formatTokens(g.cost_per_completed_run),
      formatTokens(g.tokens.input),
      formatTokens(g.tokens.output),
    ];
  });
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const format = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  ctx.stdout(`${format(header)}\n`);
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    ctx.stdout(`${format(rows[i]!)}\n`);
    if (g.evals.first_run.count > 0 || g.evals.fork.count > 0) {
      const fr = g.evals.first_run;
      const fk = g.evals.fork;
      ctx.stdout(
        `  lineage: first_run avg=${formatNum(fr.avg)} (n=${fr.count}); fork avg=${formatNum(fk.avg)} (n=${fk.count})\n`,
      );
    }
  }
}

/**
 * `parley run metrics [--session …] [--group-by workflow|…] [filters]`
 * — aggregate run metrics from the daemon (#243). Never joined with task
 * metrics (`parley metrics`).
 */
async function runRunMetrics(
  ctx: CliContext,
  positionals: string[],
  flags: Record<string, string | boolean | string[]>,
): Promise<number> {
  if (positionals.length > 0) {
    throw new UsageError(`run metrics: unexpected argument: ${positionals[0]}`);
  }

  const sessionFlag =
    typeof flags["--session"] === "string" ? flags["--session"] : undefined;
  const groupByRaw =
    typeof flags["--group-by"] === "string" ? flags["--group-by"] : "workflow";
  if (!isRunMetricsGroupBy(groupByRaw)) {
    throw new UsageError(
      `run metrics: invalid --group-by: ${groupByRaw} (expected ${RUN_METRICS_GROUP_BY.join("|")})`,
    );
  }
  const json = flags["--json"] === true;
  const filters = runMetricsFiltersFromFlags(flags);

  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  const session =
    sessionFlag === undefined || sessionFlag === "all"
      ? "all"
      : sessionFlag === "latest"
        ? "all" // run list has no cheap "latest" without another fetch; default all
        : sessionFlag;

  const params = runFiltersToSearchParams({ ...filters, session });
  params.set("group_by", groupByRaw);
  const body = await daemonGet<RunMetricsResponse>(
    discovery,
    `/run-metrics?${params.toString()}`,
  );

  if (json) {
    printJson(ctx, body);
  } else {
    renderRunMetricsHuman(ctx, body.groups);
  }
  return 0;
}
