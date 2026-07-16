import type http from "node:http";
import type { TaskEngine } from "./engine.js";

/**
 * Daemon-local reverse proxy for grok's xAI completions traffic (#95).
 *
 * Mirrors the MCP hub pattern: one shared listener on the daemon HTTP server,
 * path-embedded task correlation (`/xai/<taskId>/v1/...`), teardown with the
 * server. grok is pointed here via `GROK_XAI_API_BASE_URL` in the adapter's
 * `baseEnv` (see `docs/research/grok-usage-proxy.md` proposal #1).
 *
 * The proxy:
 * - strips `/xai/<taskId>` and forwards the remainder to `https://api.x.ai`
 * - preserves method, Authorization, and body (Authorization passthrough)
 * - rewrites JSON bodies with `stream: true` to force
 *   `stream_options.include_usage = true` so a final SSE usage chunk is present
 * - streams the upstream response back verbatim (SSE-safe)
 * - parses usage from SSE final chunks or non-streaming JSON and attributes it
 *   to the task via `engine.mergeUsage`
 */

/** Real xAI API origin (path-less). Overridable in tests via options / env. */
export const DEFAULT_XAI_UPSTREAM_ORIGIN = "https://api.x.ai";

/** Env override for integration tests that stub the upstream. */
const UPSTREAM_ENV = "PARLEY_XAI_UPSTREAM_ORIGIN";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

export type XaiProxyPath = {
  /** Task id from the path (first segment after `/xai/`). */
  taskId: string;
  /** Remainder path forwarded upstream, always starting with `/v1`. */
  rest: string;
};

/**
 * Parse `/xai/<taskId>/v1...` into task correlation + upstream path.
 * Returns null when the path is not a valid proxy route.
 */
export function parseXaiProxyPath(pathname: string): XaiProxyPath | null {
  const segments = pathname.split("/").filter((s) => s !== "");
  if (segments[0] !== "xai" || segments.length < 2) return null;
  const taskId = segments[1];
  if (taskId === undefined || taskId === "") return null;
  // Require a `/v1` suffix so we never forward arbitrary residual paths as
  // if they were the xAI API surface.
  if (segments[2] !== "v1") return null;
  const rest = `/${segments.slice(2).join("/")}`;
  return { taskId, rest };
}

/**
 * When the body is JSON with `stream: true`, force
 * `stream_options.include_usage = true` so the upstream emits a usage-bearing
 * final SSE chunk. Non-JSON and non-stream bodies are returned untouched.
 */
export function rewriteRequestBodyForUsage(
  body: Buffer,
  contentType: string | undefined,
): Buffer {
  if (body.length === 0) return body;
  if (contentType !== undefined && !contentType.toLowerCase().includes("application/json")) {
    return body;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return body;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return body;
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.stream !== true) return body;
  const prior =
    typeof obj.stream_options === "object" &&
    obj.stream_options !== null &&
    !Array.isArray(obj.stream_options)
      ? (obj.stream_options as Record<string, unknown>)
      : {};
  obj.stream_options = { ...prior, include_usage: true };
  return Buffer.from(JSON.stringify(obj), "utf8");
}

/**
 * Normalize an xAI `usage` object into the task usage bag: keep raw numeric
 * fields and add canonical `input_tokens` / `output_tokens` / `cached_tokens`
 * when derivable (OpenAI-style prompt/completion names + nested cache details).
 */
export function normalizeXaiUsage(usage: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  // Canonical input
  if (typeof usage.input_tokens === "number" && Number.isFinite(usage.input_tokens)) {
    out.input_tokens = usage.input_tokens;
  } else if (typeof usage.prompt_tokens === "number" && Number.isFinite(usage.prompt_tokens)) {
    out.input_tokens = usage.prompt_tokens;
  }
  // Canonical output
  if (typeof usage.output_tokens === "number" && Number.isFinite(usage.output_tokens)) {
    out.output_tokens = usage.output_tokens;
  } else if (
    typeof usage.completion_tokens === "number" &&
    Number.isFinite(usage.completion_tokens)
  ) {
    out.output_tokens = usage.completion_tokens;
  }
  // Canonical cached
  if (typeof usage.cached_tokens === "number" && Number.isFinite(usage.cached_tokens)) {
    out.cached_tokens = usage.cached_tokens;
  } else if (
    typeof usage.cache_read_input_tokens === "number" &&
    Number.isFinite(usage.cache_read_input_tokens)
  ) {
    out.cached_tokens = usage.cache_read_input_tokens;
  } else if (
    typeof usage.prompt_tokens_details === "object" &&
    usage.prompt_tokens_details !== null &&
    !Array.isArray(usage.prompt_tokens_details)
  ) {
    const cached = (usage.prompt_tokens_details as Record<string, unknown>).cached_tokens;
    if (typeof cached === "number" && Number.isFinite(cached)) {
      out.cached_tokens = cached;
    }
  }
  return out;
}

