/**
 * Real-daemon harness for console verification.
 *
 * Boots `startServer(homePaths(home))` in-process (same pattern as
 * packages/daemon/tests/max-concurrent-wire.test.ts and report-file-churn),
 * with an isolated PARLEY_HOME + fake-vendor bin.
 *
 * Dynamic file-URL imports keep the harness free of package.json dep changes
 * while still exercising the real daemon module graph.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CORE_ENTRY, DAEMON_SERVER_ENTRY, FAKE_VENDOR_BIN } from "./paths.mjs";
import { scriptActions, writeFakeVendorScript } from "../scripts/library.mjs";

/**
 * Minimal fake-vendor allowlist so delegate is not deny-by-default (#185).
 * Mirrors packages/daemon/tests/helpers.ts withFakeAllowlist shape, inlined
 * so the harness never imports daemon test helpers.
 * @param {Record<string, unknown>} [body]
 */
export function withFakeAllowlist(body = {}) {
  const vendorsIn =
    typeof body.vendors === "object" && body.vendors !== null && !Array.isArray(body.vendors)
      ? /** @type {Record<string, unknown>} */ (body.vendors)
      : {};
  const fakeIn =
    typeof vendorsIn.fake === "object" &&
    vendorsIn.fake !== null &&
    !Array.isArray(vendorsIn.fake)
      ? /** @type {Record<string, unknown>} */ (vendorsIn.fake)
      : {};
  const { models: modelsOverride, ...fakeRest } = fakeIn;
  return {
    ...body,
    vendors: {
      ...vendorsIn,
      fake: {
        models:
          modelsOverride !== undefined
            ? modelsOverride
            : {
                "fake-model": {
                  efforts: ["low", "medium", "high"],
                  default: "medium",
                  hint: "verify harness default",
                },
              },
        ...fakeRest,
      },
    },
  };
}

/**
 * @typedef {object} DaemonHarness
 * @property {string} home
 * @property {number} port
 * @property {string} baseUrl
 * @property {() => Promise<void>} close
 * @property {(scriptName: string, opts?: object) => Promise<{ taskId: string, cwd: string }>} stageScript
 * @property {(taskId: string, timeoutMs?: number) => Promise<object>} waitTask
 * @property {() => Promise<void>} kill
 * @property {() => Promise<void>} restart
 */

/**
 * Start an isolated real daemon.
 * @param {object} [opts]
 * @param {Record<string, unknown>} [opts.config] merged into parley.json
 * @returns {Promise<DaemonHarness>}
 */
export async function startDaemonHarness(opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-verify-home-"));
  const configBody = withFakeAllowlist(opts.config ?? {});
  fs.writeFileSync(path.join(home, "parley.json"), JSON.stringify(configBody, null, 2));

  process.env.PARLEY_HOME = home;
  process.env.PARLEY_FAKE_VENDOR_BIN = FAKE_VENDOR_BIN;
  // Isolation stamp so we never attach to a developer hub (#130).
  process.env.PARLEY_DAEMON_ID = `verify-${path.basename(home)}`;

  const { homePaths } = await import(pathToFileURL(CORE_ENTRY).href);
  const { startServer } = await import(pathToFileURL(DAEMON_SERVER_ENTRY).href);

  /** @type {{ port: number, close: () => Promise<void> } | null} */
  let server = await startServer(homePaths(home));

  const baseUrl = () => `http://127.0.0.1:${server.port}`;

  /**
   * Stage a named fake-vendor action script and POST /tasks.
   * @param {string} scriptName
   * @param {object} [stageOpts]
   */
  async function stageScript(scriptName, stageOpts = {}) {
    if (!server) throw new Error("daemon is not running");
    const actions = scriptActions(scriptName);
    const cwd = writeFakeVendorScript(actions, stageOpts.files);
    const res = await fetch(`${baseUrl()}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: stageOpts.prompt ?? `verify harness: ${scriptName}`,
        vendor: "fake",
        model: "fake-model",
        effort: stageOpts.effort ?? "medium",
        orchestrator_session_id: stageOpts.session ?? "verify-orch",
        cwd,
        use_worktree: stageOpts.useWorktree === true,
        ...(stageOpts.extraBody ?? {}),
      }),
    });
    if (res.status !== 201) {
      const text = await res.text();
      throw new Error(`POST /tasks failed: ${res.status} ${text}`);
    }
    const ack = /** @type {{ task_id: string }} */ (await res.json());
    return { taskId: ack.task_id, cwd };
  }

  /**
   * Poll GET /tasks/:id until a terminal or target state, or timeout.
   * @param {string} taskId
   * @param {number} [timeoutMs]
   * @param {(task: object) => boolean} [predicate]
   */
  async function waitTask(taskId, timeoutMs = 20_000, predicate) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!server) throw new Error("daemon is not running");
      const res = await fetch(`${baseUrl()}/tasks/${taskId}`);
      if (res.ok) {
        const body = /** @type {{ task: object }} */ (await res.json());
        const task = body.task;
        if (predicate) {
          if (predicate(task)) return task;
        } else {
          const state = /** @type {{ state?: string }} */ (task).state;
          if (
            state === "completed" ||
            state === "failed" ||
            state === "cancelled" ||
            state === "awaiting_answer" ||
            state === "stalled" ||
            state === "queued"
          ) {
            return task;
          }
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`waitTask timed out for ${taskId}`);
      }
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  async function kill() {
    if (!server) return;
    await server.close();
    server = null;
  }

  async function restart() {
    if (server) await server.close();
    process.env.PARLEY_HOME = home;
    process.env.PARLEY_FAKE_VENDOR_BIN = FAKE_VENDOR_BIN;
    process.env.PARLEY_DAEMON_ID = `verify-${path.basename(home)}`;
    server = await startServer(homePaths(home));
  }

  async function close() {
    if (server) {
      try {
        // server.close waits for open sockets; bound it so demos never hang.
        await Promise.race([
          server.close(),
          new Promise((resolve) => setTimeout(resolve, 3_000)),
        ]);
      } catch {
        /* ignore */
      }
      server = null;
    }
    delete process.env.PARLEY_FAKE_VENDOR_BIN;
    // Leave PARLEY_HOME for any late readers; clear isolation id.
    delete process.env.PARLEY_DAEMON_ID;
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore busy tmp */
    }
  }

  return {
    home,
    get port() {
      if (!server) throw new Error("daemon is not running");
      return server.port;
    },
    get baseUrl() {
      return baseUrl();
    },
    close,
    stageScript,
    waitTask,
    kill,
    restart,
  };
}
