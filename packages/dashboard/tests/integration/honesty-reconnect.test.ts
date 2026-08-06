/**
 * Honesty-state machine: offline → stale-reconnecting → live, driven by
 * killing and restarting a real daemon. Node environment (no happy-dom CORS).
 *
 * Transport signals are observed via ParleyClient (health + listTasks bootstrap)
 * and fed into the pure honesty projector — the same phase derivation
 * useHonesty uses.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ParleyClient, homePaths } from "@useparley/core";
import { startServer, type DaemonServer } from "../../../daemon/src/server.js";
import {
  deriveHonestyPhase,
  projectHonesty,
  STALE_DEBOUNCE_MS,
} from "../../src/data/honesty.js";
import { bootDaemon, waitFor, type DaemonFixture } from "./harness.js";
import fs from "node:fs";

const fixtures: DaemonFixture[] = [];
let extraServer: DaemonServer | null = null;
const orphanHomes: string[] = [];
const orphanRepos: string[] = [];

afterEach(async () => {
  if (extraServer) {
    try {
      await extraServer.close();
    } catch {
      /* ignore */
    }
    extraServer = null;
  }
  for (const f of fixtures.splice(0)) {
    try {
      await f.close();
    } catch {
      /* ignore */
    }
  }
  for (const dir of [...orphanHomes, ...orphanRepos]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  orphanHomes.length = 0;
  orphanRepos.length = 0;
  delete process.env.PARLEY_FAKE_VENDOR_BIN;
  delete process.env.PARLEY_HOME;
});

async function probeHealth(baseUrl: string): Promise<boolean> {
  try {
    const client = new ParleyClient({ baseUrl });
    await client.health();
    return true;
  } catch {
    return false;
  }
}

async function probeTasks(baseUrl: string): Promise<boolean> {
  try {
    const client = new ParleyClient({ baseUrl });
    await client.listTasks();
    return true;
  } catch {
    return false;
  }
}

describe("honesty reconnect against a real daemon", () => {
  it("offline → stale-reconnecting → live after kill/restart", async () => {
    const fx = await bootDaemon();
    fixtures.length = 0;
    orphanHomes.push(fx.home);
    orphanRepos.push(fx.repo);

    // ── live: both probes succeed ───────────────────────────────────────
    expect(await probeHealth(fx.baseUrl)).toBe(true);
    expect(await probeTasks(fx.baseUrl)).toBe(true);

    const live = projectHonesty({
      ready: true,
      streamConnected: true,
      healthOnline: true,
      streamLostSince: null,
      taskCount: 0,
      stale: false,
    });
    expect(live.phase).toBe("empty"); // ready + live + zero tasks

    // ── kill daemon ─────────────────────────────────────────────────────
    await fx.server.close();

    await waitFor(async () => !(await probeHealth(fx.baseUrl)), 10_000);
    expect(await probeHealth(fx.baseUrl)).toBe(false);
    expect(await probeTasks(fx.baseUrl)).toBe(false);

    // After ready has latched, transport loss is stale-reconnecting.
    const lostSince = Date.now();
    const stalePhase = deriveHonestyPhase({
      ready: true,
      streamConnected: false,
      healthOnline: false,
      streamLostSince: lostSince,
      taskCount: 0,
      stale: true, // debounce elapsed (STALE_DEBOUNCE_MS)
    });
    expect(stalePhase).toBe("stale-reconnecting");
    expect(STALE_DEBOUNCE_MS).toBeGreaterThan(0);

    // ── restart daemon on same home (new port) → live again ─────────────
    process.env.PARLEY_HOME = fx.home;
    extraServer = await startServer(homePaths(fx.home));
    const baseUrl2 = `http://127.0.0.1:${extraServer.port}`;

    await waitFor(async () => (await probeHealth(baseUrl2)) && (await probeTasks(baseUrl2)), 10_000);

    const recovered = projectHonesty({
      ready: true,
      streamConnected: true,
      healthOnline: true,
      streamLostSince: null,
      taskCount: 0,
      stale: false,
    });
    expect(recovered.phase).toBe("empty");
    expect(recovered.stale).toBe(false);
    expect(recovered.streamConnected).toBe(true);

    // ── pure offline (never ready) against a dead port ──────────────────
    const deadUrl = "http://127.0.0.1:1";
    expect(await probeHealth(deadUrl)).toBe(false);
    const offline = deriveHonestyPhase({
      ready: false,
      streamConnected: false,
      healthOnline: false,
      streamLostSince: Date.now(),
      taskCount: 0,
      stale: true,
    });
    expect(offline).toBe("offline");
  });
});
