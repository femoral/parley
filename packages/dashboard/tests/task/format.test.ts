/** @vitest-environment happy-dom */
import { describe, expect, it } from "vitest";
import { stateLabel } from "../../src/components/index.js";
import {
  formatDuration,
  formatEvalScore,
  formatUsage,
  tailStatusLabel,
} from "../../src/screens/task/format.js";
import {
  answerScaffold,
  delegateScaffold,
  failedRunScaffold,
  fixScaffold,
  gateVerbScaffold,
  gateVerbScaffolds,
} from "../../src/screens/task/scaffolds.js";
import { GATE_VERBS } from "../../src/screens/run/state.js";
import { formatChurn, projectReportFiles } from "../../src/data/index.js";
import { churnReport, pathOnlyReport } from "./fixtures.js";

describe("task format helpers", () => {
  it("shared stateLabel matches fleet chip labels (DONE / CANCEL)", () => {
    expect(stateLabel("awaiting_answer")).toBe("AWAITING");
    expect(stateLabel("failed")).toBe("FAILED");
    expect(stateLabel("completed")).toBe("DONE");
    expect(stateLabel("cancelled")).toBe("CANCEL");
  });

  it("formats duration and usage", () => {
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatUsage({ input_tokens: 1200, output_tokens: 400, cached_tokens: 100 })).toMatch(
      /1\.2k ▸ 400/,
    );
    expect(formatUsage(null)).toBe("—");
  });

  it("formats eval scores without inventing baselines", () => {
    expect(formatEvalScore(null, 5)).toBe("— unscored");
    expect(formatEvalScore(8, 5.2)).toBe("8.0/5.2");
    expect(formatEvalScore(8, null)).toBe("8.0");
  });

  it("tail status is honest about follow and drops", () => {
    expect(tailStatusLabel("tailing", true)).toMatch(/follow on/);
    expect(tailStatusLabel("paused-by-setting", false)).toMatch(/follow off/);
    expect(tailStatusLabel("unreachable", true)).toMatch(/stream dropped/);
  });

  it("log gutter is line numbers — never invents wall clocks", async () => {
    const { formatLogLineNo } = await import("../../src/screens/task/format.js");
    expect(formatLogLineNo(0)).toBe("01");
    expect(formatLogLineNo(9)).toBe("10");
    // formatLogClock must not exist (fabricated timestamps removed).
    const mod = await import("../../src/screens/task/format.js");
    expect("formatLogClock" in mod).toBe(false);
  });
});

describe("copy scaffolds", () => {
  it("builds self-describing ready-to-paste CLI lines", () => {
    expect(answerScaffold("abc")).toBe('parley answer abc "<answer>"');
    expect(fixScaffold("abc")).toBe('parley fix abc "<what to change>"');
    expect(delegateScaffold("do the thing")).toBe('parley delegate "do the thing"');
    expect(delegateScaffold()).toBe('parley delegate "<task brief>"');
    // Never "..." or a bare command.
    for (const cmd of [
      answerScaffold("t7"),
      fixScaffold("t7"),
      delegateScaffold(),
    ]) {
      expect(cmd).not.toMatch(/"\.\.\."/);
      expect(cmd).not.toMatch(/\bparley (answer|fix|delegate)\s*$/);
    }
  });

  it("builds one gate scaffold per wire verb with the real run address", () => {
    const built = gateVerbScaffolds(["approve", "reject", "redirect", "finish"], "r1");
    expect(built.map((b) => b.command)).toEqual([
      "parley run approve r1",
      "parley run reject r1",
      "parley run redirect r1 --to <node>",
      "parley run finish r1",
    ]);
    for (const { command } of built) {
      expect(command).toContain("r1");
      expect(command).not.toMatch(/"\.\.\."/);
    }
  });

  it("builds gate scaffolds for a subset of verbs (wire verbs present)", () => {
    const built = gateVerbScaffolds(["redirect", "finish"], "run-xyz");
    expect(built).toHaveLength(2);
    expect(built[0]!.command).toBe("parley run redirect run-xyz --to <node>");
    expect(built[1]!.command).toBe("parley run finish run-xyz");
  });

  it("falls back to default GATE_VERBS when caller passes the absent/empty fallback set", () => {
    // Callers resolve absent/empty via verbsForDisplay → GATE_VERBS.
    const built = gateVerbScaffolds(GATE_VERBS, "r9");
    expect(built.map((b) => b.verb)).toEqual([...GATE_VERBS]);
    expect(gateVerbScaffold("approve", "r9")).toBe("parley run approve r9");
  });

  it("builds a failed-run recovery scaffold with the real run id", () => {
    expect(failedRunScaffold("run-fail-01")).toBe("parley run fork run-fail-01");
    expect(failedRunScaffold("run-fail-01")).not.toMatch(/"\.\.\."/);
  });
});

describe("report churn honesty", () => {
  it("renders +N/−N when counts exist; empty when path-only", () => {
    const view = projectReportFiles(churnReport());
    expect(view.hasChurn).toBe(true);
    expect(formatChurn(view.files[0]!)).toBe("+120 −14");
    // Path-only object form
    const pathOnly = view.files.find((f) => f.path === "README.md")!;
    expect(pathOnly.added).toBeNull();
    expect(pathOnly.removed).toBeNull();
    expect(formatChurn(pathOnly)).toBe("");
  });

  it("path-only legacy reports never invent 0/0", () => {
    const view = projectReportFiles(pathOnlyReport());
    expect(view.hasChurn).toBe(false);
    for (const f of view.files) {
      expect(formatChurn(f)).toBe("");
      expect(f.added).toBeNull();
      expect(f.removed).toBeNull();
    }
  });
});
