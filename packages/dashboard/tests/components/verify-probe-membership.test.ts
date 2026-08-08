/**
 * #376 — contrast/type-size gates must pin the set of things they measure.
 *
 * #375 closed this for shell-chrome. These gates had the same hole: they
 * iterated whatever the measurement recorded, so deleting a probe left a
 * smaller ledger and a green gate. metrics-board additionally skipped probes
 * whose selector matched nothing (#374's fix never reached it).
 *
 * Each block asserts the *distinct* failure message, not just "it threw" —
 * otherwise the failure modes can collapse into each other unnoticed.
 */
import { describe, expect, it } from "vitest";
import { readLedgerFixture, runVerifyGate } from "../helpers/verify-gate";

type Probe = {
  found?: boolean;
  ratio?: number;
  wcagAA?: boolean;
  fontSizePx?: number;
};
type Contrast = Record<string, Probe>;

const ABSENT = /probes absent from ledger/;
const NOT_FOUND = /probe missing/;

/** Pull a demo block out of a ledger fixture, asserting the fixture shape. */
function demoBlock<T extends Record<string, unknown>>(
  ticket: string,
  demo: string,
): { ledger: Record<string, unknown>; block: T } {
  const ledger = readLedgerFixture<{ demos: Record<string, T | undefined> }>(ticket);
  const block = ledger.demos[demo];
  if (!block) throw new Error(`fixture: ${ticket} has no ${demo} demo`);
  return { ledger: ledger as unknown as Record<string, unknown>, block };
}

function contrastOf(block: { contrast?: Contrast }): Contrast {
  if (!block.contrast) throw new Error("fixture: demo has no contrast block");
  return block.contrast;
}

describe("console-rails contrast probe membership (#376)", () => {
  const demoModule = "console-rails.mjs";
  const gate = "consoleRailsGates";
  const load = () => demoBlock<{ contrast?: Contrast }>("issue-363", "console-rails");

  it("passes on the committed ledger", () => {
    const { ledger } = load();
    expect(runVerifyGate({ demo: demoModule, gate, ledger })).toMatchObject({ threw: false });
  });

  it("fails when a probe id is deleted from the ledger", () => {
    const { ledger, block } = load();
    const contrast = contrastOf(block);
    expect(contrast["rail-chip-label"]).toBeTruthy();
    delete contrast["rail-chip-label"];

    const r = runVerifyGate({ demo: demoModule, gate, ledger });
    expect(r.threw).toBe(true);
    expect(r.message).toMatch(ABSENT);
    expect(r.message).toMatch(/rail-chip-label/);
  });

  it("fails closed when a probe is present but not found", () => {
    const { ledger, block } = load();
    contrastOf(block)["rail-chip-label"] = { found: false };

    const r = runVerifyGate({ demo: demoModule, gate, ledger });
    expect(r.threw).toBe(true);
    expect(r.message).toMatch(NOT_FOUND);
    expect(r.message).toMatch(/rail-chip-label/);
  });

  it("still fails an AA regression on small text", () => {
    const { ledger, block } = load();
    contrastOf(block)["rail-chip-label"] = {
      found: true,
      fontSizePx: 10,
      ratio: 1.4,
      wcagAA: false,
    };

    const r = runVerifyGate({ demo: demoModule, gate, ledger });
    expect(r.threw).toBe(true);
    expect(r.message).toMatch(/AA fail/);
  });

  it("tolerates an extra probe id beyond the required set", () => {
    const { ledger, block } = load();
    contrastOf(block)["rail-brand-new"] = { found: true, ratio: 9, wcagAA: true };

    expect(runVerifyGate({ demo: demoModule, gate, ledger })).toMatchObject({ threw: false });
  });
});

