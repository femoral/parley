/**
 * `parley run <verb> …` — gate verbs (#238) + re-entry (#242) + query surface
 * (ADR-0021 / #241).
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
 *
 * Joins the existing `parley run` namespace — not a new `parley workflow`.
 */
import type {
  DeliverableValue,
  NodeDetailResponse,
  RunDetailResponse,
  RunsResponse,
} from "@useparley/core";
import { parseArgs } from "../args.js";
import { DaemonRequestError, daemonGet, daemonPost, ensureDaemon } from "../client.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";
import {
  EXIT_DELIVERABLE_PURGED,
  formatRunListState,
  renderDeliverableBare,
  renderNodeDetail,
  renderRunList,
  renderRunSummary,
} from "@useparley/daemon/run-query.js";

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

function isGateVerb(value: string): value is GateVerb {
  return (GATE_VERBS as readonly string[]).includes(value);
}

function isReentryVerb(value: string): value is ReentryVerb {
  return (REENTRY_VERBS as readonly string[]).includes(value);
}

function isQueryVerb(value: string): value is QueryVerb {
  return (QUERY_VERBS as readonly string[]).includes(value);
}

const VERB_HELP =
  "status | get | approve | reject | redirect | finish | fork | cancel";

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
 * `parley run approve|reject|redirect|finish|fork|cancel|status|get …`
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
