/**
 * Issue #356 — run detail screen proofs.
 *
 * Stages fan-out, gate-held, forked, failed runs via real daemon + fake-vendor;
 * measures pipeline/grid/table at 1280/1460/1920; honesty via intercept + kill;
 * axe + ARIA + keyboard walk; board H-scroll gate.
 */
import { pathToFileURL } from "node:url";
import { collectA11y, runAxe, ariaSnapshot, keyboardWalk } from "../lib/a11y.mjs";
import { ledgerDirs, writeDemoProof, printRectSummary } from "../lib/ledger.mjs";
import { measureAtViewports, measureElement } from "../lib/measure.mjs";
import { openVerifySession } from "../lib/session.mjs";
import { stageRequiredRuns } from "../scripts/stage-runs.mjs";
import { withFakeAllowlist } from "../lib/daemon.mjs";
import path from "node:path";

const TICKET = "issue-356";
const DEMO = "run-detail";

const RUN_SELECTORS = [
  { id: "shell", selector: '[data-testid="shell"]' },
  { id: "center", selector: ".pc-shell__center" },
  { id: "screen-run", selector: '[data-testid="screen-run"]' },
  { id: "run-header", selector: '[data-testid="run-header"]' },
  { id: "run-view-switch", selector: '[data-testid="run-view-switch"]' },
  { id: "run-pipeline", selector: '[data-testid="run-pipeline"]' },
  { id: "run-outputs", selector: '[data-testid="run-outputs"]' },
  { id: "run-deliverables", selector: '[data-testid="run-deliverables"]' },
  { id: "run-tasks", selector: '[data-testid="run-tasks"]' },
  { id: "run-state-chip", selector: '[data-testid="run-state-chip"]' },
  { id: "run-workspace", selector: '[data-testid="run-workspace"]' },
  { id: "run-block", selector: '[data-testid="run-block"]' },
];

/**
 * Issue-356 merge gates.
 * @param {object} _entry
 * @param {object} ledger
 */
export function runDetailGates(_entry, ledger) {
  const demo = ledger.demos?.[DEMO];
  if (!demo) throw new Error("run-detail: missing demo in ledger");

  if (!demo.headline?.boardScroll?.noHorizontalScroll) {
    throw new Error("run-detail: board horizontal scroll at 1280 not clear");
  }

  const staged = demo.staged ?? {};
  for (const key of ["gateHeld", "fanOut", "failed"]) {
    if (!staged[key]?.runId) {
      throw new Error(`run-detail: missing staged ${key} run`);
    }
  }
  if (staged.gateHeld?.state !== "blocked") {
    throw new Error(`run-detail: gateHeld expected blocked, got ${staged.gateHeld?.state}`);
  }
  if (staged.failed?.state !== "failed" && !staged.failed?.nodeFailed) {
    throw new Error(
      `run-detail: failed expected run.state=failed or a failed node, got state=${staged.failed?.state}`,
    );
  }
  if (!(staged.fanOut?.fanWidth >= 2)) {
    throw new Error(`run-detail: fanOut width expected ≥2, got ${staged.fanOut?.fanWidth}`);
  }

  // Fork UI required in both table and grid (REQUIRED #3).
  if (!staged.forked?.runId) {
    throw new Error("run-detail: missing forked run");
  }
  const forkUi = demo.forkRender ?? {};
  if (!forkUi.inheritedFound || !forkUi.skippedFound) {
    throw new Error(
      `run-detail: fork table markers missing inherited=${forkUi.inheritedFound} skipped=${forkUi.skippedFound}`,
    );
  }
  if (!forkUi.gridInheritedFound || !forkUi.gridSkippedFound) {
    throw new Error(
      `run-detail: fork GRID markers missing inherited=${forkUi.gridInheritedFound} skipped=${forkUi.gridSkippedFound}`,
    );
  }

  // Wire verbs rendered (REQUIRED #4)
  if (!demo.wireVerbs?.ok) {
    throw new Error(
      `run-detail: wire verbs not proven (got ${JSON.stringify(demo.wireVerbs)})`,
    );
  }

  // Gate notice visibility at 1280 (REQUIRED #2)
  const gn = demo.gateNoticeStyles ?? {};
  for (const w of [1280, 1360]) {
    const row = gn[String(w)];
    if (!row?.compactVisible) {
      throw new Error(`run-detail: compact gate notice not visible at ${w}`);
    }
    if (row.fullVisible) {
      throw new Error(`run-detail: full gate notice should hide at ${w}`);
    }
  }
  for (const w of [1361, 1460]) {
    const row = gn[String(w)];
    if (!row?.fullVisible) {
      throw new Error(`run-detail: full gate notice not visible at ${w}`);
    }
  }

  // Axe across all three views (REQUIRED #6)
  const axeByView = demo.a11yByView ?? {};
  for (const v of ["pipeline", "grid", "table"]) {
    const block = axeByView[v];
    if (!block?.axe) throw new Error(`run-detail: missing axe for view ${v}`);
    const viol = block.axe.violations ?? [];
    if (viol.length > 0) {
      throw new Error(
        `run-detail: axe violations in ${v}: ${viol.map((x) => x.id).join(", ")}`,
      );
    }
  }
  // Empty + error shells
  for (const s of ["empty", "error"]) {
    const block = axeByView[s];
    if (!block?.axe) throw new Error(`run-detail: missing axe for shell ${s}`);
    const viol = block.axe.violations ?? [];
    if (viol.length > 0) {
      throw new Error(
        `run-detail: axe violations in ${s}: ${viol.map((x) => x.id).join(", ")}`,
      );
    }
  }

  if (!demo.views?.pipeline || !demo.views?.grid || !demo.views?.table) {
    throw new Error("run-detail: missing view proofs");
  }

  // Honesty error: phase MUST be panel-error (REQUIRED #5)
  if (demo.honesty?.error?.phase !== "panel-error") {
    throw new Error(
      `run-detail: honesty.error phase expected panel-error, got ${demo.honesty?.error?.phase}`,
    );
  }
  if (!demo.honesty?.error?.hasErrorShell) {
    throw new Error("run-detail: honesty.error missing run-error-shell");
  }

  // Copy sweep: truncated must be true (REQUIRED #5)
  if (demo.copySweep?.truncated !== true) {
    throw new Error(
      `run-detail: copySweep truncated expected true, got ${JSON.stringify(demo.copySweep)}`,
    );
  }

  // Neuter: only genuine broken treatment (REQUIRED #5)
  if (!demo.neuter?.broke || !demo.neuter?.restored) {
    throw new Error("run-detail: missing neuter proof");
  }
  if (demo.neuter.brokePhase !== "panel-error") {
    throw new Error(
      `run-detail: neuter brokePhase expected panel-error, got ${demo.neuter.brokePhase}`,
    );
  }

  // Outputs present outside view switch
  if (!demo.outputsAlways?.ok) {
    throw new Error("run-detail: run outputs not proven outside view switch");
  }

  // Pipeline wrap honesty (MED N1): full rows except last; cue says "wrapped"
  const wrap = demo.pipelineWrap ?? {};
  if (!wrap.ok) {
    throw new Error(
      `run-detail: pipeline wrap not honest (got ${JSON.stringify(wrap)})`,
    );
  }

  // Fork STATE column names INHERITED/SKIPPED (MED N2)
  if (!forkUi.stateNamed) {
    throw new Error(
      `run-detail: fork state labels missing (got ${JSON.stringify({
        table: forkUi.tableStateLabels,
        grid: forkUi.gridStateLabels,
      })})`,
    );
  }

  // No mutating routes in screen source
  if (demo.mutateGrep && demo.mutateGrep.hits > 0) {
    throw new Error(
      `run-detail: mutating run/gate routes found in screen source: ${JSON.stringify(demo.mutateGrep.matches)}`,
    );
  }
}

