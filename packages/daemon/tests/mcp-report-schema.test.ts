/**
 * #270 — advertise the task's real report schema in MCP tools/list.
 *
 * Evidence is a real in-memory MCP client/server round trip against the
 * registration in mcp.ts. Asserting against the same constant used to build
 * the advertisement is not acceptable: the test must fail if registration
 * stops advertising.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { homePaths, parsePortType } from "@useparley/core";
import type { VendorAdapter } from "../src/adapters/types.js";
import {
  insertTask,
  openDatabase,
  type DatabaseHandle,
  type NewTask,
} from "../src/db.js";
import { generateReportSchema } from "../src/deliverables.js";
import { TaskEngine } from "../src/engine.js";
import { advertiseReportInputSchema, buildMcpServer } from "../src/mcp.js";
import type { JsonSchema } from "../src/report.js";

let home: string;
let db: DatabaseHandle;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-mcp-schema-"));
  db = openDatabase(homePaths(home));
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(home, { recursive: true, force: true });
});

function baseTask(
  id: string,
  reportSchema: string | null = null,
): NewTask {
  return {
    id,
    name: id,
    vendor: "fake",
    model: null,
    effort: null,
    profile: null,
    repo: null,
    cwd: "/tmp",
    prompt: "do it",
    orchestrator_session_id: "orch",
    worktree: null,
    branch: null,
    base_sha: null,
    sandbox: "workspace",
    network: true,
    answer_timeout_ms: null,
    report_schema: reportSchema,
    size: null,
    difficulty: null,
    type: "other",
  };
}

function makeEngine(taskId: string, reportSchema: string | null = null): TaskEngine {
  insertTask(db, baseTask(taskId, reportSchema));
  const adapters = new Map<string, VendorAdapter>();
  return new TaskEngine(db, homePaths(home), adapters);
}

/** Connect an MCP client to the real per-task registration. */
async function connectMcp(
  engine: TaskEngine,
  taskId: string,
): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = buildMcpServer(engine, taskId);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "parley-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function toolByName(
  tools: { name: string; inputSchema: unknown }[],
  name: string,
): { name: string; inputSchema: Record<string, unknown> } {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} missing from tools/list`);
  return tool as { name: string; inputSchema: Record<string, unknown> };
}

describe("MCP tools/list report schema advertisement (#270)", () => {
  it("default schema: tools/list advertises summary, outcome enum, files_changed array, all required", async () => {
    const taskId = "t-default";
    const engine = makeEngine(taskId, null);
    const { client, close } = await connectMcp(engine, taskId);
    try {
      const { tools } = await client.listTools();
      const submit = toolByName(tools, "submit_report");
      const schema = submit.inputSchema;

      // Structural assertions — not expect(schema).toEqual(DEFAULT_REPORT_SCHEMA).
      expect(schema.type).toBe("object");
      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(props).toBeDefined();
      expect(props.summary?.type).toBe("string");
      expect(props.outcome?.enum).toEqual(["success", "partial", "blocked"]);
      expect(props.files_changed?.type).toBe("array");
      expect((props.files_changed?.items as { type?: string })?.type).toBe("string");
      expect(schema.required).toEqual(
        expect.arrayContaining(["summary", "outcome", "files_changed"]),
      );
      expect((schema.required as string[]).length).toBe(3);
    } finally {
      await close();
    }
  });

  it("custom --report-schema: tools/list advertises the stored schema, not the default", async () => {
    const custom = {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["ship", "hold"] },
        notes: { type: "string", maxLength: 40 },
      },
      required: ["verdict"],
      additionalProperties: true,
    };
    const taskId = "t-custom";
    const engine = makeEngine(taskId, JSON.stringify(custom));
    const { client, close } = await connectMcp(engine, taskId);
    try {
      const { tools } = await client.listTools();
      const submit = toolByName(tools, "submit_report");
      // Round-trip equality against the schema we stored on the task — if
      // registration fell back to the default, properties would be summary/…
      expect(submit.inputSchema).toEqual(custom);
      expect(submit.inputSchema.properties).not.toHaveProperty("summary");
      expect(submit.inputSchema.properties).toHaveProperty("verdict");
    } finally {
      await close();
    }
  });

  it("output-port generated schema: advertises format uri and maxLength/maxItems bounds", async () => {
    const ports = {
      notes: {
        type: parsePortType("text", {}),
        bounds: { maxLength: 20 },
      },
      items: {
        type: parsePortType("text[]", {}),
        bounds: { maxItems: 2, maxLength: 10 },
      },
      link: { type: parsePortType("url", {}) },
    };
    const generated = generateReportSchema(ports);
    const taskId = "t-ports";
    const engine = makeEngine(taskId, JSON.stringify(generated));
    const { client, close } = await connectMcp(engine, taskId);
    try {
      const { tools } = await client.listTools();
      const submit = toolByName(tools, "submit_report");
      const props = submit.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;

      expect(props.link?.format).toBe("uri");
      expect(props.notes?.maxLength).toBe(20);
      expect(props.items?.maxItems).toBe(2);
      // Nested item bound from text[] maxLength.
      const itemsItems = props.items?.items as Record<string, unknown> | undefined;
      expect(itemsItems?.maxLength).toBe(10);
      expect(submit.inputSchema.required).toEqual(
        expect.arrayContaining(["notes", "items", "link"]),
      );
    } finally {
      await close();
    }
  });

  it("extra keys reach the engine and are accepted on the default schema", async () => {
    const taskId = "t-extra";
    const engine = makeEngine(taskId, null);
    const { client, close } = await connectMcp(engine, taskId);
    try {
      const result = await client.callTool({
        name: "submit_report",
        arguments: {
          summary: "done",
          outcome: "success",
          files_changed: ["a.ts"],
          unexpected_extra: true,
        },
      });
      expect(result.isError).toBeFalsy();
      const text = (result.content as { type: string; text: string }[])[0]?.text;
      expect(text).toBe("report accepted");
    } finally {
      await close();
    }
  });

  it("schema-violating payload returns isError tool result, not a protocol throw", async () => {
    const taskId = "t-violation";
    const engine = makeEngine(taskId, null);
    const { client, close } = await connectMcp(engine, taskId);
    try {
      // files_changed as a string is the common weak-model failure mode.
      const result = await client.callTool({
        name: "submit_report",
        arguments: {
          summary: "oops",
          outcome: "success",
          files_changed: '["a.ts"]',
        },
      });
      // Must be a normal CallToolResult with isError, not a thrown McpError.
      expect(result.isError).toBe(true);
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
      expect(text).toMatch(/report rejected/);
      expect(text).toMatch(/files_changed/);
    } finally {
      await close();
    }
  });

  it("ask_orchestrator advertises required question string; empty still rejected as tool error", async () => {
    const taskId = "t-ask";
    const engine = makeEngine(taskId, null);
    const { client, close } = await connectMcp(engine, taskId);
    try {
      const { tools } = await client.listTools();
      const ask = toolByName(tools, "ask_orchestrator");
      expect(ask.inputSchema.type).toBe("object");
      const props = ask.inputSchema.properties as Record<string, Record<string, unknown>>;
      expect(props.question?.type).toBe("string");
      expect(ask.inputSchema.required).toEqual(["question"]);

      const empty = await client.callTool({
        name: "ask_orchestrator",
        arguments: { question: "   " },
      });
      expect(empty.isError).toBe(true);
      const emptyText =
        (empty.content as { type: string; text: string }[])[0]?.text ?? "";
      expect(emptyText).toMatch(/non-empty 'question' string/);

      const missing = await client.callTool({
        name: "ask_orchestrator",
        arguments: {},
      });
      expect(missing.isError).toBe(true);
      const missingText =
        (missing.content as { type: string; text: string }[])[0]?.text ?? "";
      expect(missingText).toMatch(/non-empty 'question' string/);
    } finally {
      await close();
    }
  });

  it("malformed stored schema does not crash registration; tools still list", async () => {
    // Valid JSON but not a usable object schema for tools/list.
    const taskId = "t-malformed";
    const engine = makeEngine(taskId, JSON.stringify(true));
    const { client, close } = await connectMcp(engine, taskId);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(["ask_orchestrator", "submit_report"]);
      // Falls back to a listable object schema rather than crashing.
      const submit = toolByName(tools, "submit_report");
      expect(submit.inputSchema.type).toBe("object");
    } finally {
      await close();
    }
  });

  it("advertiseReportInputSchema falls back for non-object roots", () => {
    const out = advertiseReportInputSchema(false as unknown as JsonSchema);
    expect(out.type).toBe("object");
    expect(out.properties).toBeDefined();
  });
});