describe("metrics-board contrast probe membership (#376)", () => {
  const demoModule = "metrics-board.mjs";
  const gate = "metricsBoardGates";
  const load = () => demoBlock<{ contrast?: Contrast }>("issue-358", "metrics-board");

  it("passes on the committed ledger", () => {
    const { ledger } = load();
    expect(runVerifyGate({ demo: demoModule, gate, ledger })).toMatchObject({ threw: false });
  });

  it("fails when a probe id is deleted from the ledger", () => {
    const { ledger, block } = load();
    const contrast = contrastOf(block);
    expect(contrast.distLabel).toBeTruthy();
    delete contrast.distLabel;

    const r = runVerifyGate({ demo: demoModule, gate, ledger });
    expect(r.threw).toBe(true);
    expect(r.message).toMatch(ABSENT);
    expect(r.message).toMatch(/distLabel/);
  });

  it("fails closed on a probe whose selector matched nothing (#374)", () => {
    const { ledger, block } = load();
    contrastOf(block).distLabel = { found: false };

    const r = runVerifyGate({ demo: demoModule, gate, ledger });
    expect(r.threw).toBe(true);
    expect(r.message).toMatch(NOT_FOUND);
    expect(r.message).toMatch(/distLabel/);
  });

  it("requires panelTitle to be measured, not silently absent", () => {
    const { ledger, block } = load();
    const contrast = contrastOf(block);
    // Regression guard: this probe pointed at a class that never rendered and
    // sat found:false in the committed ledger, hidden by the old found guard.
    expect(contrast.panelTitle?.found).toBe(true);

    contrast.panelTitle = { found: false };
    const r = runVerifyGate({ demo: demoModule, gate, ledger });
    expect(r.threw).toBe(true);
    expect(r.message).toMatch(/panelTitle/);
  });

  it("still fails an AA regression", () => {
    const { ledger, block } = load();
    contrastOf(block).distLabel = { found: true, ratio: 1.1, wcagAA: false };

    const r = runVerifyGate({ demo: demoModule, gate, ledger });
    expect(r.threw).toBe(true);
    expect(r.message).toMatch(/contrast fail/);
  });

  it("tolerates an extra probe id beyond the required set", () => {
    const { ledger, block } = load();
    contrastOf(block).brandNew = { found: true, ratio: 9, wcagAA: true };

    expect(runVerifyGate({ demo: demoModule, gate, ledger })).toMatchObject({ threw: false });
  });
});

