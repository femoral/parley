/** #400: real daemon, actual shell controls, bounded requests and viewport proofs. */
import fs from "node:fs";
import assert from "node:assert/strict";
import { openVerifySession } from "../lib/session.mjs";
import { runAxe } from "../lib/a11y.mjs";
import { openDatabase, insertTask, insertRun, writeTaskState } from "../../../daemon/src/db.ts";
import { homePaths } from "../../../core/src/home.ts";

const session = await openVerifySession();
const db = openDatabase(homePaths(session.daemon.home));
const shots = fs.mkdtempSync("/tmp/parley-pagination-proof-");
try {
  db.exec("BEGIN");
  for (let i = 0; i < 130; i++) {
    const id = String(i).padStart(4, "0");
    insertTask(db, { id: `page-t${id}`, name: `Task ${id}`, vendor: "fake", model: null, effort: null, profile: null, repo: null, cwd: session.daemon.home, prompt: "Pagination proof", orchestrator_session_id: i % 2 ? "session-a" : "session-b", worktree: null, branch: null, base_sha: null, sandbox: "workspace", network: false, answer_timeout_ms: null, report_schema: null, size: null, difficulty: null, type: "other" });
    writeTaskState(db, `page-t${id}`, i % 3 ? "completed" : "failed", {});
    insertRun(db, { id: `page-r${id}`, workflow: "pagination", version: 1, type: "other", workspace: "scratch", repo: null, current_node: null, state: i % 3 ? "completed" : "failed", orchestrator_session_id: i % 2 ? "session-a" : "session-b" });
  }
  db.exec("COMMIT");
  for (const [id, state] of [["0001", "running"], ["0002", "awaiting_answer"], ["0004", "stalled"], ["0005", "queued"]]) {
    writeTaskState(db, `page-t${id}`, state, {});
  }
  db.prepare("UPDATE runs SET state = 'running' WHERE id = ?").run("page-r0001");
  const { page } = session;
  const requests = [];
  page.on("request", (request) => requests.push(new URL(request.url())));
  await page.goto(`${session.url}/#/fleet`);
  const taskRows = page.locator('[data-testid="fleet-tasks"] [role="row"][data-testid]');
  await taskRows.first().waitFor();
  assert.equal(await taskRows.count(), 50);
  const first = await taskRows.first().getAttribute("data-testid");
  await page.getByRole("navigation", { name: "tasks pagination", exact: true }).getByRole("button", { name: "Next", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="tasks pagination"]')?.textContent.includes("Page 2"));
  await page.waitForFunction((id) => document.querySelector('[data-testid="fleet-tasks"] [role="row"][data-testid]')?.getAttribute("data-testid") !== id, first);
  assert.match(await page.getByRole("navigation", { name: "runs pagination", exact: true }).textContent(), /Page 1/);
  await page.getByTestId("rail-state-failed").click();
  await page.waitForFunction(() => document.querySelector('[aria-label="tasks pagination"]')?.textContent.includes("44 tasks"));
  assert.equal(await taskRows.count(), 44);
  assert.equal(await taskRows.locator('[data-state="running"]').count(), 0);
  await page.getByTestId("rail-state-gate").click();
  await page.getByText("No tasks match this scope.").waitFor();
  await page.getByTestId("rail-state-all").click();
  await taskRows.first().waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-label="tasks pagination"]')?.textContent.includes("Page 1"));
  for (const state of ["running", "awaiting_answer", "stalled", "queued"]) {
    await page.getByTestId(`rail-state-${state}`).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="tasks pagination"]')?.textContent.includes("1 tasks"));
    assert.equal(await taskRows.count(), 1);
    await page.waitForFunction((n) => document.querySelector('[aria-label="runs pagination"]')?.textContent.includes(`${n} runs`), state === "running" ? 1 : 0);
  }
  await page.getByTestId("rail-state-running").click();
  await page.waitForFunction(() => document.querySelector('[aria-label="tasks pagination"]')?.textContent.includes("1 tasks"));
  writeTaskState(db, "page-t0001", "completed", {});
  await page.waitForFunction(() => document.querySelector('[aria-label="tasks pagination"]')?.textContent.includes("0 tasks"));
  await page.getByTestId("rail-state-all").click();
  await page.getByTestId("rail-scope-select").selectOption("session-a");
  await page.waitForFunction(() => document.querySelector('[aria-label="tasks pagination"]')?.textContent.includes("65 tasks"));
  await page.getByTestId("rail-state-failed").click();
  await page.waitForFunction(() => document.querySelector('[aria-label="tasks pagination"]')?.textContent.includes("22 tasks"));
  await page.getByTestId("rail-state-all").click();
  await page.waitForFunction(() => document.querySelector('[aria-label="tasks pagination"]')?.textContent.includes("65 tasks"));
  await page.getByTestId("rail-scope-select").selectOption("all");
  await page.waitForFunction(() => document.querySelector('[aria-label="tasks pagination"]')?.textContent.includes("130 tasks"));
  for (const width of [1280, 1460, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `${shots}/fleet-${width}.png`, fullPage: true });
    const geometry = await page.evaluate(() => ({ viewport: innerWidth, body: document.documentElement.scrollWidth, controls: [...document.querySelectorAll('.pc-page-controls')].map((e) => ({ width: e.clientWidth, scrollWidth: e.scrollWidth, height: e.clientHeight, bottom: e.getBoundingClientRect().bottom })) }));
    assert.ok(geometry.body <= width, JSON.stringify(geometry));
    assert.ok(geometry.controls.every((c) => c.scrollWidth <= c.width), JSON.stringify(geometry));
    assert.ok(geometry.controls.every((c) => c.height >= 30 && c.bottom < 900), JSON.stringify(geometry));
    console.log(JSON.stringify({ width, geometry }));
  }
  // Allow the regular refresh cadence; it must not resurrect legacy full lists.
  await page.waitForTimeout(3200);
  assert.ok(!requests.some((url) => url.pathname === "/tasks" || url.pathname === "/runs"));
  const axe = await runAxe(page, { include: ".pc-page-controls" });
  assert.equal(axe.violations.length, 0, JSON.stringify(axe.violations));
  await Promise.all([page.waitForResponse((response) => response.url().endsWith("/runs/page-r0000") && response.status() === 200), page.goto(`${session.url}/#/run/page-r0000`)]);
  assert.ok(page.url().endsWith("#/run/page-r0000"), "off-page run selection was replaced");
  await Promise.all([page.waitForResponse((response) => response.url().endsWith("/tasks/page-t0000") && response.status() === 200), page.goto(`${session.url}/#/task/page-t0000`)]);
  assert.ok(page.url().endsWith("#/task/page-t0000"), "off-page task selection was replaced");
  console.log(JSON.stringify({ screenshots: shots, fleetRequests: requests.filter((u) => u.pathname.startsWith("/fleet/")).length }));
} finally { db.close(); await session.close(); }
