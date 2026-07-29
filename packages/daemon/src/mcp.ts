import type http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { TASK_HEADER, type TaskEngine } from "./engine.js";
import {
  DEFAULT_REPORT_SCHEMA,
  resolveReportSchema,
  type JsonSchema,
} from "./report.js";

/**
 * The daemon-served streamable-HTTP MCP endpoint children report through
 * (ADR-0003). Correlation is header-based: every request carries the
 * per-task `x-parley-task` header injected by the adapter's SpawnPlan, so
 * concurrent children on the one endpoint can never cross streams.
 *
 * Exactly two tools (spec §4): `submit_report` (this ticket) and
 * `ask_orchestrator` (registered as a stub; behavior lands with #16).
 *
 * Tool *advertisement* (`tools/list`) carries the task's real report schema
 * (and a fixed `question: string` shape for ask) so weaker tool-calling
 * layers can construct arguments. Tool *validation* stays deliberately
 * loose: the engine remains the sole enforcer, and violations bounce back
 * as retryable tool errors rather than protocol errors (#270).
 */

const SUBMIT_REPORT_DESCRIPTION =
  "Submit the final task report. Required before finishing: a task only " +
  "completes when a schema-valid report is submitted. Default schema: " +
  '{ summary: string (markdown), outcome: "success" | "partial" | "blocked", ' +
  "files_changed: string[] }.";

const ASK_ORCHESTRATOR_DESCRIPTION =
  "Ask the orchestrator a blocking question when stuck. Blocks until the " +
  "orchestrator answers; the answer is returned as the tool result. Use " +
  "only when you genuinely cannot proceed. Argument: { question: string }.";

/** Fixed advertised shape for `ask_orchestrator` (handler still rejects empty). */
const ASK_ORCHESTRATOR_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    question: { type: "string" },
  },
  required: ["question"],
};

/** Side-effect-free annotations so headless vendor approval gates allow the call. */
const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};

/**
 * Produce a `tools/list` inputSchema for the task's report schema.
 * MCP requires root `type: "object"`. When the stored schema already has that
 * root, serve it verbatim (deep-cloned). Otherwise advertise a permissive empty
 * object `{ type: "object" }` — never the default report schema. Advertising a
 * shape the engine does not enforce is worse than advertising no shape (weak
 * children would be constrained to the wrong arguments). The engine still
 * validates against the stored value via {@link resolveReportSchema}.
 */
export function advertiseReportInputSchema(schema: JsonSchema): {
  type: "object";
  [key: string]: unknown;
} {
  if (
    typeof schema === "object" &&
    schema !== null &&
    !Array.isArray(schema) &&
    (schema as { type?: unknown }).type === "object"
  ) {
    // Deep-clone so a client cannot mutate the live definition.
    return JSON.parse(JSON.stringify(schema)) as {
      type: "object";
      [key: string]: unknown;
    };
  }
  // Permissive empty object: satisfies MCP, contradicts no engine rule.
  return { type: "object" };
}

/**
 * Build the per-task MCP server: two tools, loose handler validation, and a
 * `tools/list` response that advertises the task's real report schema.
 * Exported for in-memory client/server tests (#270).
 */
export function buildMcpServer(engine: TaskEngine, taskId: string): McpServer {
  const server = new McpServer({ name: "parley", version: "0.0.0" });

  // Resolve once at registration. Stored schema (custom / port-generated) or default.
  let reportSchema: JsonSchema = DEFAULT_REPORT_SCHEMA;
  try {
    const task = engine.get(taskId);
    reportSchema = resolveReportSchema(task?.report_schema);
  } catch {
    // Malformed task lookup must not prevent tool registration.
    reportSchema = DEFAULT_REPORT_SCHEMA;
  }
  const advertisedReportSchema = advertiseReportInputSchema(reportSchema);

  server.registerTool(
    "submit_report",
    {
      description: SUBMIT_REPORT_DESCRIPTION,
      // Deliberately loose at the MCP layer: report validation happens in the
      // engine (against the task's report schema) so violations come back as
      // tool errors the child can retry on, not protocol errors. The real
      // shape is served via the tools/list override below (#270).
      inputSchema: z.looseObject({}),
      // Unannotated MCP tools are treated as potentially destructive by
      // vendor approval gates (e.g. codex's guardian_approval), which
      // auto-cancel the call in headless mode since there's no TTY to
      // approve. This tool only records a report — declare it side-effect-free
      // so headless children can actually call it.
      annotations: TOOL_ANNOTATIONS,
    },
    (args: Record<string, unknown>) => {
      // Validation errors bounce back as tool errors so the child retries.
      const errors = engine.submitReport(taskId, args);
      if (errors !== null) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `report rejected:\n- ${errors.join("\n- ")}` }],
        };
      }
      return {
        // Task stays running until the vendor stream closes (#72); the report
        // is stored and will complete the task with final usage then.
        content: [{ type: "text" as const, text: "report accepted" }],
      };
    },
  );

  server.registerTool(
    "ask_orchestrator",
    {
      description: ASK_ORCHESTRATOR_DESCRIPTION,
      // Loose at the MCP layer (see submit_report): argument validation happens
      // in the handler so violations bounce back as retryable tool errors.
      // Advertised shape is overridden in tools/list below.
      inputSchema: z.looseObject({}),
      // See submit_report: undeclared annotations make vendor approval gates
      // treat the call as potentially destructive and auto-cancel it headless.
      annotations: TOOL_ANNOTATIONS,
    },
    async (args: Record<string, unknown>) => {
      const question = args.question;
      if (typeof question !== "string" || question.trim() === "") {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "ask_orchestrator requires a non-empty 'question' string",
            },
          ],
        };
      }
      const result = await engine.askOrchestrator(taskId, question);
      if ("error" in result) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: result.error }],
        };
      }
      return {
        content: [{ type: "text" as const, text: result.answer }],
      };
    },
  );

  // Advertise real JSON Schemas in tools/list without converting them to Zod
  // (approach B / #270). registerTool above already installed CallTool with
  // loose validation; replacing only ListTools keeps the engine as sole enforcer.
  // This handler replaces the SDK-generated listing wholesale, so any tool
  // added via registerTool in future must also be added to this array or it
  // will not be advertised.
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: "submit_report",
        description: SUBMIT_REPORT_DESCRIPTION,
        inputSchema: advertisedReportSchema,
        annotations: TOOL_ANNOTATIONS,
      },
      {
        name: "ask_orchestrator",
        description: ASK_ORCHESTRATOR_DESCRIPTION,
        inputSchema: ASK_ORCHESTRATOR_INPUT_SCHEMA,
        annotations: TOOL_ANNOTATIONS,
      },
    ],
  }));

  return server;
}

/**
 * Handle one HTTP request on the `/mcp` route. Stateless streamable HTTP: a
 * fresh transport/server pair per request, bound to the task named by the
 * correlation header.
 */
export async function handleMcpRequest(
  engine: TaskEngine,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: unknown,
): Promise<void> {
  const header = req.headers[TASK_HEADER];
  const taskId = Array.isArray(header) ? header[0] : header;
  if (!taskId || !engine.get(taskId)) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: `missing or unknown ${TASK_HEADER} header — MCP requests must be task-correlated`,
        },
        id: null,
      }),
    );
    return;
  }

  const server = buildMcpServer(engine, taskId);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — correlation lives in the header
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