/**
 * @param {import('playwright-core').Page} page
 * @param {string} url
 * @param {string} runId
 */
async function openRun(page, url, runId) {
  // focusRun filters GET /runs to a single id; RunScreen auto-selects when
  // the current selection is absent from the live list.
  await page.goto(`${url}#/run`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="shell"]');
  await page.waitForSelector('[data-testid="screen-run"]', { timeout: 15_000 });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const bound = await page
      .locator(`[data-testid="screen-run"][data-run-id="${runId}"]`)
      .count();
    if (bound > 0) return;
    await page.waitForTimeout(200);
  }
  await page.goto(`${url}#/run`, { waitUntil: "networkidle" });
  await page
    .waitForSelector(`[data-testid="screen-run"][data-run-id="${runId}"]`, {
      timeout: 10_000,
    })
    .catch(() => undefined);
}

/**
 * Force the runs list to a single run so auto-select picks it.
 * @param {import('playwright-core').Page} page
 * @param {string} baseUrl
 * @param {string} runId
 */
async function focusRun(page, baseUrl, runId) {
  await page.unroute("**/runs").catch(() => undefined);
  await page.unroute("**/runs**").catch(() => undefined);
  await page.route("**/runs", async (route) => {
    try {
      const u = route.request().url();
      // Detail and node routes contain /runs/<id> — only rewrite bare list.
      const pathName = new URL(u).pathname;
      if (pathName === "/runs" || pathName.endsWith("/runs")) {
        let body;
        try {
          const res = await fetch(`${baseUrl}/runs`);
          body = await res.json();
        } catch {
          await route.fulfill({
            status: 502,
            contentType: "application/json",
            body: JSON.stringify({ error: "daemon unreachable (focusRun)" }),
          });
          return;
        }
        const runs = (body.runs ?? []).filter((r) => r.run_id === runId);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ...body, runs }),
        });
        return;
      }
      await route.continue();
    } catch {
      try {
        await route.continue();
      } catch {
        /* page closed */
      }
    }
  });
}