describe("metrics-board type-size floor selector coverage (#376)", () => {
  const demoModule = "metrics-board.mjs";
  const gate = "metricsBoardGates";
  type Block = { chartLabels?: { selectorCoverage?: Record<string, number> } };
  const load = () => demoBlock<Block>("issue-358", "metrics-board");

  it("records coverage for every chart-label selector", () => {
    const { block } = load();
    const cov = block.chartLabels?.selectorCoverage;
    expect(cov).toBeTruthy();
    for (const [sel, n] of Object.entries(cov ?? {})) {
      expect(`${sel}:${n}`).toMatch(/:[1-9]/);
    }
  });

  /** First covered selector in the fixture, asserted present. */
  function firstSelector(cov: Record<string, number> | undefined): {
    cov: Record<string, number>;
    sel: string;
  } {
    if (!cov) throw new Error("fixture: chartLabels has no selectorCoverage");
    const sel = Object.keys(cov)[0];
    if (!sel) throw new Error("fixture: selectorCoverage is empty");
    return { cov, sel };
  }

  it("fails when a selector stops contributing rows to the >=11px floor", () => {
    const { ledger, block } = load();
    const { cov, sel } = firstSelector(block.chartLabels?.selectorCoverage);
    cov[sel] = 0;

    const r = runVerifyGate({ demo: demoModule, gate, ledger });
    expect(r.threw).toBe(true);
    expect(r.message).toMatch(/type-size|selector/i);
    expect(r.message).toMatch(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("fails when a selector is missing from coverage entirely", () => {
    const { ledger, block } = load();
    const { cov, sel } = firstSelector(block.chartLabels?.selectorCoverage);
    delete cov[sel];

    const r = runVerifyGate({ demo: demoModule, gate, ledger });
    expect(r.threw).toBe(true);
  });
});

describe("acceptance-359 contrast is gated, not merely recorded (#376)", () => {
  const demoModule = "acceptance-359.mjs";
  const gate = "acceptanceSweepGates";
  type Screen = {
    contrast?: { ids?: string[]; notFound?: string[]; aaFails?: string[] };
  };
  type Block = { screens?: Record<string, Screen> };
  const load = () => demoBlock<Block>("issue-359", "acceptance-sweep");

  it("passes on the committed ledger", () => {
    const { ledger } = load();
    expect(runVerifyGate({ demo: demoModule, gate, ledger })).toMatchObject({ threw: false });
  });

  it("fails when a screen reports an AA failure", () => {
    const { ledger, block } = load();
    const screen = block.screens?.fleet;
    if (!screen?.contrast) throw new Error("fixture: fleet screen has no contrast");
    screen.contrast.aaFails = ["brand-sub"];

    const r = runVerifyGate({ demo: demoModule, gate, ledger });
    expect(r.threw).toBe(true);
    expect(r.message).toMatch(/brand-sub/);
    expect(r.message).toMatch(/fleet/);
  });

  it("fails when a screen reports a probe that was not found", () => {
    const { ledger, block } = load();
    const screen = block.screens?.metrics;
    if (!screen?.contrast) throw new Error("fixture: metrics screen has no contrast");
    screen.contrast.notFound = ["clock"];

    const r = runVerifyGate({ demo: demoModule, gate, ledger });
    expect(r.threw).toBe(true);
    expect(r.message).toMatch(/clock/);
  });

  it("fails when a required probe id stops being measured on a screen", () => {
    const { ledger, block } = load();
    const screen = block.screens?.run;
    if (!screen?.contrast) throw new Error("fixture: run screen has no contrast");
    screen.contrast.ids = (screen.contrast.ids ?? []).filter((id) => id !== "clock");

    const r = runVerifyGate({ demo: demoModule, gate, ledger });
    expect(r.threw).toBe(true);
    expect(r.message).toMatch(/contrast probes absent from ledger/);
    expect(r.message).toMatch(/\bclock\b/);
    expect(r.message).toMatch(/\brun\b/);
    // Must be the membership check, not the notFound branch.
    expect(r.message).not.toMatch(/matched nothing/);
  });

  it("fails on substitution that keeps the probe count identical", () => {
    const { ledger, block } = load();
    const screen = block.screens?.metrics;
    if (!screen?.contrast) throw new Error("fixture: metrics screen has no contrast");
    // Same length, one required id swapped for an unrelated one — the shape a
    // count-based floor would wave through.
    screen.contrast.ids = (screen.contrast.ids ?? []).map((id) =>
      id === "footer-meta" ? "some-other-probe" : id,
    );

    const r = runVerifyGate({ demo: demoModule, gate, ledger });
    expect(r.threw).toBe(true);
    expect(r.message).toMatch(/footer-meta/);
  });

  it("fails when a screen carries no contrast record at all", () => {
    const { ledger, block } = load();
    const screen = block.screens?.task;
    if (!screen) throw new Error("fixture: task screen missing");
    delete screen.contrast;

    const r = runVerifyGate({ demo: demoModule, gate, ledger });
    expect(r.threw).toBe(true);
    expect(r.message).toMatch(/task/);
  });
});

describe("fleet-board required chip labels (#377)", () => {
  const demoModule = "fleet-board.mjs";
  const gate = "fleetBoardGates";
  type Row = { required?: Record<string, { found?: boolean; truncated?: boolean }> };
  type Block = { chipUntruncated?: Record<string, Row> };
  const load = () => demoBlock<Block>("issue-355", "fleet-board");

  it("passes on the committed ledger", () => {
    const { ledger } = load();
    expect(runVerifyGate({ demo: demoModule, gate, ledger })).toMatchObject({ threw: false });
  });

  it("fails when a required chip label is absent from the ledger", () => {
    const { ledger, block } = load();
    const rows = Object.values(block.chipUntruncated ?? {});
    const row = rows.find((r) => r.required && "GATE HELD" in r.required);
    if (!row?.required) throw new Error("fixture: no row carries GATE HELD");
    delete row.required["GATE HELD"];

    const r = runVerifyGate({ demo: demoModule, gate, ledger });
    expect(r.threw).toBe(true);
    expect(r.message).toMatch(/GATE HELD/);
  });
});
