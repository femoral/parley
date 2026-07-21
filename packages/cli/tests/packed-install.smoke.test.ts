import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FAKE_VENDOR_BIN } from "./helpers.js";

/**
 * Packed-install smoke test (#60): the proof that the *published* artifact runs.
 *
 * It builds every publishable package, `pnpm pack`s them, installs the tarballs
 * into a throwaway prefix with plain `npm install` (no workspace, no dev deps),
 * and drives the real installed `parley` bin through a full delegate → report
 * round-trip against the fake vendor. This exercises the published seams the
 * source-level suite cannot: the bin running built `dist/` (never TypeScript),
 * the daemon spawning from built `dist/main.js` with no `tsx`, and `workspace:*`
 * deps resolving as ordinary semver between the packed tarballs.
 *
 * `ui` rides along as of #70's publish flip: installed into the *same* hoisted
 * prefix as `cli`/`daemon` (never a dependency of either — the whole point of
 * an optional install), it proves the "install cli + ui, zero config" story
 * end to end. The daemon's discovery walks node_modules ancestry from two
 * bases (docs/spec/ui-interface-contract.md): the parley home dir (unused
 * here — this test's `PARLEY_HOME` is a bare tmpdir with no node_modules of
 * its own) and the daemon package's own installed location, whose ancestry
 * *does* reach this hoisted prefix's `node_modules/@useparley/ui` — so this
 * specifically exercises that second resolution tier against a real packed
 * tarball, which `packages/cli/tests/ui.test.ts`'s symlink-based fixtures
 * don't (they always install under the home dir, tier one).
 *
 * It is heavy (hits the registry for transitive deps) so it lives behind
 * generous timeouts and cleans the workspace `dist`/`www` it produces.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
/** Packages that ship to the registry. */
const PUBLISHABLE = ["core", "daemon", "cli", "ui"] as const;
/** `ui`'s build output directory is `www` (Vite), not `dist` (tsdown) — see
 * packages/ui/vite.config.ts. */
const BUNDLE_DIR: Record<(typeof PUBLISHABLE)[number], string> = {
  core: "dist",
  daemon: "dist",
  cli: "dist",
  ui: "www",
};
/** Dev-only tooling that must never appear in a consumer's install tree. */
const DEV_ONLY = ["tsx", "tsdown", "vitest", "typescript"];

const BUILD_TIMEOUT = 600_000;

interface Installed {
  prefix: string;
  binPath: string;
}

let scratch: string;
let installed: Installed;
const homes: string[] = [];

/** Run a command, inheriting the environment, failing loudly on non-zero exit. */
function run(cmd: string, args: string[], cwd: string): void {
  execFileSync(cmd, args, { cwd, stdio: "pipe", timeout: BUILD_TIMEOUT });
}

/** Kill any detached daemon a smoke home spawned, then remove the home. */
function cleanupHome(home: string): void {
  try {
    const discovery = JSON.parse(fs.readFileSync(path.join(home, "daemon.json"), "utf8")) as {
      pid: number;
    };
    try {
      process.kill(-discovery.pid, "SIGKILL");
    } catch {
      try {
        process.kill(discovery.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* no daemon recorded */
  }
  fs.rmSync(home, { recursive: true, force: true });
}

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "parley-packed-"));
  const tarballs = path.join(scratch, "tarballs");
  fs.mkdirSync(tarballs);

  // Build only the CLI's publishable graph. tsdown externalizes workspace deps,
  // so build order is irrelevant and they need not be built first.
  run(
    "pnpm",
    [
      "-r",
      ...PUBLISHABLE.flatMap((p) => ["--filter", `@useparley/${p}`]),
      "build",
    ],
    REPO_ROOT,
  );

  // Pack each package; pnpm rewrites `workspace:*` to concrete versions and
  // swaps in publishConfig.exports (→ dist) as it would on publish.
  const tgz: string[] = [];
  for (const p of PUBLISHABLE) {
    run("pnpm", ["pack", "--pack-destination", tarballs], path.join(REPO_ROOT, "packages", p));
    const file = fs.readdirSync(tarballs).find((f) => f.startsWith(`useparley-${p}-`));
    if (!file) throw new Error(`pnpm pack produced no tarball for ${p}`);
    tgz.push(path.join(tarballs, file));
  }

  // Install the tarballs into a clean prefix — a real consumer install with no
  // native deps (daemon uses built-in node:sqlite) and inter-package deps
  // resolving as semver. The stub manifest roots the install here (so npm does
  // not walk up into the workspace); hoisted layout puts the bin at
  // node_modules/.bin/parley.
  const prefix = path.join(scratch, "prefix");
  fs.mkdirSync(prefix);
  fs.writeFileSync(
    path.join(prefix, "package.json"),
    JSON.stringify({ name: "parley-packed-smoke", version: "0.0.0", private: true }),
  );
  execFileSync(
    "npm",
    ["install", ...tgz, "--prefix", prefix, "--no-audit", "--no-fund", "--install-strategy=hoisted"],
    { cwd: prefix, stdio: "pipe", timeout: BUILD_TIMEOUT },
  );

  installed = { prefix, binPath: path.join(prefix, "node_modules", ".bin", "parley") };
}, BUILD_TIMEOUT);

