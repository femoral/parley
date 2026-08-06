/**
 * Fake-vendor action-script library.
 *
 * Named scripts stage daemon states the console screens will need to render.
 * Each entry is an array of fake-vendor actions (see packages/cli/tests/fake-vendor.mjs).
 *
 * Usage:
 *   import { scriptActions, writeFakeVendorScript } from "./library.mjs";
 *   const cwd = writeFakeVendorScript(scriptActions("awaiting-answer"));
 *   // then POST /tasks with { cwd, vendor: "fake", ... }
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * @typedef {Record<string, unknown>} FakeVendorAction
 * @typedef {FakeVendorAction[]} ActionScript
 */

/** @type {Record<string, ActionScript>} */
const LIBRARY = {
  /**
   * Quick success with a short report — baseline completed envelope.
   */
  "report-success": [
    { emit: { type: "message", text: "working on it" } },
    { sleep: 50 },
    {
      submit_report: {
        summary: "Verification harness staged a successful report.",
        outcome: "success",
        files_changed: ["src/example.ts", "README.md"],
      },
    },
  ],

  /**
   * Report with file churn paths (counts come from git when worktree+base exist;
   * path list is always on the wire).
   */
  "report-with-churn": [
    {
      write_file: {
        path: "src/touched.ts",
        contents: "line1\nline2\nline3\n",
      },
    },
    {
      submit_report: {
        summary: "Touched a file and reported churn paths.",
        outcome: "success",
        files_changed: ["src/touched.ts"],
      },
    },
  ],

  /**
   * Blocks on ask_orchestrator — surfaces awaiting_answer + question.
   */
  "awaiting-answer": [
    { emit: { type: "message", text: "need a decision" } },
    {
      ask: "Should the console show the scaffold status or the live daemon origin?",
    },
    {
      submit_report: {
        summary: "Answered and finished.",
        outcome: "success",
        files_changed: [],
      },
    },
  ],

  /**
   * Fatal vendor error → failed task.
   */
  "vendor-failure": [
    { emit: { type: "message", text: "about to fail" } },
    { emit: { type: "fatal", message: "synthetic vendor failure (verify harness)" } },
    { exit: 1 },
  ],

  /**
   * Long sleep so the task stays running / can be observed as stalled with
   * a short stall threshold in later tickets. Default: just "running" long enough
   * to screenshot before it ends.
   */
  "long-running": [
    { emit: { type: "message", text: "still running" } },
    { sleep: 60_000 },
    {
      submit_report: {
        summary: "Eventually finished.",
        outcome: "success",
        files_changed: [],
      },
    },
  ],

  /**
   * Stall-friendly: sleep then exit without report (engine stall path depends
   * on config; useful when paired with answerTimeout / stall detectors).
   */
  stall: [
    { emit: { type: "message", text: "going quiet" } },
    { sleep: 120_000 },
    { exit: 0 },
  ],

  /**
   * Immediate exit 0 without report — incomplete / failed-ish terminal.
   */
  "exit-no-report": [{ exit: 0 }],

  /**
   * Fan-out placeholder: one completed child-shaped report. Real multi-slot
   * fan-outs are run-workflow territory; this stages a dense completed envelope
   * the fleet table can list while run screens are still landing.
   */
  "fan-out-leaf": [
    { emit: { type: "message", text: "leaf slot work" } },
    {
      submit_report: {
        summary: "Fan-out leaf completed.",
        outcome: "success",
        files_changed: ["packages/dashboard/verify/scripts/library.mjs"],
      },
    },
  ],
};

/**
 * List available script names.
 * @returns {string[]}
 */
export function listScripts() {
  return Object.keys(LIBRARY).sort();
}

/**
 * Resolve a named script (throws if unknown).
 * @param {string} name
 * @returns {ActionScript}
 */
export function scriptActions(name) {
  const script = LIBRARY[name];
  if (!script) {
    throw new Error(
      `unknown fake-vendor script "${name}". available: ${listScripts().join(", ")}`,
    );
  }
  // Deep-ish clone so callers can mutate without poisoning the library.
  return JSON.parse(JSON.stringify(script));
}

/**
 * Write a temp task dir with `.fake-vendor.json` (and optional extra files).
 * @param {ActionScript} actions
 * @param {Record<string, string>} [files]
 * @returns {string} absolute cwd
 */
export function writeFakeVendorScript(actions, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-verify-task-"));
  fs.writeFileSync(
    path.join(dir, ".fake-vendor.json"),
    JSON.stringify(actions, null, 2),
  );
  for (const [rel, contents] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  return dir;
}

/**
 * Write a resume script alongside an existing task dir.
 * @param {string} dir
 * @param {ActionScript} resumeActions
 */
export function writeResumeScript(dir, resumeActions) {
  fs.writeFileSync(
    path.join(dir, ".fake-vendor.resume.json"),
    JSON.stringify(resumeActions, null, 2),
  );
}

export { LIBRARY as SCRIPTS };
