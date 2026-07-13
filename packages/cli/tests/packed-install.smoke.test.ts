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
 * It is heavy (compiles native `better-sqlite3`, hits the registry) so it lives
 * behind generous timeouts and cleans the workspace `dist/` it produces.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
/** Packages that ship to the registry (ui is private, not in the CLI's graph). */
const PUBLISHABLE = ["core", "daemon", "cli"] as const;
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

  // Install the tarballs into a clean prefix — a real consumer install: npm runs
  // better-sqlite3's build script, and inter-package deps resolve as semver. The
  // stub manifest roots the install here (so npm does not walk up into the
  // workspace); hoisted layout puts the bin at node_modules/.bin/parley.
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
  // run built output against source-mode exports and break `pnpm parley`.
  for (const p of PUBLISHABLE) {
    fs.rmSync(path.join(REPO_ROOT, "packages", p, "dist"), { recursive: true, force: true });
  }
});

describe("packed-install smoke (#60)", () => {
  it("the installed bin runs built dist end-to-end and ships no source or dev deps", () => {
    // The published tarball is dist + bin + skills — never TypeScript source.
    for (const p of PUBLISHABLE) {
      const root = path.join(installed.prefix, "node_modules", "@useparley", p);
      expect(fs.existsSync(path.join(root, "dist"))).toBe(true);
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
      path.join(task, ".fake-vendor.json"),
      JSON.stringify([
        { emit: { type: "session", session_id: "packed-sess" } },
        { emit: { type: "message", text: "working from the installed bin" } },
        { emit: { type: "usage", input_tokens: 100, output_tokens: 25 } },
        { submit_report: { summary: "packed run ok", outcome: "success", files_changed: ["src/a.ts"] } },
      ]),
    );

    const stdout = execFileSync(
      installed.binPath,
      ["delegate", "-v", "fake", "-m", "fake-model-1", "-n", "packed", "--cwd", task, "--wait", "do the thing"],
      {
        encoding: "utf8",
        timeout: 60_000,
        env: {
          ...process.env,
          PARLEY_HOME: home,
          PARLEY_FAKE_VENDOR_BIN: FAKE_VENDOR_BIN,
          PARLEY_SESSION_ID: "packed-orch",
        },
      },
    );

    const envelope = JSON.parse(stdout);
    expect(envelope.state).toBe("completed");
    expect(envelope.vendor).toBe("fake");
    expect(envelope.model).toBe("fake-model-1");
    expect(envelope.session_id).toBe("packed-sess");
    expect(envelope.usage).toEqual({ input_tokens: 100, output_tokens: 25 });
    expect(envelope.report).toEqual({
      summary: "packed run ok",
      outcome: "success",
      files_changed: ["src/a.ts"],
    });
  });
});
