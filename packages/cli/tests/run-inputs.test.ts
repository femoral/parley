import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupHome, makeHome, runCli, writeFiles } from "./helpers.js";

let home: string | undefined;
let project: string | undefined;
afterEach(() => {
  if (home) cleanupHome(home);
  if (project) fs.rmSync(project, { recursive: true, force: true });
});

it.each([true, false])("reads raw frozen inputs on blocked/cancelled/forked runs (declared=%s)", async (declared) => {
  home = makeHome();
  project = fs.mkdtempSync(path.join(os.tmpdir(), "parley-inputs-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: project, stdio: "ignore" });
  const values = declared ? { text: "raw 🔑", count: 42, config: { nested: [true, "x", null] } } : {};
  const workflow = {
    id: "input-reader", version: 1, type: "other", workspace: "scratch",
    inputs: declared ? { text: { type: "text" }, count: { type: "Count" }, config: { type: "Config" } } : {},
    types: { Count: { schema: "types/count.json" }, Config: { schema: "types/config.json" } },
    outputs: {},
    nodes: [{ id: "gate", kind: "gate", question: "ready?", shows: {}, on_reject: "finish" }],
  };
  writeFiles(path.join(project, ".parley/workflows/input-reader"), {
    "workflow.json": JSON.stringify(workflow),
    "types/count.json": JSON.stringify({ type: "number" }),
    "types/config.json": JSON.stringify({ type: "object" }),
  });
  const inputFile = path.join(project, "inputs.json");
  fs.writeFileSync(inputFile, JSON.stringify(values));
  const start = await runCli(["run", "start", "input-reader", "--inputs", inputFile, "--json"], home, { cwd: project });
  expect(start.code, start.stderr).toBe(0);
  const id = JSON.parse(start.stdout).run_id;
  const status = async (runId: string) => {
    const result = await runCli(["run", "status", runId, "--json"], home!, { cwd: project });
    expect(result.code, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  const blocked = await status(id);
  expect(blocked.run.state).toBe("blocked");
  expect(blocked.inputs).toEqual(values);
  expect(blocked.outputs).toEqual({});
  // Changing the caller's input file cannot change a frozen run.
  fs.writeFileSync(inputFile, JSON.stringify({ text: "changed" }));
  expect((await status(id)).inputs).toEqual(values);
  expect((await runCli(["run", "cancel", id], home, { cwd: project })).code).toBe(0);
  const fork = await runCli(["run", "fork", id, "--to", "gate", "--json"], home, { cwd: project });
  expect(fork.code, fork.stderr).toBe(0);
  expect((await status(JSON.parse(fork.stdout).run_id)).inputs).toEqual(values);
  const cancelled = await status(id);
  expect(cancelled.run.state).toBe("cancelled");
  expect(cancelled.inputs).toEqual(values);
  fs.unlinkSync(path.join(home, "runs", id, ".parley/inputs.json"));
  expect((await status(id)).inputs).toEqual(declared ? null : {});
});
