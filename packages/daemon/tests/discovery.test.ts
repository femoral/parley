/**
 * #384 — live-discovery liveness includes pid-recycle defence.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homePaths, type Discovery } from "@useparley/core";
import { liveDiscovery, writeDiscovery } from "../src/discovery.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-disc-"));
  dirs.push(home);
  return homePaths(home);
}

function record(over: Partial<Discovery> = {}): Discovery {
  return {
    port: 59999,
    pid: process.pid,
    started_at: new Date().toISOString(),
    ...over,
  };
}

describe("liveDiscovery (#384)", () => {
  it("treats a live recycled pid as stale", () => {
    const paths = tmpHome();
    writeDiscovery(
      paths,
      record({ pid: process.pid, started_at: "2000-01-01T00:00:00.000Z" }),
    );
    expect(liveDiscovery(paths)).toBeNull();
  });

  it("accepts a valid advertisement for this live process", () => {
    const paths = tmpHome();
    const discovery = record({ pid: process.pid, started_at: new Date().toISOString() });
    writeDiscovery(paths, discovery);
    expect(liveDiscovery(paths)).toEqual(discovery);
  });

  it("treats a dead-pid advertisement as stale", () => {
    const paths = tmpHome();
    writeDiscovery(paths, record({ pid: 2_147_483_646 }));
    expect(liveDiscovery(paths)).toBeNull();
  });

  it("trusts pid liveness when start time is unreadable", () => {
    const paths = tmpHome();
    const discovery = record({
      pid: process.pid,
      started_at: "2000-01-01T00:00:00.000Z",
    });
    writeDiscovery(paths, discovery);
    expect(liveDiscovery(paths, { readStartTime: () => null })).toEqual(discovery);
  });
});
