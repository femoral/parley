/**
 * Wiring guards — source-level proofs that the data layer actually calls the
 * wire surfaces it claims. Neuter by deleting a required call site; the suite
 * must go red. (See issue #352 acceptance: "Neuter proofs for wiring-guard tests.")
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/data");

function read(rel: string): string {
  return fs.readFileSync(path.join(dataDir, rel), "utf8");
}

describe("wiring guards (console data layer)", () => {
  it("useSnapshot bootstraps via bootstrapTaskStream (snapshot + SSE)", () => {
    const src = read("useSnapshot.ts");
    // Word-boundary so renaming the call (bootstrapTaskStream_NEUTERED) fails.
    expect(src).toMatch(/\bbootstrapTaskStream\b/);
    expect(src).toMatch(/client/);
    // Must keep full envelopes, not a reduced DTO strip of usage/duration.
    expect(src).toMatch(/TaskEnvelope/);
    expect(src).toMatch(/onEvent/);
  });

  it("useHealth polls client.health", () => {
    const src = read("useHealth.ts");
    expect(src).toMatch(/client\.health\(/);
  });

  it("useRuns hits listRuns and getRun", () => {
    const src = read("useRuns.ts");
    expect(src).toMatch(/client\.listRuns\(/);
    expect(src).toMatch(/client\.getRun\(/);
  });

  it("useRunners fetches GET /runners via fetchRunnersList", () => {
    const src = read("useRunners.ts");
    expect(src).toMatch(/fetchRunnersList/);
    expect(read("clientExtras.ts")).toMatch(/\/runners/);
  });

  it("useLogTail cursors client.logs", () => {
    const src = read("useLogTail.ts");
    expect(src).toMatch(/client\.logs\(/);
  });

  it("useMetrics calls client.metrics", () => {
    const src = read("useMetrics.ts");
    // Method may be chained across lines: `void client\n  .metrics(...)`.
    expect(src).toMatch(/\.metrics\(/);
  });

  it("useRunMetrics calls client.runMetrics (workflow dim)", () => {
    const src = read("useRunMetrics.ts");
    expect(src).toMatch(/\.runMetrics\(/);
    // Reject neutered renames that still contain the substring.
    expect(src).not.toMatch(/runMetrics_NEUTERED/);
  });

  it("useNodeTasks hits GET /runs/:ref/nodes/:node via fetchNodeDetail", () => {
    const src = read("useNodeTasks.ts");
    expect(src).toMatch(/fetchNodeDetail/);
    expect(src).toMatch(/filterTasksByRunId/);
    const extras = read("clientExtras.ts");
    expect(extras).toMatch(/\/runs\/\$\{encodeURIComponent\(runRef\)\}\/nodes\//);
  });

  it("token burn exposes retention bound and 24h window", () => {
    const src = read("projections/tokenBurn.ts");
    expect(src).toMatch(/\bretentionDays\b/);
    expect(src).toMatch(/\bTOKEN_BURN_WINDOW_MS\b/);
    expect(src).toMatch(/\bnormalizeUsage\b/);
  });

  it("files_changed handles string | object ReportFileEntry", () => {
    const src = read("projections/filesChanged.ts");
    expect(src).toMatch(/typeof entry === "string"/);
    expect(src).toMatch(/rec\.added/);
    expect(src).toMatch(/rec\.removed/);
  });

  it("queue context uses max_concurrent + blocking_cap + queue_position", () => {
    const src = read("projections/queueContext.ts");
    expect(src).toMatch(/max_concurrent/);
    expect(src).toMatch(/blocking_cap/);
    expect(src).toMatch(/queue_position/);
    expect(src).toMatch(/QUEUED/);
  });

  it("firehose joins run events to workflow from runs cache", () => {
    const src = read("projections/firehose.ts");
    expect(src).toMatch(/workflow/);
    expect(src).toMatch(/runsById/);
    expect(src).toMatch(/subject: "run"/);
  });

  it("honesty state machine covers required phases", () => {
    const src = read("honesty.ts");
    for (const phase of [
      "loading",
      "connecting",
      "offline",
      "stale-reconnecting",
      "panel-error",
      "empty",
    ]) {
      expect(src).toContain(`"${phase}"`);
    }
    expect(src).toMatch(/STALE_DEBOUNCE_MS/);
  });
});
