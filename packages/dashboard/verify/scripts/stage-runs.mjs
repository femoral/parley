/**
 * Stage workflow runs against a real daemon for the run-detail verify demo.
 *
 * Creates git fixture repos with committed `.fake-vendor.json` scripts, installs
 * local-layer workflows, POSTs /runs, and waits for target states.
 *
 * Mutating HTTP (POST /runs, approve, fork, cancel) is staging-only — never
 * part of the console screen source.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * @param {string} dir
 * @param {Record<string, string>} files
 */
function writeFiles(dir, files) {
  for (const [rel, contents] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
}

/**
 * Minimal git repo with committed files (includes .fake-vendor.json).
 * @param {Record<string, string>} files
 * @returns {string} repo path
 */
export function makeRepo(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-run-repo-"));
  const git = (args) =>
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git(["init", "-b", "main"]);
  git(["config", "user.email", "verify@parley.test"]);
  git(["config", "user.name", "parley verify"]);
  writeFiles(dir, files);
  git(["add", "-A"]);
  git(["commit", "--allow-empty", "-m", "verify fixture"]);
  return dir;
}

/**
 * Install a workflow under `{parleyHome}/workflows/<id>` (global discovery
 * layer). Prefer this for verify staging: the engine's drain host resolves
 * definitions via `process.cwd()` + home, and the harness cwd is not the
 * fixture repo — local-layer workflows under the repo are invisible to
 * post-start advance.
 *
 * @param {string} parleyHome
 * @param {string} id
 * @param {Record<string, unknown>} body
 * @param {Record<string, string>} [prompts]
 */
export function installGlobalWorkflow(parleyHome, id, body, prompts = {}) {
  const dir = path.join(parleyHome, "workflows", id);
  fs.mkdirSync(path.join(dir, "prompts"), { recursive: true });
  const defaults = {
    "prompts/plan.md": "Plan the work.\n",
    "prompts/done.md": "Finish the work.\n",
    "prompts/review.md": "Review the work.\n",
    "prompts/a.md": "Slot A.\n",
    "prompts/b.md": "Slot B.\n",
    "prompts/c.md": "Slot C.\n",
  };
  for (const [rel, text] of Object.entries({ ...defaults, ...prompts })) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  fs.writeFileSync(path.join(dir, "workflow.json"), JSON.stringify(body, null, 2));
  return dir;
}

/**
 * Install a local-layer workflow under `{repo}/.parley/workflows/<id>`.
 * Prefer {@link installGlobalWorkflow} for verify harness staging.
 * @param {string} repo
 * @param {string} id
 * @param {Record<string, unknown>} body
 * @param {Record<string, string>} [prompts]
 */
export function installLocalWorkflow(repo, id, body, prompts = {}) {
  return installGlobalWorkflow(path.join(repo, ".parley"), id, body, prompts);
}

/** @param {string} baseUrl @param {string} p @param {object} [init] */
async function api(baseUrl, p, init) {
  const res = await fetch(`${baseUrl}${p}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`${init?.method ?? "GET"} ${p} → ${res.status}: ${text}`);
  }
  return body;
}

/**
 * Start a run.
 * @param {string} baseUrl
 * @param {{ workflow: string, cwd: string, brief?: string, session?: string }} opts
 */
export async function startRun(baseUrl, opts) {
  return api(baseUrl, "/runs", {
    method: "POST",
    body: JSON.stringify({
      workflow: opts.workflow,
      cwd: opts.cwd,
      inputs: { brief: opts.brief ?? "verify harness brief" },
      orchestrator_session_id: opts.session ?? "verify-orch",
    }),
  });
}

/**
 * @param {string} baseUrl
 * @param {string} runId
 * @param {string} verb
 * @param {object} [body]
 */
export async function runVerb(baseUrl, runId, verb, body = {}) {
  return api(baseUrl, `/runs/${encodeURIComponent(runId)}/${verb}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Poll GET /runs/:id until predicate or timeout.
 * @param {string} baseUrl
 * @param {string} runId
 * @param {(detail: object) => boolean} predicate
 * @param {number} [timeoutMs]
 */
export async function waitRun(baseUrl, runId, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await api(baseUrl, `/runs/${encodeURIComponent(runId)}`);
    if (predicate(last)) return last;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitRun timed out for ${runId}: state=${last?.run?.state} node=${last?.run?.current_node} err=${last?.run?.error}`,
      );
    }
    await new Promise((r) => setTimeout(r, 80));
  }
}

/** Gate-held workflow: plan → approve (gate) → done. */
export function gateWorkflow() {
  return {
    id: "console-gate",
    version: 1,
    type: "other",
    workspace: "repo",
    reentry: "done",
    inputs: { brief: { type: "text" } },
    outputs: { out: { type: "text", from: "done.result" } },
    nodes: [
      {
        id: "plan",
        kind: "step",
        task_type: "other",
        profile: "deep",
        prompt: "prompts/plan.md",
        in: { brief: { type: "text", from: "run.brief" } },
        out: { plan: { type: "text" } },
      },
      {
        id: "approve",
        kind: "gate",
        question: "Approve this plan?",
        shows: { plan: { from: "plan.plan" } },
        on_reject: "finish",
      },
      {
        id: "done",
        kind: "step",
        task_type: "other",
        profile: "deep",
        prompt: "prompts/done.md",
        in: { plan: { type: "text", from: "plan.plan" } },
        out: { result: { type: "text" } },
      },
    ],
  };
}

/** Fan-out first node (slots ×3). */
export function fanWorkflow() {
  return {
    id: "console-fan",
    version: 1,
    type: "other",
    workspace: "repo",
    inputs: { brief: { type: "text" } },
    outputs: { out: { type: "dict<string, text>", from: "review.notes" } },
    nodes: [
      {
        id: "review",
        kind: "step",
        task_type: "other",
        profile: "deep",
        prompt: "prompts/review.md",
        slots: {
          structure: { prompt_append: "prompts/a.md" },
          risks: { prompt_append: "prompts/b.md" },
          approach: { prompt_append: "prompts/c.md" },
        },
        in: { brief: { type: "text", from: "run.brief" } },
        out: { notes: { type: "text" } },
      },
    ],
  };
}

/** Fail-fast single step. */
export function failWorkflow() {
  return {
    id: "console-fail",
    version: 1,
    type: "other",
    workspace: "repo",
    inputs: { brief: { type: "text" } },
    outputs: { out: { type: "text", from: "plan.plan" } },
    nodes: [
      {
        id: "plan",
        kind: "step",
        task_type: "other",
        profile: "deep",
        prompt: "prompts/plan.md",
        in: { brief: { type: "text", from: "run.brief" } },
        out: { plan: { type: "text" } },
      },
    ],
  };
}

/**
 * Stage the four required run shapes. Returns ids + summaries.
 * @param {string} baseUrl
 * @param {{ home: string }} opts daemon harness home (for global workflow install)
 */
export async function stageRequiredRuns(baseUrl, opts) {
  const parleyHome = opts.home;
  const staged = {
    gateHeld: /** @type {object | null} */ (null),
    fanOut: /** @type {object | null} */ (null),
    failed: /** @type {object | null} */ (null),
    forked: /** @type {object | null} */ (null),
    notes: /** @type {string[]} */ ([]),
  };

  // Install workflows once into the daemon home global layer so post-start
  // drain/advance can resolve definitions (host uses process.cwd() + home).
  installGlobalWorkflow(parleyHome, "console-gate", gateWorkflow());
  installGlobalWorkflow(parleyHome, "console-fan", fanWorkflow());
  installGlobalWorkflow(parleyHome, "console-fail", failWorkflow());

  // ── Gate-held ────────────────────────────────────────────────────────
  {
    const script = JSON.stringify(
      [
        { emit: { type: "message", text: "planning for gate" } },
        {
          submit_report: {
            plan: "Ship the console run detail screen.",
          },
        },
      ],
      null,
      2,
    );
    const repo = makeRepo({
      "README.md": "gate fixture\n",
      ".fake-vendor.json": script,
    });
    const ack = await startRun(baseUrl, {
      workflow: "console-gate",
      cwd: repo,
      brief: "gate-held verify",
    });
    const detail = await waitRun(
      baseUrl,
      ack.run_id,
      (d) => d.run?.state === "blocked" && d.run?.block?.reason === "gate",
      45_000,
    );
    staged.gateHeld = {
      runId: ack.run_id,
      state: detail.run.state,
      block: detail.run.block,
      workspace: detail.run.worktree ?? detail.run.workspace,
      nodeCount: detail.nodes?.length ?? 0,
      repo,
    };
  }

  // ── Fan-out ──────────────────────────────────────────────────────────
  {
    // Long-running slots so we observe fan-out width while tasks are live.
    const script = JSON.stringify(
      [
        { emit: { type: "message", text: "fan slot work" } },
        { sleep: 8_000 },
        { submit_report: { notes: "slot notes" } },
      ],
      null,
      2,
    );
    const repo = makeRepo({
      "README.md": "fan fixture\n",
      ".fake-vendor.json": script,
    });
    const ack = await startRun(baseUrl, {
      workflow: "console-fan",
      cwd: repo,
      brief: "fan-out verify",
    });
    const detail = await waitRun(
      baseUrl,
      ack.run_id,
      (d) => {
        const n = (d.nodes ?? []).find((x) => x.node === "review");
        return Boolean(n?.fanout && n.fanout.width >= 2 && n.tasks_total >= 2);
      },
      45_000,
    );
    const review = (detail.nodes ?? []).find((x) => x.node === "review");
    staged.fanOut = {
      runId: ack.run_id,
      state: detail.run.state,
      fanWidth: review?.fanout?.width ?? null,
      tasksTotal: review?.tasks_total ?? null,
      repo,
    };
  }

  // ── Failed ───────────────────────────────────────────────────────────
  // Daemon parks step-failure under success_policy as `blocked` with the node
  // STATE=`failed` (never auto-fails the run — orchestrator verbs finish it).
  // We stage that honest wire shape and prove FAILED on the node + block banner.
  {
    const script = JSON.stringify(
      [
        { emit: { type: "message", text: "about to fail" } },
        { emit: { type: "fatal", message: "synthetic run failure (verify)" } },
        { exit: 1 },
      ],
      null,
      2,
    );
    const repo = makeRepo({
      "README.md": "fail fixture\n",
      ".fake-vendor.json": script,
    });
    const ack = await startRun(baseUrl, {
      workflow: "console-fail",
      cwd: repo,
      brief: "failed verify",
    });
    const detail = await waitRun(
      baseUrl,
      ack.run_id,
      (d) => {
        if (d.run?.state === "failed") return true;
        const nodes = d.nodes ?? [];
        return nodes.some((n) => n.state === "failed");
      },
      45_000,
    );
    const failedNodes = (detail.nodes ?? [])
      .filter((n) => n.state === "failed")
      .map((n) => n.node);
    staged.failed = {
      runId: ack.run_id,
      state: detail.run.state,
      error: detail.run.error,
      block: detail.run.block,
      failedNodes,
      nodeFailed: failedNodes.length > 0,
      repo,
    };
    if (detail.run.state !== "failed" && failedNodes.length === 0) {
      staged.notes.push(
        `failed staging: run state=${detail.run.state} without failed nodes`,
      );
    } else if (detail.run.state !== "failed") {
      staged.notes.push(
        "daemon parks step failure as blocked(success_policy) with node STATE=failed " +
          "(run.state=failed only on phase-2 start errors / definition unparseable)",
      );
    }
  }

  // ── Forked (inherited + skipped) ─────────────────────────────────────
  try {
    // Parent reaches gate → reject (on_reject: finish) → terminal → fork to done.
    // Plan deliverables inherit; gate at iteration 0 projects as skipped.
    const script = JSON.stringify(
      [
        { emit: { type: "message", text: "parent plan" } },
        { submit_report: { plan: "parent plan body" } },
      ],
      null,
      2,
    );
    const repo = makeRepo({
      "README.md": "fork fixture\n",
      ".fake-vendor.json": script,
    });
    const ack = await startRun(baseUrl, {
      workflow: "console-gate",
      cwd: repo,
      brief: "fork parent verify",
    });
    await waitRun(
      baseUrl,
      ack.run_id,
      (d) => d.run?.state === "blocked" && d.run?.block?.reason === "gate",
      45_000,
    );
    await runVerb(baseUrl, ack.run_id, "reject", {});
    await waitRun(
      baseUrl,
      ack.run_id,
      (d) =>
        d.run?.state === "completed" ||
        d.run?.state === "cancelled" ||
        d.run?.state === "failed" ||
        d.run?.completed_at != null,
      20_000,
    );
    const forkAck = await runVerb(baseUrl, ack.run_id, "fork", { to: "done" });
    const childId = forkAck.run_id;
    const child = await waitRun(
      baseUrl,
      childId,
      (d) => {
        const nodes = d.nodes ?? [];
        const hasInherited = nodes.some((n) => n.state === "inherited");
        const hasSkipped = nodes.some((n) => n.state === "skipped");
        return hasInherited || hasSkipped || nodes.length > 0;
      },
      30_000,
    );
    const nodes = child.nodes ?? [];
    staged.forked = {
      parentRunId: ack.run_id,
      runId: childId,
      state: child.run.state,
      parent_run_id: child.run.parent_run_id,
      attempt: child.run.attempt,
      inherited: nodes.filter((n) => n.state === "inherited").map((n) => n.node),
      skipped: nodes.filter((n) => n.state === "skipped").map((n) => n.node),
      nodeStates: nodes.map((n) => ({ node: n.node, state: n.state, iteration: n.iteration })),
      repo,
    };
    if (!staged.forked.inherited.length && !staged.forked.skipped.length) {
      staged.notes.push(
        "forked run staged but wire did not yet project inherited/skipped " +
          `(states: ${JSON.stringify(staged.forked.nodeStates)})`,
      );
    }
  } catch (err) {
    staged.notes.push(
      `fork staging failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return staged;
}
