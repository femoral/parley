/**
 * End-to-end proof for #379: a configured vendor bin that does not resolve is
 * reported as itself, over the wire, on task create.
 *
 * The regression this pins: the daemon used to skip an unresolvable configured
 * bin silently, so the vendor merely went missing and the orchestrator agent
 * saw `no capable executor for vendor "fake"` — a message that names the
 * vendors which *did* register and sends the reader hunting for missing vendor
 * support instead of a bad path. The agent has to be able to relay the real
 * cause to a human, so the path has to be in the response body.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { homePaths } from "@useparley/core";
import { startServer, type DaemonServer } from "../src/server.js";
import { withFakeAllowlist } from "./helpers.js";

let home: string;
let cwd: string;
let server: DaemonServer | null = null;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-badbin-e2e-"));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "parley-badbin-task-"));
  fs.writeFileSync(path.join(cwd, ".fake-vendor.json"), JSON.stringify([{ exit: 0 }]));
  fs.writeFileSync(path.join(home, "parley.json"), JSON.stringify(withFakeAllowlist({})));
  process.env.PARLEY_HOME = home;
  server = null;
});

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
  delete process.env.PARLEY_FAKE_VENDOR_BIN;
  delete process.env.PARLEY_HOME;
});

describe("unresolvable vendor bin surfaces as itself (#379)", () => {
  it("names the bad path in the task-create error instead of blaming the vendor", async () => {
    const missing = path.join(home, "nope", "fake-vendor.mjs");
    process.env.PARLEY_FAKE_VENDOR_BIN = missing;

    server = await startServer(homePaths(home));
    const base = `http://127.0.0.1:${server.port}`;

    const res = await fetch(`${base}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "anything",
        vendor: "fake",
        cwd,
        orchestrator_session_id: "orch",
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };

    // The cause, in the body the orchestrator agent reads.
    expect(body.error).toContain(missing);
    expect(body.error).toContain("PARLEY_FAKE_VENDOR_BIN");
    expect(body.error).toContain("path does not exist");
    // Not the symptom that used to be all you got.
    expect(body.error).not.toContain("no capable executor");
  });

  it("records the same diagnosis in the daemon diag log at startup", async () => {
    const missing = path.join(home, "nope", "fake-vendor.mjs");
    process.env.PARLEY_FAKE_VENDOR_BIN = missing;

    server = await startServer(homePaths(home));

    const diag = fs.readFileSync(path.join(home, "diag.log"), "utf8");
    expect(diag).toContain("vendor-bin:");
    expect(diag).toContain(missing);
  });

  it("still boots and serves other vendors when a bin is misconfigured", async () => {
    // Non-fatal by design: a stale entry for an unused vendor must not take
    // the daemon down.
    process.env.PARLEY_FAKE_VENDOR_BIN = path.join(home, "nope", "fake-vendor.mjs");

    server = await startServer(homePaths(home));
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);

    expect(res.status).toBe(200);
  });
});