afterAll(() => {
  for (const home of homes.splice(0)) cleanupHome(home);
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  // Leave the workspace as we found it: `dist/` present would make the dev bin
  // run built output against source-mode exports and break `pnpm parley`. `ui`
  // is deliberately excluded — its `www/` isn't a dev-mode switch (unlike
  // `dist/` for the tsdown packages) and the suite's global setup builds it
  // once and expects it to persist for `packages/cli/tests/ui.test.ts`.
  for (const p of PUBLISHABLE) {
    if (p === "ui") continue;
    fs.rmSync(path.join(REPO_ROOT, "packages", p, "dist"), { recursive: true, force: true });
  }
});

describe("packed-install smoke (#60, ui install #70)", () => {
  it("the installed bin runs built dist end-to-end and ships no source or dev deps", async () => {
    // The published tarball is its bundle dir + bin + skills — never TypeScript
    // source (ui's bundle dir is Vite's `www`, everything else is tsdown's `dist`).
    for (const p of PUBLISHABLE) {
      const root = path.join(installed.prefix, "node_modules", "@useparley", p);
      expect(fs.existsSync(path.join(root, BUNDLE_DIR[p]))).toBe(true);
      expect(fs.existsSync(path.join(root, "src"))).toBe(false);
    }
    expect(fs.existsSync(path.join(installed.prefix, "node_modules", "@useparley", "cli", "dist", "index.js"))).toBe(
      true,
    );

    // No dev-only tooling leaked into the consumer's install tree.
    for (const dep of DEV_ONLY) {
      expect(fs.existsSync(path.join(installed.prefix, "node_modules", dep))).toBe(false);
    }

    // Drive a real delegate → report round-trip through the installed bin. The
    // daemon it spawns must come up from built dist/main.js (no tsx present).
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-packed-home-"));
    homes.push(home);
    const task = fs.mkdtempSync(path.join(os.tmpdir(), "parley-packed-task-"));
    homes.push(task); // cleanupHome rm -rf's it too (no daemon.json → harmless)
    fs.writeFileSync(
      path.join(home, "parley.json"),
      JSON.stringify({
        vendors: {
          fake: {
            models: {
              "fake-model-1": {
                efforts: ["low", "medium", "high"],
                default: "medium",
              },
            },
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(task, ".fake-vendor.json"),
      JSON.stringify([
        { emit: { type: "session", session_id: "packed-sess" } },
        { emit: { type: "message", text: "working from the installed bin" } },
        { emit: { type: "usage", input_tokens: 100, output_tokens: 25 } },
        { submit_report: { summary: "packed run ok", outcome: "success", files_changed: ["src/a.ts"] } },
      ]),
    );

    const env = {
      ...process.env,
      PARLEY_HOME: home,
      PARLEY_FAKE_VENDOR_BIN: FAKE_VENDOR_BIN,
      PARLEY_SESSION_ID: "packed-orch",
    };
    const stdout = execFileSync(
      installed.binPath,
      [
        "delegate",
        "-v",
        "fake",
        "-m",
        "fake-model-1",
        "--effort",
        "low",
        "-n",
        "packed",
        "--cwd",
        task,
        "do the thing",
      ],
      { encoding: "utf8", timeout: 60_000, env },
    );

    const ack = JSON.parse(stdout);
    expect(ack.task_id).toBeTruthy();
    // Poll status until completed (packed bin has no waitForState helper).
    const deadline = Date.now() + 30_000;
    let row: Record<string, unknown> | null = null;
    while (Date.now() < deadline) {
      const st = execFileSync(installed.binPath, ["status", "packed", "--json"], {
        encoding: "utf8",
        timeout: 10_000,
        env,
      });
      row = JSON.parse(st) as Record<string, unknown>;
      if (row.state === "completed") break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    expect(row?.state).toBe("completed");
    // status --json carries the completed fields (watch exits 6, which would
    // make execFileSync throw).
    expect(row!.vendor).toBe("fake");
    expect(row!.model).toBe("fake-model-1");
    expect(row!.session_id).toBe("packed-sess");
    expect(row!.usage).toEqual({ input_tokens: 100, output_tokens: 25 });
    expect(row!.report).toEqual({
      summary: "packed run ok",
      outcome: "success",
      files_changed: ["src/a.ts"],
    });

    // The delegate call above spawned the daemon detached against `home`
    // (it's still running — `cleanupHome` kills it in `afterAll`); `daemon.json`
    // is the discovery file it published (see @useparley/core's `Discovery`).
    // `home` is a bare tmpdir with no node_modules of its own, so if the
    // cockpit is served here it can only be via the daemon's *own* installed
    // location resolving `@useparley/ui` as a hoisted sibling in this prefix
    // — the "install cli + ui, zero config" acceptance criterion (#70),
    // exercised against a real packed tarball rather than a symlinked fixture.
    const discovery = JSON.parse(fs.readFileSync(path.join(home, "daemon.json"), "utf8")) as { port: number };
    const root = await fetch(`http://127.0.0.1:${discovery.port}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toMatch(/text\/html/);
    expect(await root.text()).toContain("Parley Cove");
  });
});
