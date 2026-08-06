/**
 * #349 — report file churn on the wire (files_changed per-file +/−).
 *
 * Pure helpers cover normalize / numstat / enrich; the integration case
 * drives a real fake-vendor submit_report through startServer and asserts
 * churn on the task envelope over HTTP and SSE.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Report, TaskEnvelope } from "@useparley/core";
import { homePaths } from "@useparley/core";
import {
  computeFileChurn,
  decodeNumstatPath,
  enrichReportFilesChanged,
  normalizeFileChangeEntry,
  normalizeFilesChanged,
  normalizeStoredReport,
  parseNumstat,
} from "../src/report.js";
import { startServer, type DaemonServer } from "../src/server.js";
import { makeGitRepo, withFakeAllowlist } from "./helpers.js";

const FAKE_VENDOR_BIN = fileURLToPath(
  new URL("../../cli/tests/fake-vendor.mjs", import.meta.url),
);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("normalizeFilesChanged / normalizeStoredReport (#349)", () => {
  it("turns path strings into path-only objects", () => {
    expect(normalizeFilesChanged(["a.ts", "b.ts"])).toEqual([
      { path: "a.ts" },
      { path: "b.ts" },
    ]);
  });

  it("carries optional added/removed on object entries", () => {
    expect(
      normalizeFilesChanged([
        { path: "a.ts", added: 3, removed: 1 },
        { path: "b.ts" },
      ]),
    ).toEqual([
      { path: "a.ts", added: 3, removed: 1 },
      { path: "b.ts" },
    ]);
  });

  it("preserves non-churn keys on custom-schema object entries", () => {
    // Operator --report-schema may put reason/reviewer/etc. on each file object.
    const entry = normalizeFileChangeEntry({
      path: "a.txt",
      reason: "refactor",
      reviewer: "kim",
      added: 7,
    });
    expect(entry).toEqual({
      path: "a.txt",
      reason: "refactor",
      reviewer: "kim",
      added: 7,
    });
  });

  it("drops empty paths and non-entries", () => {
    expect(normalizeFilesChanged(["", 42, { path: "" }, null])).toEqual([]);
  });

  it("passes stored reports through (strings or objects)", () => {
    const withStrings = {
      summary: "done",
      outcome: "success",
      files_changed: ["x.ts"],
    };
    expect(normalizeStoredReport(withStrings)).toEqual(withStrings);
    const withObjects = {
      summary: "done",
      outcome: "success",
      files_changed: [{ path: "x.ts", added: 1, removed: 0 }],
    };
    expect(normalizeStoredReport(withObjects)).toEqual(withObjects);
  });
});

describe("parseNumstat / decodeNumstatPath (#349)", () => {
  it("parses added/removed/path rows", () => {
    const map = parseNumstat("10\t3\tsrc/a.ts\n0\t2\tsrc/b.ts\n");
    expect(map.get("src/a.ts")).toEqual({ added: 10, removed: 3 });
    expect(map.get("src/b.ts")).toEqual({ added: 0, removed: 2 });
  });

  it("skips binary rows and resolves flat + braced rename targets", () => {
    expect(decodeNumstatPath("old.ts => new.ts")).toBe("new.ts");
    // Git's default braced form when old/new share a prefix — old parser
    // keyed on "new.ts}" and missed the real path.
    expect(decodeNumstatPath("src/{old.ts => new.ts}")).toBe("src/new.ts");
    expect(decodeNumstatPath("{a => b}/file.ts")).toBe("b/file.ts");
    expect(decodeNumstatPath("p/{a => b}/s.ts")).toBe("p/b/s.ts");

    // Default / decodeRenames: true — defensive raw numstat may contain renames.
    const map = parseNumstat(
      "-\t-\tpic.bin\n4\t0\told.ts => new.ts\n0\t0\tsrc/{old.ts => new.ts}\n",
    );
    expect(map.has("pic.bin")).toBe(false);
    expect(map.get("new.ts")).toEqual({ added: 4, removed: 0 });
    expect(map.get("src/new.ts")).toEqual({ added: 0, removed: 0 });
    // Old bug: braced form left a trailing "}" on the key.
    expect(map.has("new.ts}")).toBe(false);
  });

  // #362: --no-renames churn path must not apply rename-arrow decode.
  it("keeps literal paths with => when decodeRenames is false (both line orders)", () => {
    // Measured repro: b.txt +1/−0 and a file literally named "zz => b.txt" 0/−4.
    // With decode on, "zz => b.txt" becomes "b.txt" and overwrites (order-dependent).
    const literal = { decodeRenames: false as const };
    const arrowName = "zz => b.txt";

    const orderA = parseNumstat(`1\t0\tb.txt\n0\t4\t${arrowName}\n`, literal);
    expect(orderA.get("b.txt")).toEqual({ added: 1, removed: 0 });
    expect(orderA.get(arrowName)).toEqual({ added: 0, removed: 4 });
    expect(orderA.size).toBe(2);

    const orderB = parseNumstat(`0\t4\t${arrowName}\n1\t0\tb.txt\n`, literal);
    expect(orderB.get("b.txt")).toEqual({ added: 1, removed: 0 });
    expect(orderB.get(arrowName)).toEqual({ added: 0, removed: 4 });
    expect(orderB.size).toBe(2);
  });

  it("keeps braced-form literal filenames when decodeRenames is false", () => {
    const braced = "a {x => y} b.txt";
    const map = parseNumstat(`2\t1\t${braced}\n`, { decodeRenames: false });
    expect(map.get(braced)).toEqual({ added: 2, removed: 1 });
    // Would have decoded to "a y b.txt" under the rename path.
    expect(map.has("a y b.txt")).toBe(false);
  });
});

describe("computeFileChurn + enrichReportFilesChanged (#349)", () => {
  const scratch: string[] = [];

  afterEach(() => {
    for (const dir of scratch.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts modified tracked and new untracked files vs base", () => {
    const repo = makeGitRepo({ "src/a.ts": "one\ntwo\n" });
    scratch.push(repo);
    const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();

    // Modify tracked file: replace "two" with "two\nthree" → +1 −0-ish depending
    // on how we edit. Use an explicit rewrite for predictable numstat.
    fs.writeFileSync(path.join(repo, "src/a.ts"), "one\nTWO\nthree\n");
    // New untracked file: 2 lines.
    fs.writeFileSync(path.join(repo, "src/new.ts"), "alpha\nbeta\n");

    const churn = computeFileChurn(repo, base);
    expect(churn.get("src/a.ts")).toEqual({ added: 2, removed: 1 });
    expect(churn.get("src/new.ts")).toEqual({ added: 2, removed: 0 });
  });

  it("attaches churn to path-string files_changed; leaves custom bodies alone", () => {
    const repo = makeGitRepo({ "keep.txt": "x\n" });
    scratch.push(repo);
    const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    fs.writeFileSync(path.join(repo, "keep.txt"), "x\ny\n");

    const enriched = enrichReportFilesChanged(
      {
        summary: "touched keep",
        outcome: "success",
        files_changed: ["keep.txt"],
      },
      { cwd: repo, baseSha: base },
    ) as Report;
    expect(enriched.files_changed).toEqual([
      { path: "keep.txt", added: 1, removed: 0 },
    ]);

    // Custom schema that reuses a non-path files_changed value is untouched.
    const custom = { notes: "ok", files_changed: [{ not: "a path" }] };
    expect(
      enrichReportFilesChanged(custom, { cwd: repo, baseSha: base }),
    ).toEqual(custom);
  });

  it("keeps path strings when git context is missing (no rewrite)", () => {
    const payload = { summary: "ok", outcome: "success", files_changed: ["a.ts"] };
    expect(
      enrichReportFilesChanged(payload, { cwd: null, baseSha: null }),
    ).toEqual(payload);
  });

  it("carries child-supplied added/removed without overwriting", () => {
    const enriched = enrichReportFilesChanged(
      {
        summary: "ok",
        outcome: "success",
        files_changed: [{ path: "a.ts", added: 9, removed: 4 }],
      },
      { cwd: null, baseSha: null },
    ) as Report;
    expect(enriched.files_changed).toEqual([
      { path: "a.ts", added: 9, removed: 4 },
    ]);
  });

  it("preserves custom-schema keys when attaching churn counts", () => {
    const repo = makeGitRepo({ "a.txt": "old\n", "b.txt": "same\n" });
    scratch.push(repo);
    const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    // a.txt gains one line → +1 −0; b.txt listed but unchanged.
    fs.writeFileSync(path.join(repo, "a.txt"), "old\nnew\n");

    const enriched = enrichReportFilesChanged(
      {
        summary: "review notes",
        outcome: "success",
        files_changed: [
          { path: "a.txt", reason: "refactor", reviewer: "kim", added: 7 },
          { path: "b.txt", reason: "untouched but listed" },
        ],
      },
      { cwd: repo, baseSha: base },
    ) as {
      files_changed: Array<Record<string, unknown>>;
    };

    // Measured defect: reason/reviewer were stripped. Both must survive.
    expect(enriched.files_changed).toEqual([
      {
        path: "a.txt",
        reason: "refactor",
        reviewer: "kim",
        // Child-supplied added is kept (not overwritten by git's 1).
        added: 7,
        // Git fills missing removed.
        removed: 0,
      },
      {
        path: "b.txt",
        reason: "untouched but listed",
      },
    ]);
  });

  it("counts churn for non-ASCII paths (quotePath=false)", () => {
    const name = "ünï cøde.txt";
    const repo = makeGitRepo({ [name]: "one\n" });
    scratch.push(repo);
    const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    fs.writeFileSync(path.join(repo, name), "one\ntwo\n");

    const churn = computeFileChurn(repo, base);
    expect(churn.get(name)).toEqual({ added: 1, removed: 0 });

    const enriched = enrichReportFilesChanged(
      { summary: "unicode", outcome: "success", files_changed: [name] },
      { cwd: repo, baseSha: base },
    ) as Report;
    expect(enriched.files_changed).toEqual([
      { path: name, added: 1, removed: 0 },
    ]);
  });

  it("splits renames via --no-renames so braced arrow form never keys churn", () => {
    const repo = makeGitRepo({ "src/old.ts": "body\n" });
    scratch.push(repo);
    const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    // Rename in the worktree (git detects similarity).
    execFileSync("git", ["-C", repo, "mv", "src/old.ts", "src/new.ts"], {
      stdio: "ignore",
    });

    const churn = computeFileChurn(repo, base);
    // --no-renames → delete of old + add of new, not "src/{old.ts => new.ts}".
    expect(churn.has("src/{old.ts => new.ts}")).toBe(false);
    expect(churn.has("new.ts}")).toBe(false);
    expect(churn.get("src/old.ts")).toEqual({ added: 0, removed: 1 });
    expect(churn.get("src/new.ts")).toEqual({ added: 1, removed: 0 });
  });

  // #362: literal filenames that look like rename arrows must not collide.
  it("keeps churn under literal names containing => (measured #362 repro)", () => {
    const arrowName = "zz => b.txt";
    const bracedName = "a {x => y} b.txt";
    const repo = makeGitRepo({
      "b.txt": "old\n",
      [arrowName]: "1\n2\n3\n4\n",
      [bracedName]: "keep\n",
    });
    scratch.push(repo);
    const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();

    // b.txt: +1/−0; arrowName: delete all 4 lines; bracedName: +1/−0.
    fs.writeFileSync(path.join(repo, "b.txt"), "old\nnew\n");
    fs.writeFileSync(path.join(repo, arrowName), "");
    fs.writeFileSync(path.join(repo, bracedName), "keep\nmore\n");

    const churn = computeFileChurn(repo, base);
    expect(churn.get("b.txt")).toEqual({ added: 1, removed: 0 });
    expect(churn.get(arrowName)).toEqual({ added: 0, removed: 4 });
    expect(churn.get(bracedName)).toEqual({ added: 1, removed: 0 });
    // Decode would have collapsed arrowName → "b.txt" and braced → "a y b.txt".
    expect(churn.has("a y b.txt")).toBe(false);
  });

  it("drops empty path strings even when no churn rewrite is needed", () => {
    const enriched = enrichReportFilesChanged(
      {
        summary: "ok",
        outcome: "success",
        files_changed: ["a.txt", "", "a.txt", "z.txt"],
      },
      { cwd: null, baseSha: null },
    ) as Report;
    // Malformed-entry handling is independent of whether counts were attached.
    expect(enriched.files_changed).toEqual(["a.txt", "a.txt", "z.txt"]);
  });
});

// ---------------------------------------------------------------------------
// HTTP + SSE round-trip (fake vendor)
// ---------------------------------------------------------------------------

describe("report file churn round-trip over HTTP and SSE (#349)", () => {
  let home: string;
  let repo: string;
  let server: DaemonServer | null = null;
  const scratch: string[] = [];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-churn-home-"));
    scratch.push(home);
    // Commit the fake-vendor script so it lands in the parley worktree (linked
    // worktrees only see committed content).
    const actions = [
      {
        write_file: {
          path: "src/touched.ts",
          contents: "line1\nline2\nline3\n",
        },
      },
      {
        submit_report: {
          summary: "added touched.ts",
          outcome: "success",
          files_changed: ["src/touched.ts"],
        },
      },
    ];
    repo = makeGitRepo({
      "src/seed.ts": "seed\n",
      ".fake-vendor.json": JSON.stringify(actions),
    });
    scratch.push(repo);
    fs.writeFileSync(
      path.join(home, "parley.json"),
      JSON.stringify(withFakeAllowlist({})),
    );
    process.env.PARLEY_HOME = home;
    process.env.PARLEY_FAKE_VENDOR_BIN = FAKE_VENDOR_BIN;
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    for (const dir of scratch.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    delete process.env.PARLEY_FAKE_VENDOR_BIN;
    delete process.env.PARLEY_HOME;
  });

  async function waitFor(
    predicate: () => boolean | Promise<boolean>,
    timeoutMs = 15_000,
    intervalMs = 40,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error("waitFor timed out");
  }

  function parseSseFrames(raw: string): Array<{ event?: string; data: string }> {
    const frames: Array<{ event?: string; data: string }> = [];
    for (const block of raw.split("\n\n")) {
      if (block.trim() === "") continue;
      let event: string | undefined;
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) event = line.slice(6).trimStart();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length > 0) frames.push({ event, data: data.join("\n") });
    }
    return frames;
  }

  it("surfaces files_changed churn on the task envelope over HTTP and SSE", async () => {
    server = await startServer(homePaths(home));
    const base = `http://127.0.0.1:${server.port}`;

    // Open SSE before create so we cannot miss task.completed.
    const sseController = new AbortController();
    const sseChunks: string[] = [];
    const sseDone = (async () => {
      const res = await fetch(`${base}/events/stream`, {
        headers: { accept: "text/event-stream" },
        signal: sseController.signal,
      });
      if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          sseChunks.push(decoder.decode(value, { stream: true }));
        }
      } catch {
        /* aborted after assertion */
      }
    })();

    const create = await fetch(`${base}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "touch a file and report it",
        vendor: "fake",
        orchestrator_session_id: "orch-churn",
        cwd: repo,
        use_worktree: true,
      }),
    });
    expect(create.status).toBe(201);
    const ack = (await create.json()) as { task_id: string };
    const taskId = ack.task_id;

    await waitFor(async () => {
      const st = await fetch(`${base}/tasks/${taskId}`);
      const body = (await st.json()) as { task: TaskEnvelope };
      return body.task.state === "completed" || body.task.state === "failed";
    });

    // --- HTTP envelope ---
    const detail = await fetch(`${base}/tasks/${taskId}`);
    expect(detail.status).toBe(200);
    const httpBody = (await detail.json()) as { task: TaskEnvelope };
    expect(httpBody.task.state).toBe("completed");
    expect(httpBody.task.report).toMatchObject({
      summary: "added touched.ts",
      outcome: "success",
      files_changed: [{ path: "src/touched.ts", added: 3, removed: 0 }],
    });

    // List envelope too.
    const list = await fetch(`${base}/tasks`);
    const listBody = (await list.json()) as { tasks: TaskEnvelope[] };
    const listed = listBody.tasks.find((t) => t.task_id === taskId);
    expect(listed?.report?.files_changed).toEqual([
      { path: "src/touched.ts", added: 3, removed: 0 },
    ]);

    // --- SSE envelope ---
    await waitFor(() => {
      const raw = sseChunks.join("");
      return parseSseFrames(raw).some((f) => {
        if (f.event !== "task.completed") return false;
        try {
          const env = JSON.parse(f.data) as TaskEnvelope;
          return env.task_id === taskId;
        } catch {
          return false;
        }
      });
    }, 5_000);

    const completedFrame = parseSseFrames(sseChunks.join("")).find((f) => {
      if (f.event !== "task.completed") return false;
      try {
        return (JSON.parse(f.data) as TaskEnvelope).task_id === taskId;
      } catch {
        return false;
      }
    });
    expect(completedFrame).toBeDefined();
    const sseEnv = JSON.parse(completedFrame!.data) as TaskEnvelope;
    expect(sseEnv.report?.files_changed).toEqual([
      { path: "src/touched.ts", added: 3, removed: 0 },
    ]);

    sseController.abort();
    await sseDone.catch(() => undefined);
  });
});
