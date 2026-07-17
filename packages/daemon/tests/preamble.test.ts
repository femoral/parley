/**
 * Channel-matched protocol preamble (#155). Pure-function pins for the three
 * tools-section variants; channel-independent sections stay stable.
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildProtocolPreamble,
  finishInstruction,
  toolsSectionLines,
} from "../src/preamble.js";
import { createAdapterRegistrySync } from "../src/adapters/index.js";
import { DEFAULT_REPORT_SCHEMA } from "../src/report.js";
import type { ChildChannel } from "@useparley/core";

const SCHEMA = DEFAULT_REPORT_SCHEMA;

describe("toolsSectionLines — three channel variants", () => {
  it("mcp teaches tool-call phrasing only", () => {
    const text = toolsSectionLines("mcp", "30 minutes").join("\n");
    expect(text).toContain("ask_orchestrator({ question })");
    expect(text).toContain("submit_report({ ... })");
    expect(text).not.toContain("parley child");
    expect(text).not.toContain("curl");
    expect(text).not.toContain("/child/report");
  });

  it("cli teaches parley child commands only", () => {
    const text = toolsSectionLines("cli", "30 minutes").join("\n");
    expect(text).toContain("parley child ask");
    expect(text).toContain("parley child report");
    expect(text).toContain("parley child task");
    expect(text).not.toContain("ask_orchestrator({ question })");
    expect(text).not.toContain("submit_report({ ... })");
    expect(text).not.toContain("curl");
  });

  it("http teaches curl examples with the task header only", () => {
    const text = toolsSectionLines("http", "30 minutes").join("\n");
    expect(text).toContain("curl");
    expect(text).toContain("/child/ask");
    expect(text).toContain("/child/report");
    expect(text).toContain("x-parley-task");
    expect(text).toContain("$PARLEY_HUB_URL");
    expect(text).toContain("$PARLEY_TASK_ID");
    expect(text).not.toContain("ask_orchestrator({ question })");
    expect(text).not.toContain("parley child ask");
  });
});

describe("buildProtocolPreamble — channel selection + shared sections", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "parley-preamble-"));
  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function preamble(channel: ChildChannel): string {
    return buildProtocolPreamble({
      cwd: tmp,
      branch: "parley/t1-x",
      answerTimeoutMs: 1_800_000,
      reportSchema: SCHEMA,
      childChannel: channel,
    });
  }

  it("keeps channel-independent sections identical across variants", () => {
    const mcp = preamble("mcp");
    const cli = preamble("cli");
    const http = preamble("http");

    for (const text of [mcp, cli, http]) {
      expect(text).toContain("# Parley protocol");
      expect(text).toContain("## Where things are");
      expect(text).toContain("parley/t1-x");
      expect(text).toContain(".parley/TASK.md");
      expect(text).toContain("## Report schema");
      expect(text).toMatch(/summary/);
      expect(text).toMatch(/outcome/);
      expect(text).toContain("30 minutes");
    }

    // Tools sections differ; everything before the tools heading matches.
    const beforeTools = (s: string) => s.slice(0, s.indexOf("## Tools available to you"));
    expect(beforeTools(cli)).toBe(beforeTools(mcp));
    expect(beforeTools(http)).toBe(beforeTools(mcp));
  });

  it("finishInstruction is channel-matched", () => {
    expect(finishInstruction("mcp")).toMatch(/submit_report/);
    expect(finishInstruction("cli")).toMatch(/parley child report/);
    expect(finishInstruction("http")).toMatch(/\/child\/report/);
  });
});

describe("built-in adapters declare childChannel", () => {
  it("every registered built-in has a valid childChannel", () => {
    const registry = createAdapterRegistrySync({});
    expect(registry.size).toBeGreaterThan(0);
    for (const [id, adapter] of registry) {
      expect(
        ["mcp", "cli", "http"].includes(adapter.childChannel),
        `${id} missing/invalid childChannel`,
      ).toBe(true);
    }
  });

  it("fake defaults to mcp", () => {
    expect(createAdapterRegistrySync({}).get("fake")!.childChannel).toBe("mcp");
  });
});
