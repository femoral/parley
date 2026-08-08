/**
 * #375 — the shell-chrome contrast gate must pin its probe id set.
 *
 * #374 fail-closed a *renamed* probe class (found:false throws). This covers
 * the level above: a probe id deleted from the measurement list must fail the
 * gate too, instead of vanishing from the ledger unnoticed.
 */
import { describe, expect, it } from "vitest";
import { readLedgerFixture, runVerifyGate } from "../helpers/verify-gate";

type Probe = { found?: boolean; ratio?: number; wcagAA?: boolean };
type ChromeDemo = { contrast?: Record<string, Probe> };
type Ledger = { demos: Record<string, ChromeDemo | undefined> };

const demo = "shell-chrome.mjs";
const gate = "shellChromeGates";

/**
 * Fresh copy of the committed ledger, with the shell-chrome demo and its
 * contrast block pulled out (both asserted present, so a fixture that stops
 * carrying them fails loudly here rather than silently weakening the tests).
 *
 * `chrome` and `contrast` are live references *into* `ledger`, so mutating
 * them is how each test builds its variant before handing `ledger` to the gate.
 */
function loadLedgerFixture(): {
  ledger: Ledger;
  chrome: ChromeDemo;
  contrast: Record<string, Probe>;
} {
  const ledger = readLedgerFixture<Ledger>("issue-354");
  const chrome = ledger.demos["shell-chrome"];
  if (!chrome) throw new Error("fixture: committed ledger has no shell-chrome demo");
  const contrast = chrome.contrast;
  if (!contrast) throw new Error("fixture: shell-chrome demo has no contrast block");
  return { ledger, chrome, contrast };
}

function runGate(ledger: Ledger) {
  return runVerifyGate({ demo, gate, ledger });
}

/**
 * The gate reports three distinct contrast failures, and each test below pins
 * the one it means. Matching loosely (e.g. just /clock/) would let the modes
 * collapse into each other unnoticed — which is the shape of defect this file
 * exists to catch.
 */
const ABSENT = /contrast probes absent from ledger/;
const NOT_FOUND = /contrast probe missing/;
const AA_FAIL = /contrast fail/;

describe("shell-chrome contrast probe membership (#375)", () => {
  it("passes on the committed ledger", () => {
    const { ledger } = loadLedgerFixture();
    expect(runGate(ledger)).toMatchObject({ threw: false });
  });

  it("fails when a required probe id is deleted from the ledger", () => {
    const { ledger, contrast } = loadLedgerFixture();
    expect(contrast.clock).toBeTruthy();
    delete contrast.clock;

    const r = runGate(ledger);
    expect(r.threw).toBe(true);
    expect(r.message).toMatch(ABSENT);
    expect(r.message).toMatch(/absent from ledger: clock\b/);
    // The old per-probe loop cannot see an id that was never recorded, so this
    // must be the membership check firing, not #374's found check.
    expect(r.message).not.toMatch(NOT_FOUND);
  });

  it("fails when every probe is deleted, naming the whole required set", () => {
    const { ledger, chrome } = loadLedgerFixture();
    chrome.contrast = {};

    const r = runGate(ledger);
    expect(r.threw).toBe(true);
    expect(r.message).toMatch(ABSENT);
    expect(r.message).toMatch(/brand-name/);
    expect(r.message).toMatch(/clock/);
    expect(r.message).toMatch(/footer-meta/);
    expect(r.message).toMatch(/measured: none/);
  });

  it("fails when the contrast record is missing entirely", () => {
    const { ledger, chrome } = loadLedgerFixture();
    delete chrome.contrast;

    const r = runGate(ledger);
    expect(r.threw).toBe(true);
    expect(r.message).toMatch(ABSENT);
  });

  it("still fails closed on a renamed class (#374 must not regress)", () => {
    const { ledger, contrast } = loadLedgerFixture();
    contrast.clock = { found: false };

    const r = runGate(ledger);
    expect(r.threw).toBe(true);
    // Present but not found: #374's check owns this, not the membership check.
    expect(r.message).toMatch(NOT_FOUND);
    expect(r.message).toMatch(/missing clock\b/);
    expect(r.message).not.toMatch(ABSENT);
  });

  it("still fails an AA regression on a required probe", () => {
    const { ledger, contrast } = loadLedgerFixture();
    contrast.clock = { found: true, ratio: 1.2, wcagAA: false };

    const r = runGate(ledger);
    expect(r.threw).toBe(true);
    expect(r.message).toMatch(AA_FAIL);
    expect(r.message).toMatch(/clock ratio=1\.2/);
    expect(r.message).not.toMatch(ABSENT);
  });

  it("tolerates an extra probe id beyond the required set", () => {
    const { ledger, contrast } = loadLedgerFixture();
    contrast["brand-tagline"] = { found: true, ratio: 9, wcagAA: true };

    expect(runGate(ledger)).toMatchObject({ threw: false });
  });
});
