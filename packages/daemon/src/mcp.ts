import type http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { TASK_HEADER, type TaskEngine } from "./engine.js";

/**
 * The daemon-served streamable-HTTP MCP endpoint children report through
 * (ADR-0003). Correlation is header-based: every request carries the
 * per-task `x-parley-task` header injected by the adapter's SpawnPlan, so
 * concurrent children on the one endpoint can never cross streams.
 *
 * Exactly two tools (spec §4): `submit_report` (this ticket) and
 * `ask_orchestrator` (registered as a stub; behavior lands with #16).
 */

function buildMcpServer(engine: TaskEngine, taskId: string): McpServer {
  const server = new McpServer({ name: "parley", version: "0.0.0" });

  server.registerTool(
    "submit_report",
    {
      description:
        "Submit the final task report. Required before finishing: a task only " +
        "completes when a schema-valid report is submitted. Default schema: " +
        '{ summary: string (markdown), outcome: "success" | "partial" | "blocked", ' +
        "files_changed: string[] }.",
      // Deliberately loose at the MCP layer: report validation happens in the
      // engine (against the task's report schema) so violations come back as
      // tool errors the child can retry on, not protocol errors.
      inputSchema: z.looseObject({}),
      // Unannotated MCP tools are treated as potentially destructive by
      // vendor approval gates (e.g. codex's guardian_approval), which
      // auto-cancel the call in headless mode since there's no TTY to
      // approve. This tool only records a report — declare it side-effect-free
      // so headless children can actually call it.
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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
        content: [{ type: "text" as const, text: "report accepted; task completed" }],
      };
    },
  );

  server.registerTool(
    "ask_orchestrator",
    {
      description:
        "Ask the orchestrator a blocking question when stuck. Blocks until the " +
        "orchestrator answers; the answer is returned as the tool result. Use " +
        "only when you genuinely cannot proceed. Argument: { question: string }.",
      // Loose at the MCP layer (see submit_report): argument validation happens
      // in the handler so violations bounce back as retryable tool errors.
      inputSchema: z.looseObject({}),
      // See submit_report: undeclared annotations make vendor approval gates
      // treat the call as potentially destructive and auto-cancel it headless.
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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