function usageFromPayload(parsed: unknown): Record<string, number> | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const usage = (parsed as Record<string, unknown>).usage;
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
    return undefined;
  }
  const normalized = normalizeXaiUsage(usage as Record<string, unknown>);
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/** Extract usage from a non-streaming JSON response body. */
export function extractUsageFromJsonBody(text: string): Record<string, number> | undefined {
  try {
    return usageFromPayload(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * Walk an SSE body and return the last usage-bearing `data:` payload
 * (chat-completions final chunk typically carries usage only on the last event).
 */
export function extractUsageFromSse(text: string): Record<string, number> | undefined {
  let last: Record<string, number> | undefined;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice("data:".length).trim();
    if (data === "" || data === "[DONE]") continue;
    try {
      const found = usageFromPayload(JSON.parse(data));
      if (found !== undefined) last = found;
    } catch {
      // Non-JSON data lines are ignored (comments, pings).
    }
  }
  return last;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(", ") : value;
}

function collectBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function resolveUpstreamOrigin(options: { upstreamOrigin?: string }): string {
  return (
    options.upstreamOrigin ??
    process.env[UPSTREAM_ENV] ??
    DEFAULT_XAI_UPSTREAM_ORIGIN
  );
}

/**
 * Handle one HTTP request under `/xai/<taskId>/v1/...`.
 * Streams the upstream response back and attributes any parsed usage to the task.
 */
export async function handleXaiProxyRequest(
  engine: Pick<TaskEngine, "get" | "mergeUsage">,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: { upstreamOrigin?: string } = {},
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const parsed = parseXaiProxyPath(url.pathname);
  if (parsed === null) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not a valid xAI proxy path (expected /xai/<taskId>/v1/...)" }));
    return;
  }
  if (!engine.get(parsed.taskId)) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `unknown task: ${parsed.taskId}` }));
    return;
  }

  const origin = resolveUpstreamOrigin(options).replace(/\/+$/, "");
  const target = new URL(parsed.rest + url.search, `${origin}/`);

  const method = (req.method ?? "GET").toUpperCase();
  let body: Buffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    body = rewriteRequestBodyForUsage(
      await collectBody(req),
      headerValue(req.headers["content-type"]),
    );
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
    headers[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  if (body !== undefined) {
    headers["content-length"] = String(body.byteLength);
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body:
        body === undefined
          ? undefined
          : body.byteLength === 0 && (method === "GET" || method === "HEAD")
            ? undefined
            : new Uint8Array(body),
    });
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `xAI upstream fetch failed: ${String(err)}` }));
    return;
  }

  const outHeaders: http.OutgoingHttpHeaders = {};
  upstream.headers.forEach((value, key) => {
    if (HOP_BY_HOP.has(key.toLowerCase())) return;
    outHeaders[key] = value;
  });
  res.writeHead(upstream.status, outHeaders);

  const chunks: Buffer[] = [];
  if (upstream.body) {
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        chunks.push(buf);
        if (!res.writableEnded) res.write(buf);
      }
    } catch (err) {
      if (!res.writableEnded) {
        res.destroy(err instanceof Error ? err : new Error(String(err)));
      }
      return;
    }
  }
  if (!res.writableEnded) res.end();

  const responseText = Buffer.concat(chunks).toString("utf8");
  const contentType = upstream.headers.get("content-type") ?? "";
  let usage: Record<string, number> | undefined;
  if (contentType.toLowerCase().includes("text/event-stream")) {
    usage = extractUsageFromSse(responseText);
  } else {
    usage = extractUsageFromJsonBody(responseText);
  }
  if (usage !== undefined) {
    engine.mergeUsage(parsed.taskId, usage);
  }
}