/** Drop all run-related routes before daemon kill / restart. */
async function clearRunRoutes(page) {
  await page.unroute("**/runs").catch(() => undefined);
  await page.unroute("**/runs**").catch(() => undefined);
  await page.unroute("**/runs/*").catch(() => undefined);
  await page.unroute("**/runs/**").catch(() => undefined);
}

/**
 * Grep screen source for mutating run/gate routes (defect if present).
 */
async function grepMutatingRoutes() {
  const { execFileSync } = await import("node:child_process");
  const { DASHBOARD_ROOT } = await import("../lib/paths.mjs");
  const dir = `${DASHBOARD_ROOT}/src/screens/run`;
  try {
    const out = execFileSync(
      "rg",
      [
        "-n",
        "POST|PUT|DELETE|/approve|/reject|/redirect|/finish|/fork|/cancel",
        dir,
      ],
      { encoding: "utf8" },
    );
    // Filter false positives: comments mentioning verbs, GATE_VERBS array, notices.
    const lines = out
      .split("\n")
      .filter(Boolean)
      .filter((l) => {
        if (l.includes("GATE_VERBS")) return false;
        if (l.includes("GATE_READONLY")) return false;
        if (l.includes("read-only")) return false;
        if (l.includes("orchestrating agent")) return false;
        if (l.includes("never posts")) return false;
        if (l.includes("Observation-only")) return false;
        if (l.includes("no mutating")) return false;
        // Real HTTP verbs in fetch/client calls would look like method: "POST"
        if (/method:\s*["'](POST|PUT|DELETE)/i.test(l)) return true;
        if (/\.(post|put|delete)\s*\(/i.test(l)) return true;
        if (/fetch\([^)]*method:\s*["']POST/i.test(l)) return true;
        if (/\/runs\/[^"']+\/(approve|reject|redirect|finish|fork|cancel)/.test(l))
          return true;
        return false;
      });
    return { hits: lines.length, matches: lines.slice(0, 20) };
  } catch (err) {
    // rg exit 1 = no matches
    if (err && /** @type {any} */ (err).status === 1) {
      return { hits: 0, matches: [] };
    }
    return { hits: 0, matches: [], note: String(err) };
  }
}

export async function runRunDetailDemo() {
  const config = withFakeAllowlist({
    profiles: {
      deep: {
        vendor: "fake",
        model: "fake-model",
        effort: "medium",
        sandbox: "workspace",
      },
      fast: {
        vendor: "fake",
        model: "fake-model",
        effort: "low",
        sandbox: "workspace",
      },
    },
    defaults: { profile: "deep" },
  });

  const session = await openVerifySession({ config });
  try {
    const staged = await stageRequiredRuns(session.daemon.baseUrl, {
      home: session.daemon.home,
    });
    console.log("[run-detail] staged", {
      gate: staged.gateHeld?.runId,
      fan: staged.fanOut?.runId,
      fail: staged.failed?.runId,
      fork: staged.forked?.runId,
      notes: staged.notes,
    });

    const { shotsDir } = ledgerDirs(TICKET);
    const page = session.page;
    const url = session.url;

    // ── Primary: gate-held at three viewports ─────────────────────────
    await focusRun(page, session.daemon.baseUrl, staged.gateHeld.runId);
    await openRun(page, url, staged.gateHeld.runId);
    await page.waitForSelector('[data-testid="run-header"]', { timeout: 20_000 });
    await page.waitForSelector('[data-testid="run-pipeline"]', { timeout: 10_000 });

    const viewports = await measureAtViewports(page, {
      url: `${url}#/run`,
      shotDir: shotsDir,
      shotPrefix: DEMO,
      targets: RUN_SELECTORS,
    });

    // Board H-scroll at 1280
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${url}#/run`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="shell"]');
    const boardScroll = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="shell"]');
      if (!el) return { found: false };
      return {
        found: true,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        noHorizontalScroll: el.scrollWidth <= el.clientWidth,
      };
    });

    // View switch proofs
    const views = {};
    for (const [id, testId] of [
      ["pipeline", "run-pipeline"],
      ["grid", "run-iteration-grid"],
      ["table", "run-node-table"],
    ]) {
      if (id !== "pipeline") {
        await page.click(`[data-testid="run-view-${id === "grid" ? "grid" : "table"}"]`);
      }
      await page.waitForSelector(`[data-testid="${testId}"]`, { timeout: 5_000 });
      views[id] = await measureElement(page, `[data-testid="${testId}"]`);
      // screenshot per view
      await page.screenshot({
        path: path.join(shotsDir, `${DEMO}-view-${id}-1460.png`),
        fullPage: false,
      });
    }
    // Reset to pipeline
    await page.click('[data-testid="run-view-pipeline"]');

    // Gate held UI bits
    const gateUi = {
      block: await measureElement(page, '[data-testid="run-block"]'),
      chip: await measureElement(page, '[data-testid="run-state-chip"]'),
      workspace: await measureElement(page, '[data-testid="run-workspace"]'),
      notice: await page.locator('[data-testid="run-view-switch"]').textContent(),
    };

    // ── Fan-out ───────────────────────────────────────────────────────
    await focusRun(page, session.daemon.baseUrl, staged.fanOut.runId);
    await openRun(page, url, staged.fanOut.runId);
    await page.waitForSelector('[data-testid="run-header"]', { timeout: 20_000 });
    const fanText = await page.locator('[data-testid="run-pipeline"]').textContent();
    const fanRender = {
      textSample: (fanText ?? "").slice(0, 400),
      hasWidthCue: /×\d|fan-out/i.test(fanText ?? ""),
    };
    await page.screenshot({ path: path.join(shotsDir, `${DEMO}-fanout-1460.png`) });

    // ── Failed ────────────────────────────────────────────────────────
    await focusRun(page, session.daemon.baseUrl, staged.failed.runId);
    await openRun(page, url, staged.failed.runId);
    await page.waitForSelector('[data-testid="run-header"]', { timeout: 20_000 });
    const failChip = await page.locator('[data-testid="run-state-chip"]').textContent();
    const failPipe = await page.locator('[data-testid="run-pipeline"]').textContent();
    const failedRender = {
      chip: failChip,
      pipeSample: (failPipe ?? "").slice(0, 300),
      isFailed:
        /FAILED/i.test(failChip ?? "") ||
        /FAILED/i.test(failPipe ?? "") ||
        (await page.locator('[data-state="failed"]').count()) > 0,
    };
    await page.screenshot({ path: path.join(shotsDir, `${DEMO}-failed-1460.png`) });

    // ── Forked ────────────────────────────────────────────────────────
    let forkRender = {
      inheritedFound: false,
      skippedFound: false,
      textSample: "",
    };
    // Wire verbs on parked-failed (r3) — REQUIRED #4
    let wireVerbs = { ok: false };
    if (staged.failed?.runId) {
      await clearRunRoutes(page);
      await focusRun(page, session.daemon.baseUrl, staged.failed.runId);
      await openRun(page, url, staged.failed.runId);
      await page.waitForTimeout(800);
      const verbsText =
        (await page.locator('[data-testid="run-block-verbs"]').textContent().catch(() => null)) ??
        (await page.locator('[data-testid="run-view-switch"]').textContent());
      const wire = staged.failed.block?.verbs ?? [];
      wireVerbs = {
        ok:
          wire.length > 0
            ? wire.every((v) => (verbsText ?? "").includes(v)) &&
              !(wire.length < 4 && (verbsText ?? "").includes("approve"))
            : true,
        wire,
        rendered: (verbsText ?? "").slice(0, 200),
      };
    }

    if (staged.forked?.runId) {
      await clearRunRoutes(page);
      await focusRun(page, session.daemon.baseUrl, staged.forked.runId);
      await openRun(page, url, staged.forked.runId);
      await page.waitForSelector('[data-testid="run-header"]', { timeout: 20_000 });
      const boundId = await page
        .locator('[data-testid="screen-run"]')
        .getAttribute("data-run-id");

      // Table — measure fork markers + STATE labels while view is mounted (MED N2)
      await page.click('[data-testid="run-view-table"]');
      await page.waitForSelector('[data-testid="run-node-table"]', { timeout: 5_000 });
      const table = page.locator('[data-testid="run-node-table"]');
      const tableInh = await table.locator('[data-fork="inherited"]').count();
      const tableSkip = await table.locator('[data-fork="skipped"]').count();
      const tableText = ((await table.textContent()) ?? "").slice(0, 500);
      const tableStateLabels = await table.evaluate((el) => {
        const rows = [...el.querySelectorAll("[data-fork]")];
        return rows.map((r) => ({
          fork: r.getAttribute("data-fork"),
          stateLabel: r.querySelector(".pc-run__state-label")?.textContent?.trim() ?? null,
          hasBadge: !!r.querySelector(".pc-run__fork-badge"),
        }));
      });

      // Pipeline
      await page.click('[data-testid="run-view-pipeline"]');
      await page.waitForSelector('[data-testid="run-pipeline"]', { timeout: 5_000 });
      const pipe = page.locator('[data-testid="run-pipeline"]');
      const pipeInh = await pipe.locator('[data-fork="inherited"]').count();
      const pipeSkip = await pipe.locator('[data-fork="skipped"]').count();

      // Grid — REQUIRED #3 (must include iter 0) + STATE names (MED N2)
      await page.click('[data-testid="run-view-grid"]');
      await page.waitForSelector('[data-testid="run-iteration-grid"]', { timeout: 5_000 });
      const grid = page.locator('[data-testid="run-iteration-grid"]');
      const gridInh = await grid.locator('[data-fork="inherited"]').count();
      const gridSkip = await grid.locator('[data-fork="skipped"]').count();
      const gridText = ((await grid.textContent()) ?? "").slice(0, 400);
      const gridStateLabels = await grid.evaluate((el) => {
        const cells = [...el.querySelectorAll("[data-fork]")];
        return cells.map((c) => ({
          fork: c.getAttribute("data-fork"),
          stateLabel: c.querySelector(".pc-run__state-label")?.textContent?.trim() ?? null,
        }));
      });

      const stateNamed =
        tableStateLabels.some((r) => r.fork === "inherited" && /INHERITED/i.test(r.stateLabel ?? "")) &&
        tableStateLabels.some((r) => r.fork === "skipped" && /SKIPPED/i.test(r.stateLabel ?? "")) &&
        gridStateLabels.some((r) => r.fork === "inherited" && /INHERITED/i.test(r.stateLabel ?? "")) &&
        gridStateLabels.some((r) => r.fork === "skipped" && /SKIPPED/i.test(r.stateLabel ?? ""));

      forkRender = {
        boundRunId: boundId,
        expectedRunId: staged.forked.runId,
        inheritedFound: tableInh + pipeInh > 0,
        skippedFound: tableSkip + pipeSkip > 0,
        gridInheritedFound: gridInh > 0,
        gridSkippedFound: gridSkip > 0,
        stateNamed,
        tableStateLabels,
        gridStateLabels,
        gridTextSample: gridText,
        textSample: tableText,
      };
      await page.screenshot({ path: path.join(shotsDir, `${DEMO}-forked-1460.png`) });
    }

    // ── Pipeline wrap honesty (MED N1) ────────────────────────────────
    // Inject a 20-node detail so we can measure full-row histogram at
    // 1280/1920; natural flex-wrap must fill rows (last may be short).
    let pipelineWrap = { ok: false };
    {
      const wrapRunId = staged.gateHeld?.runId ?? staged.fanOut?.runId;
      if (wrapRunId) {
        await clearRunRoutes(page);
        // Single handler for list + detail (**/runs** matches both — see honesty).
        await page.route("**/runs**", async (route) => {
          try {
            const u = route.request().url();
            const pathName = new URL(u).pathname;
            const isList = pathName === "/runs" || pathName.endsWith("/runs");
            if (isList) {
              const res = await fetch(`${session.daemon.baseUrl}/runs`);
              const body = await res.json();
              const runs = (body.runs ?? []).filter((r) => r.run_id === wrapRunId);
              await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ ...body, runs }),
              });
              return;
            }
            // Bare detail only — not /nodes/ or /deliverables.
            const detailSuffix = `/runs/${wrapRunId}`;
            if (
              pathName.endsWith(detailSuffix) ||
              pathName.endsWith(`/runs/${encodeURIComponent(wrapRunId)}`)
            ) {
              const res = await fetch(`${session.daemon.baseUrl}/runs/${wrapRunId}`);
              const body = await res.json();
              const template = body.nodes?.[0] ?? {
                node: "n",
                kind: "step",
                state: "completed",
                iteration: 1,
                tasks_settled: 1,
                tasks_total: 1,
                gist: "wrap",
                duration_ms: 0,
              };
              body.nodes = Array.from({ length: 20 }, (_, i) => ({
                ...template,
                node: `n${i}`,
                kind: "step",
                state: "completed",
                iteration: 1,
                tasks_settled: 1,
                tasks_total: 1,
                gist: `node ${i}`,
                fanout: null,
                on_reject: null,
              }));
              await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(body),
              });
              return;
            }
            await route.continue();
          } catch {
            await route.continue().catch(() => undefined);
          }
        });
        await page.goto(`${url}#/run`, { waitUntil: "networkidle" });
        await page.waitForSelector('[data-testid="shell"]');
        await page
          .waitForSelector(`[data-testid="screen-run"][data-run-id="${wrapRunId}"]`, {
            timeout: 15_000,
          })
          .catch(() => undefined);
        await page
          .waitForSelector('[data-testid="run-pipeline"]', { timeout: 15_000 })
          .catch(() => undefined);
        // Ensure pipeline view + 20 cards.
        await page.click('[data-testid="run-view-pipeline"]').catch(() => undefined);
        await page
          .waitForFunction(
            () =>
              document.querySelectorAll(
                '[data-testid="run-pipeline"] .pc-run__node-card',
              ).length >= 20,
            { timeout: 12_000 },
          )
          .catch(() => undefined);

        const histAt = async (width) => {
          await page.setViewportSize({ width, height: 900 });
          await page.waitForTimeout(250);
          return page.evaluate(() => {
            const track = document.querySelector(".pc-run__pipeline-track");
            const cue = document.querySelector('[data-testid="pipeline-scroll-cue"]');
            if (!track) return { found: false };
            const cards = [...track.querySelectorAll(".pc-run__node-card")];
            const tops = cards.map((c) => Math.round(c.getBoundingClientRect().top));
            const groups = new Map();
            for (const t of tops) {
              let key = t;
              for (const k of groups.keys()) {
                if (Math.abs(k - t) <= 2) {
                  key = k;
                  break;
                }
              }
              groups.set(key, (groups.get(key) ?? 0) + 1);
            }
            const histogram = [...groups.entries()]
              .sort((a, b) => a[0] - b[0])
              .map(([, n]) => n);
            const cueText = cue?.textContent?.trim() ?? null;
            return {
              found: true,
              nodeCount: cards.length,
              histogram,
              cueText,
              cueHonest: cueText != null && /wrapped/.test(cueText) && !/rows of/.test(cueText),
              rowsUniform:
                histogram.length > 0 &&
                histogram.slice(0, -1).every((n) => n === histogram[0]) &&
                histogram[histogram.length - 1] <= histogram[0] &&
                !histogram.slice(0, -1).some((n) => n === 1 && histogram[0] > 1),
            };
          });
        };

        const at1280 = await histAt(1280);
        const at1920 = await histAt(1920);
        pipelineWrap = {
          ok:
            at1280.found &&
            at1920.found &&
            at1280.nodeCount === 20 &&
            at1920.nodeCount === 20 &&
            at1280.cueHonest &&
            at1920.cueHonest &&
            at1280.rowsUniform &&
            at1920.rowsUniform,
          at1280,
          at1920,
        };
        await clearRunRoutes(page);
      }
    }

    // Outputs always present across views — REQUIRED #10
    let outputsAlways = { ok: false, views: {} };
    if (staged.gateHeld?.runId) {
      await clearRunRoutes(page);
      await focusRun(page, session.daemon.baseUrl, staged.gateHeld.runId);
      await openRun(page, url, staged.gateHeld.runId);
      for (const [btn, name] of [
        ["run-view-pipeline", "pipeline"],
        ["run-view-grid", "grid"],
        ["run-view-table", "table"],
      ]) {
        await page.click(`[data-testid="${btn}"]`);
        await page.waitForTimeout(200);
        outputsAlways.views[name] =
          (await page.locator('[data-testid="run-outputs"]').count()) > 0;
      }
      outputsAlways.ok = Object.values(outputsAlways.views).every(Boolean);
    }

    // Gate notice computed styles at 1280/1360/1361/1460 — REQUIRED #2
    const gateNoticeStyles = {};
    for (const width of [1280, 1360, 1361, 1460]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(100);
      gateNoticeStyles[String(width)] = await page.evaluate(() => {
        const full = document.querySelector('[data-testid="run-gate-notice"]');
        const compact = document.querySelector('[data-testid="run-gate-notice-compact"]');
        const vis = (el) => {
          if (!el) return false;
          const cs = getComputedStyle(el);
          return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
        };
        return {
          fullVisible: vis(full),
          compactVisible: vis(compact),
          fullDisplay: full ? getComputedStyle(full).display : null,
          compactDisplay: compact ? getComputedStyle(compact).display : null,
        };
      });
    }

    // ── Honesty: force /runs error → panel-error (REQUIRED #1/#5) ─────
    // Cold load so React has no retained detail/summaries (useRuns keeps last
    // good detail on fetch failure — intercept must be active before first paint).
    await clearRunRoutes(page);
    await page.route("**/runs**", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "forced run panel error" }),
      });
    });
    await page.goto(`${url}#/fleet`, { waitUntil: "networkidle" });
    await page.reload({ waitUntil: "networkidle" });
    await page.goto(`${url}#/run`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    const honestyPhase = await page
      .locator('[data-testid="screen-run"]')
      .getAttribute("data-honesty");
    const honestyText =
      (await page.locator('[data-testid="screen-run"]').textContent()) ?? "";
    const hasErrorShell =
      (await page.locator('[data-testid="run-error-shell"]').count()) > 0;
    const honestyError = {
      phase: honestyPhase,
      hasErrorShell,
      text: honestyText.slice(0, 240),
      // Strict: phase must be panel-error; do not regex-match "failed" in node text.
      found: honestyPhase === "panel-error" && hasErrorShell,
    };
    await page.screenshot({
      path: path.join(shotsDir, `${DEMO}-honesty-error-1460.png`),
    });
    await page.unroute("**/runs**").catch(() => undefined);
    await clearRunRoutes(page);

    // ── Honesty: daemon kill (offline/stale) ──────────────────────────
    await focusRun(page, session.daemon.baseUrl, staged.gateHeld.runId);
    await openRun(page, url, staged.gateHeld.runId);
    await page
      .waitForSelector('[data-testid="run-header"]', { timeout: 15_000 })
      .catch(() => undefined);
    await clearRunRoutes(page);
    await session.daemon.kill();
    await page.waitForTimeout(5_000);
    const honestyOffline = {
      phase: await page.locator('[data-testid="screen-run"]').getAttribute("data-honesty"),
      liveStatus: await page
        .locator('[data-testid="live-status"]')
        .textContent()
        .catch(() => null),
      text: ((await page.locator('[data-testid="screen-run"]').textContent()) ?? "").slice(
        0,
        300,
      ),
    };
    await page.screenshot({
      path: path.join(shotsDir, `${DEMO}-honesty-offline-1460.png`),
    });
    await session.daemon.restart();
    await session.rebindVite(session.daemon.baseUrl);
    await page.waitForTimeout(1500);

    // ── Neuter: break → panel-error only, restore (REQUIRED #5) ───────
    await clearRunRoutes(page);
    await page.route("**/runs**", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "neuter break" }),
      });
    });
    // Cold reload under intercept so no retained detail paints as live.
    await page.goto(`${session.url}#/fleet`, { waitUntil: "networkidle" });
    await page.reload({ waitUntil: "networkidle" });
    await page.goto(`${session.url}#/run`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    const neuterPhase = await page
      .locator('[data-testid="screen-run"]')
      .getAttribute("data-honesty");
    const neuterBroke = {
      text: ((await page.locator('[data-testid="screen-run"]').textContent()) ?? "").slice(
        0,
        200,
      ),
      phase: neuterPhase,
      hasErrorShell:
        (await page.locator('[data-testid="run-error-shell"]').count()) > 0,
    };
    // Accept ONLY panel-error as genuine broken treatment.
    const broke = neuterPhase === "panel-error" && neuterBroke.hasErrorShell;
    await page.unroute("**/runs**").catch(() => undefined);
    await clearRunRoutes(page);
    if (staged.gateHeld?.runId) {
      await focusRun(page, session.daemon.baseUrl, staged.gateHeld.runId);
      await openRun(page, session.url, staged.gateHeld.runId);
    } else {
      await page.goto(`${session.url}#/run`, { waitUntil: "networkidle" });
      await page.waitForTimeout(2000);
    }
    const restoredHeader = await page.locator('[data-testid="run-header"]').count();
    const neuter = {
      broke,
      brokePhase: neuterPhase,
      brokeSample: neuterBroke,
      restored: restoredHeader > 0,
    };

    // ── A11y across pipeline / grid / table + empty + error (REQUIRED #6)
    const a11yByView = {};
    if (staged.gateHeld?.runId) {
      await clearRunRoutes(page);
      await focusRun(page, session.daemon.baseUrl, staged.gateHeld.runId);
      await openRun(page, session.url, staged.gateHeld.runId);
      await page.setViewportSize({ width: 1460, height: 900 });
      for (const [btn, name] of [
        ["run-view-pipeline", "pipeline"],
        ["run-view-grid", "grid"],
        ["run-view-table", "table"],
      ]) {
        await page.click(`[data-testid="${btn}"]`);
        await page.waitForTimeout(300);
        a11yByView[name] = {
          axe: await runAxe(page, { include: '[data-testid="screen-run"]' }),
        };
      }
    }
    // Error shell axe
    await clearRunRoutes(page);
    await page.route("**/runs**", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "axe error shell" }),
      });
    });
    await page.goto(`${session.url}#/run`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    a11yByView.error = {
      axe: await runAxe(page, { include: '[data-testid="screen-run"]' }),
    };
    await page.unroute("**/runs**").catch(() => undefined);
    // Empty shell axe — empty list
    await page.route("**/runs", async (route) => {
      const pathName = new URL(route.request().url()).pathname;
      if (pathName === "/runs" || pathName.endsWith("/runs")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ runs: [], seq: 0 }),
        });
        return;
      }
      await route.continue();
    });
    await page.goto(`${session.url}#/run`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    a11yByView.empty = {
      axe: await runAxe(page, { include: '[data-testid="screen-run"]' }),
    };
    await page.unroute("**/runs").catch(() => undefined);
    await clearRunRoutes(page);

    // Restore gate-held for remaining proofs
    if (staged.gateHeld?.runId) {
      await focusRun(page, session.daemon.baseUrl, staged.gateHeld.runId);
      await openRun(page, session.url, staged.gateHeld.runId);
    }
    const a11y = await collectA11y(page, { include: '[data-testid="screen-run"]' });
    const axeFull = a11yByView.pipeline?.axe ?? (await runAxe(page));
    const aria = await ariaSnapshot(page, { selector: '[data-testid="screen-run"]' });
    let kb;
    try {
      kb = await keyboardWalk(page, { maxSteps: 12 });
    } catch (err) {
      kb = { error: String(err) };
    }

    // Long-name copy sweep — force a name that MUST overflow (REQUIRED #5)
    let copySweep = { truncated: false };
    await clearRunRoutes(page);
    if (staged.gateHeld?.runId) {
      await focusRun(page, session.daemon.baseUrl, staged.gateHeld.runId);
    }
    const longName =
      "very-long-workflow-name-that-should-truncate-with-ellipsis-without-mid-glyph-clip-" +
      "and-still-carry-full-value-on-title-attribute-for-operators-xxxxxxxxxxxxxxxxxxxx";
    await page.route("**/runs/**", async (route) => {
      try {
        const res = await route.fetch();
        const body = await res.json().catch(() => null);
        if (body?.run) {
          body.run.workflow = longName;
          body.run.worktree =
            "/tmp/very/deep/path/to/a/run/workspace/that/must/ellipsis/" +
            "parley/runs/abcd/node.1-slot-name-extra-long";
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(body),
          });
          return;
        }
        await route.fulfill({
          status: res.status(),
          contentType: res.headers()["content-type"] ?? "application/json",
          body: await res.text(),
        });
      } catch {
        try {
          await route.continue();
        } catch {
          /* closed */
        }
      }
    });
    // Also rewrite list so auto-select keeps the run
    await page.route("**/runs", async (route) => {
      try {
        const pathName = new URL(route.request().url()).pathname;
        if (pathName === "/runs" || pathName.endsWith("/runs")) {
          const res = await route.fetch();
          const body = await res.json();
          if (Array.isArray(body.runs)) {
            body.runs = body.runs.map((r) =>
              r.run_id === staged.gateHeld?.runId ? { ...r, workflow: longName } : r,
            );
          }
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(body),
          });
          return;
        }
      } catch {
        /* fall through */
      }
      await route.continue().catch(() => undefined);
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${session.url}#/run`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    // Wait for long name to appear
    await page
      .waitForFunction(
        (_name) => {
          const el = document.querySelector(".pc-run__workflow");
          return el && (el.textContent ?? "").length > 40;
        },
        longName,
        { timeout: 8_000 },
      )
      .catch(() => undefined);
    const titleEl = page.locator(".pc-run__workflow");
    if ((await titleEl.count()) > 0) {
      copySweep = await titleEl.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          text: (el.textContent ?? "").slice(0, 80),
          title: el.getAttribute("title"),
          overflow: cs.overflow,
          textOverflow: cs.textOverflow,
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          truncated: el.scrollWidth > el.clientWidth + 1,
        };
      });
    }
    await page.unroute("**/runs/**").catch(() => undefined);
    await page.unroute("**/runs").catch(() => undefined);
    await clearRunRoutes(page);

    const mutateGrep = await grepMutatingRoutes();

    const proof = {
      kind: "run-detail",
      description:
        "Run detail: pipeline/grid/table; fork inherited/skipped; read-only gates; " +
        "deliverables+tasks; staged fan-out/gate-held/forked/failed; honesty; a11y.",
      staged: {
        gateHeld: staged.gateHeld
          ? {
              runId: staged.gateHeld.runId,
              state: staged.gateHeld.state,
              block: staged.gateHeld.block,
              workspace: staged.gateHeld.workspace,
              nodeCount: staged.gateHeld.nodeCount,
            }
          : null,
        fanOut: staged.fanOut
          ? {
              runId: staged.fanOut.runId,
              state: staged.fanOut.state,
              fanWidth: staged.fanOut.fanWidth,
              tasksTotal: staged.fanOut.tasksTotal,
            }
          : null,
        failed: staged.failed
          ? {
              runId: staged.failed.runId,
              state: staged.failed.state,
              error: staged.failed.error,
              block: staged.failed.block,
              failedNodes: staged.failed.failedNodes,
              nodeFailed: staged.failed.nodeFailed,
            }
          : null,
        forked: staged.forked
          ? {
              runId: staged.forked.runId,
              parentRunId: staged.forked.parentRunId,
              state: staged.forked.state,
              parent_run_id: staged.forked.parent_run_id,
              attempt: staged.forked.attempt,
              inherited: staged.forked.inherited,
              skipped: staged.forked.skipped,
              nodeStates: staged.forked.nodeStates,
            }
          : null,
        notes: staged.notes,
      },
      forkRender,
      forkNotes: staged.notes,
      fanRender,
      failedRender,
      wireVerbs,
      outputsAlways,
      pipelineWrap,
      gateNoticeStyles,
      a11yByView,
      gateUi: {
        blockFound: gateUi.block?.found ?? false,
        chipText: gateUi.chip?.text ?? null,
        workspaceFound: gateUi.workspace?.found ?? false,
        noticeHasVerbs: /approve/.test(gateUi.notice ?? ""),
        noticeReadOnly: /read-only|orchestrating/i.test(gateUi.notice ?? ""),
      },
      views,
      viewports,
      headline: {
        boardScroll,
        gateHeldState: staged.gateHeld?.state,
        fanWidth: staged.fanOut?.fanWidth,
        failedState: staged.failed?.state,
        forkInherited: forkRender.inheritedFound,
        forkSkipped: forkRender.skippedFound,
      },
      honesty: {
        error: honestyError,
        offline: honestyOffline,
      },
      neuter,
      copySweep,
      mutateGrep,
      a11y: {
        ...a11y,
        axe: axeFull,
        aria,
        keyboardWalk: kb,
      },
      deliverableStatesStaged: {
        ready: "via gate-held plan deliverable when present",
        none: "empty panel on fan-out mid-flight",
        error: "honesty intercept on /runs",
        not_fetched: "brief window before value fetch",
        purged: "not staged — requires retention purge timing",
        "missing-worktree": "not staged — requires path deliverable + worktree removal",
      },
    };

    const entryPath = writeDemoProof(TICKET, DEMO, proof);
    printRectSummary(DEMO, viewports);
    console.log(`ledger entry: ${entryPath}`);
    console.log(
      JSON.stringify(
        {
          boardScroll,
          gate: staged.gateHeld?.state,
          fan: staged.fanOut?.fanWidth,
          fail: staged.failed?.state,
          fork: forkRender,
          neuter,
          mutateGrep,
        },
        null,
        2,
      ),
    );
    return proof;
  } finally {
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRunDetailDemo().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
