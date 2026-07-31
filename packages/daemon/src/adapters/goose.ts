import fs from "node:fs";
import path from "node:path";
import { resolveOperatorVendorHome, type SelectedModel } from "@useparley/core";
import type {
  AdapterEnforcement,
  HubInfo,
  MaterializedFile,
  SandboxMode,
  SpawnPlan,
  TaskSpec,
  VendorAdapter,
  VendorEvent,
} from "./types.js";
import { VENDOR_DIAG_PREFIX, withPostureDiagnostics } from "./types.js";

/**
 * The `goose` vendor adapter — real delegation to Block/AAIF goose (`goose`
 * binary, ADR-0004/0006). Verified against goose **v1.43.0** (2026-07-14); see
 * `docs/research/goose-cli-automation.md` for the automation surface.
 *
 * Goose is a **materialized-files** adapter (like grok), not flags-only (codex):
 * MCP-over-HTTP custom headers are config-only (§3), so we isolate a per-task
 * `GOOSE_PATH_ROOT` under the worktree and write `config/config.yaml` there.
 * There is **no OS-level sandbox** (§5) — posture maps only to `GOOSE_MODE`
 * tool-approval policy. Session ids are **not** in the JSONL stream (§4); we
 * assign a stable `-n parley-<taskId>` name and also scrape the human banner.
 *
 * `listModels` is omitted: v1.43.0 has no cloud model catalog CLI (§7).
 */

/** Default binary; override via `PARLEY_GOOSE_BIN` (smoke tests, custom installs). */
const DEFAULT_GOOSE_BIN = "goose";

/**
 * Per-task private root materialized under `task.cwd` and pointed at by
 * `GOOSE_PATH_ROOT` (§3 / §9.1). Isolates config/data/state from the user's
 * `~/.config/goose` so human sessions never bleed into delegated children.
 */
const PATH_ROOT_DIR = ".parley-goose";

/** Extension name for the parley MCP hub in the isolated config. */
const MCP_EXTENSION_NAME = "parley";

/**
 * Headroom (seconds) added to the answer timeout when raising the streamable_http
 * extension `timeout` (goose default 300s — research §3). Same class of gotcha as
 * codex `tool_timeout_sec`: a blocking `ask_orchestrator` must not die first.
 */
const EXTENSION_TIMEOUT_HEADROOM_SEC = 60;

/**
 * Auth / provider keys forwarded from the parent env when set (§6.3). Only these
 * names — never a blanket env dump.
 */
const AUTH_ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_HOST",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
  "OPENAI_CUSTOM_HEADERS",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_HOST",
  "GOOGLE_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "DATABRICKS_HOST",
  "DATABRICKS_TOKEN",
  "GOOSE_PROVIDER",
  "GOOSE_MODEL",
  "GOOSE_PROVIDER__API_KEY",
  "GOOSE_PROVIDER__HOST",
  "GOOSE_PROVIDER__TYPE",
] as const;

/**
 * Banner session-id shape: `YYYYMMDD_N` (research §4.1 / §2.2). Scraped from
 * non-JSON stdout because stream-json events never carry the id.
 */
const BANNER_SESSION_ID = /\b(\d{8}_\d+)\b/;

/** Auth / fatal patterns in assistant text — exit code is 0 on 401 (§2.4). */
const AUTH_FATAL_RE =
  /Authentication error|401 Unauthorized|You didn't provide an API key|No provider configured/i;

/**
 * MCP extension init failure on stderr (research §3 / adapter-validation-a).
 * Goose continues without the extension (exit 0) — must surface as fatal so
 * the task does not silently run without ask_orchestrator / submit_report.
 * Engine feeds stderr through parseEvent (#107).
 */
const MCP_EXTENSION_FAIL_RE =
  /Failed to start extension ['"]parley['"]|Failed to start extension parley/i;

/**
 * Resume/session lookup failures land on stderr with empty stdout (research §4,
 * adapter-validation-a). Without this, diagnosis is only "exited without report".
 */
const RESUME_FAIL_RE =
  /No session found|Cannot resume session|session not found/i;

/**
 * YAML double-quoted scalar. Escapes backslash, quote, and control characters so
 * a header value with a newline cannot inject extra config lines.
 */
function yamlString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

function extensionTimeoutSec(answerTimeoutMs: number): number {
  return Math.ceil(answerTimeoutMs / 1000) + EXTENSION_TIMEOUT_HEADROOM_SEC;
}

/**
 * Map normalized posture → goose `GOOSE_MODE` (§5.3).
 *
 * Goose v1.43.0 has **no OS filesystem/network sandbox**. Closest safe postures:
 *  - `read-only` → `chat` (no tools / file mods). Not true RO: UNKNOWN whether
 *    chat still exposes any read-only developer tools (research §5.3).
 *  - `workspace` / `full` → `auto` (autonomous tools; headless-safe).
 *  - `network: false` → **no native toggle**; we still set mode as above and
 *    document the gap. Host-level netns/bubblewrap would be required for real
 *    isolation (research §5.3).
 *
 * Interactive `approve` / `smart_approve` hang or cancel tools headlessly —
 * never used here.
 */
function gooseMode(sandbox: SandboxMode): "auto" | "chat" {
  switch (sandbox) {
    case "read-only":
      return "chat";
    case "workspace":
    case "full":
      return "auto";
  }
}

/**
 * Isolated `config/config.yaml` under `GOOSE_PATH_ROOT` (§3.2 / §9.1): MCP hub
 * with correlation headers (impossible via CLI flag alone), raised extension
 * timeout, and belt-and-braces `GOOSE_MODE` (env still wins).
 */
function configYaml(task: TaskSpec, hub: HubInfo): string {
  const timeout = extensionTimeoutSec(task.answerTimeoutMs);
  const mode = gooseMode(task.sandbox);
  const lines = [
    "# Generated by parley — do not edit; regenerated on every (re)spawn.",
    // research §5.2: GOOSE_MODE=auto disables interactive approvals headlessly.
    `GOOSE_MODE: ${mode}`,
    "extensions:",
    `  ${MCP_EXTENSION_NAME}:`,
    "    enabled: true",
    "    type: streamable_http",
    `    name: ${MCP_EXTENSION_NAME}`,
    "    description: Parley daemon MCP hub",
    `    uri: ${yamlString(hub.url)}`,
    "    headers:",
  ];
  for (const [key, value] of Object.entries(hub.headers)) {
    // YAML mapping keys that need quoting stay double-quoted for safety.
    lines.push(`      ${yamlString(key)}: ${yamlString(value)}`);
  }
  // research §3: extension timeout is seconds; raise above answerTimeoutMs.
  lines.push(`    timeout: ${timeout}`);
  return lines.join("\n") + "\n";
}

/**
 * Provider must be known before spawn: hermetic `GOOSE_PATH_ROOT` drops the
 * user's interactive `~/.config/goose`, so a keyed host with only interactive
 * provider config yields `No provider configured` (adapter-validation-a / #107).
 * Accept parent `GOOSE_PROVIDER` or `extraArgs: ["--provider", …]`.
 */
export function assertGooseProvider(
  task: TaskSpec,
  env: NodeJS.ProcessEnv,
): void {
  if (env.GOOSE_PROVIDER !== undefined && env.GOOSE_PROVIDER !== "") return;
  const args = task.extraArgs;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--provider" && args[i + 1] !== undefined && args[i + 1] !== "") {
      return;
    }
    if (args[i]?.startsWith("--provider=")) return;
  }
  throw new Error(
    "goose: no provider configured for headless run. Set GOOSE_PROVIDER in the " +
      "daemon environment, or pass extraArgs: [\"--provider\", \"<name>\"]. " +
      "Hermetic GOOSE_PATH_ROOT isolates away ~/.config/goose provider state (#107).",
  );
}

function sessionName(taskId: string): string {
  return `parley-${taskId}`;
}

function pathRoot(task: TaskSpec): string {
  return path.join(task.cwd, PATH_ROOT_DIR);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Pull tool name out of a goose content part (shape is loosely defined). */
function toolNameFromContent(part: Record<string, unknown>): string {
  const direct = asString(part.name || part.toolName || part.tool);
  if (direct) return direct;
  const toolCall = asRecord(part.toolCall) ?? asRecord(part.tool_call);
  if (toolCall) return asString(toolCall.name || toolCall.toolName);
  return "";
}

/** Join text content parts from a goose Message. */
function textFromMessage(message: Record<string, unknown>): string {
  const content = Array.isArray(message.content) ? message.content : [];
  const parts: string[] = [];
  for (const raw of content) {
    const part = asRecord(raw);
    if (!part) continue;
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("");
}

/**
 * Map Parley `effort` onto goose's provider-specific thinking envs (§6.2).
 * There is no general `--effort` flag — opaque CLI passthrough would fail.
 * Known values land on the documented knobs; anything else is still set as
 * `CLAUDE_THINKING_TYPE` (opaque) so a caller-chosen Claude value survives.
 */
function effortEnv(effort: string | null): Record<string, string> {
  if (effort === null) return {};
  const lower = effort.toLowerCase();
  if (lower === "adaptive" || lower === "enabled" || lower === "disabled") {
    return { CLAUDE_THINKING_TYPE: lower };
  }
  if (lower === "low" || lower === "high") {
    return { GEMINI3_THINKING_LEVEL: lower };
  }
  // Opaque: Claude-family thinking type is the only open-ended string surface.
  return { CLAUDE_THINKING_TYPE: effort };
}

const GOOSE_ENFORCEMENT: AdapterEnforcement = {
  "read-only": { level: "approximate", via: "GOOSE_MODE=chat (no tools / file mods)" },
  workspace: { level: "none", via: "GOOSE_MODE=auto; no OS sandbox" },
  full: { level: "enforced", via: "GOOSE_MODE=auto (unrestricted as requested)" },
  "network:false": { level: "none", via: "no native network toggle" },
};

export function createGooseAdapter(env: NodeJS.ProcessEnv = process.env): VendorAdapter {
  const bin = env.PARLEY_GOOSE_BIN ?? DEFAULT_GOOSE_BIN;

  /**
   * Env shared by prepare/resume: hermetic path root, headless keyring off,
   * mode (disables approval prompts), session-naming off, auth + effort.
   * research §9.1 / §3 / §5 / §6.
   */
  function baseEnv(task: TaskSpec): Record<string, string> {
    const result: Record<string, string> = {
      // research §3 / §1: full hermetic config/data/state isolation.
      GOOSE_PATH_ROOT: pathRoot(task),
      // research §6.3: headless CI must not require a desktop keyring.
      GOOSE_DISABLE_KEYRING: "1",
      // research §5.2: env overrides config; auto/chat never hang on TTY approvals.
      GOOSE_MODE: gooseMode(task.sandbox),
      // research §9.1: avoid an extra model call just to title the session.
      GOOSE_DISABLE_SESSION_NAMING: "true",
      ...effortEnv(task.effort),
    };
    for (const key of AUTH_ENV_KEYS) {
      const value = env[key];
      if (value !== undefined) result[key] = value;
    }
    return result;
  }

  function files(task: TaskSpec, hub: HubInfo): MaterializedFile[] {
    return [
      {
        // Relative to cwd; GOOSE_PATH_ROOT points at the absolute `.parley-goose`.
        path: `${PATH_ROOT_DIR}/config/config.yaml`,
        contents: configYaml(task, hub),
      },
    ];
  }

  /**
   * Flags shared by fresh runs and resumes. Prompt is always `-t <text>` (not a
   * bare positional), so extraArgs sit safely in the flags region before `-t`.
   * research §2.1 / §9.1.
   */
  function commonFlags(task: TaskSpec): string[] {
    const flags = ["--output-format", "stream-json"];
    // Model is opaque passthrough (§6.1). Provider is not on TaskSpec — use
    // parent `GOOSE_PROVIDER` env or `extraArgs: ["--provider", …]`.
    if (task.model !== null) flags.push("--model", task.model);
    // extraArgs: flags region only — never after the prompt (TaskSpec contract).
    flags.push(...task.extraArgs);
    return flags;
  }

  return withPostureDiagnostics({
    id: "goose",
    childChannel: "mcp",
    enforcement: GOOSE_ENFORCEMENT,

    prepare(task, hub): Promise<SpawnPlan> {
      // Fresh headless one-shot: `goose run --output-format stream-json … -t`.
      // Omit `--no-session` so resume remains possible (§2.1 / §4).
      // Omit `-q` so the banner can carry the session id (§4.2).
      try {
        assertGooseProvider(task, env);
      } catch (err) {
        return Promise.reject(err);
      }
      return Promise.resolve({
        argv: [
          bin,
          "run",
          ...commonFlags(task),
          "-n",
          sessionName(task.id),
          "-t",
          task.prompt,
        ],
        env: baseEnv(task),
        files: files(task, hub),
        cwd: task.cwd,
      });
    },

    resume(task, hub): Promise<SpawnPlan> {
      // Spawn-per-turn resume (ADR-0004 / research §4.3). Prefer `--session-id`
      // when captured; otherwise fall back to the stable `-n parley-<taskId>`
      // name we always assign on prepare (§4.2 strategy 4). Name is always
      // recoverable from task.id, so we never reject the way grok must when
      // its resume flag is id-only. Re-materialize config so hub headers stay
      // current.
      try {
        assertGooseProvider(task, env);
      } catch (err) {
        return Promise.reject(err);
      }
      const resumeFlags: string[] = ["--resume"];
      if (task.sessionId !== undefined) {
        resumeFlags.push("--session-id", task.sessionId);
      } else {
        resumeFlags.push("-n", sessionName(task.id));
      }
      // research §4.3: `goose run --output-format stream-json --resume … -t`.
      return Promise.resolve({
        argv: [
          bin,
          "run",
          "--output-format",
          "stream-json",
          ...resumeFlags,
          ...(task.model !== null ? ["--model", task.model] : []),
          ...task.extraArgs,
          "-t",
          task.prompt,
        ],
        env: baseEnv(task),
        files: files(task, hub),
        cwd: task.cwd,
      });
    },

    parseEvent(line: string): VendorEvent[] {
      // Non-JSON (banner, stderr warnings): session scrape + fatal diagnostics
      // that only appear off the JSONL stream (engine feeds stderr too — #107).
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Critical: MCP hub never registered — agent cannot finish protocol.
        if (MCP_EXTENSION_FAIL_RE.test(line)) {
          return [
            {
              kind: "error",
              text:
                `${VENDOR_DIAG_PREFIX} goose MCP extension 'parley' failed to ` +
                `start (hub tools unavailable): ${line.trim()}`,
              fatal: true,
            },
          ];
        }
        // Major: resume/session miss — diagnose instead of "exited without report".
        if (RESUME_FAIL_RE.test(line)) {
          return [
            {
              kind: "error",
              text: `${VENDOR_DIAG_PREFIX} goose resume/session error: ${line.trim()}`,
              fatal: true,
            },
          ];
        }
        const match = BANNER_SESSION_ID.exec(line);
        if (match?.[1]) {
          return [{ kind: "session_meta", session_id: match[1] }];
        }
        return []; // opaque non-JSON vendor noise — the raw log keeps it
      }
      const event = asRecord(parsed);
      if (!event) return [];

      switch (event.type) {
        case "message": {
          const message = asRecord(event.message);
          if (!message) return [];
          const content = Array.isArray(message.content) ? message.content : [];
          const out: VendorEvent[] = [];

          for (const raw of content) {
            const part = asRecord(raw);
            if (!part) continue;
            switch (part.type) {
              case "text": {
                // Handled below as joined text — skip per-part here.
                break;
              }
              case "toolRequest":
              case "frontendToolRequest": {
                // research §9.3: toolRequest → command.
                const name = toolNameFromContent(part);
                const args =
                  asRecord(part.toolCall)?.arguments ??
                  asRecord(part.tool_call)?.arguments ??
                  part.arguments;
                const text =
                  name === ""
                    ? JSON.stringify(part)
                    : args !== undefined
                      ? `${name} ${JSON.stringify(args)}`
                      : name;
                out.push({ kind: "command", text });
                break;
              }
              case "toolResponse": {
                // Hub tool failures (submit_report / ask_orchestrator) → PARLEY-DIAG.
                const name = toolNameFromContent(part);
                const isError =
                  part.isError === true ||
                  part.is_error === true ||
                  asRecord(part.error) !== undefined;
                if (!isError) break;
                const errText =
                  asString(asRecord(part.error)?.message) ||
                  asString(part.error) ||
                  asString(part.text) ||
                  "tool error";
                if (name === "submit_report" || name === "ask_orchestrator") {
                  out.push({
                    kind: "error",
                    text:
                      `${VENDOR_DIAG_PREFIX} goose toolResponse tool=${name} ` +
                      `failed: ${errText}`,
                  });
                } else {
                  out.push({ kind: "error", text: errText });
                }
                break;
              }
              default:
                // image, thinking, toolConfirmationRequest, … → opaque.
                break;
            }
          }

          const text = textFromMessage(message);
          if (text !== "") {
            // Auth failures exit 0 (§2.4) — surface as fatal error so the engine
            // does not treat the run as a clean empty success.
            if (AUTH_FATAL_RE.test(text)) {
              out.push({ kind: "error", text, fatal: true });
            } else {
              out.push({ kind: "message", text });
            }
          }
          return out;
        }

        case "error":
          // research §9.3: stream `error` is run-terminal.
          return [{ kind: "error", text: asString(event.error), fatal: true }];

        case "complete": {
          // research §8.1 / §9.3: terminal usage; drop nulls; keep harness names
          // and emit canonical input_tokens/output_tokens when present.
          const usage: Record<string, number> = {};
          for (const key of [
            "total_tokens",
            "input_tokens",
            "output_tokens",
            "cache_read_input_tokens",
            "cache_write_input_tokens",
          ] as const) {
            const v = event[key];
            if (typeof v === "number") usage[key] = v;
          }
          // Canonical keys when derivable (already same names for in/out).
          if (typeof usage.cache_read_input_tokens === "number") {
            usage.cached_tokens = usage.cache_read_input_tokens;
          }
          return [{ kind: "session_meta", usage }];
        }

        case "notification":
          // research §9.3: notifications are opaque (shape UNKNOWN live).
          // UNKNOWN(research): exact notification JSON under live MCP progress.
          return [];

        default:
          return [];
      }
    },

    sessionId(events: VendorEvent[]): string | undefined {
      // Last session_meta with a session_id (banner scrape or future stream field).
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (event?.kind === "session_meta" && event.session_id !== undefined) {
          return event.session_id;
        }
      }
      return undefined;
    },

    // listModels omitted — no stable cloud catalog command in v1.43.0 (§7).
    // Selected-model read (#284): not a catalog — pre-fill + rejection only.
    readSelectedModel(): SelectedModel | null {
      return readGooseSelectedModel(env);
    },
  });
}

/** On-disk config filename under the operator goose config dir (#284). */
const OPERATOR_CONFIG_FILE = "config.yaml";

/** Cap on operator config.yaml — small config; never slurp unbounded. */
export const GOOSE_CONFIG_MAX_BYTES = 2 * 1024 * 1024;

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}

/**
 * Strip a trailing `#…` comment outside quotes (YAML line comment).
 * Does not handle multi-line strings — goose's provider keys are simple.
 */
function stripYamlLineComment(line: string): string {
  let inQuote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuote) {
      if (ch === "\\" && inQuote === '"') {
        i++;
        continue;
      }
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === "#") return line.slice(0, i);
  }
  return line;
}

/** Unquote a YAML scalar (double, single, or bare). Empty / broken → null. */
function yamlScalar(raw: string): string | null {
  const t = raw.trim();
  if (t === "" || t === "~" || t === "null" || t === "Null" || t === "NULL") {
    return null;
  }
  if (t.startsWith('"')) {
    // Unterminated or empty double-quoted scalar → unusable.
    if (t.length < 2 || !t.endsWith('"')) return null;
    const inner = t.slice(1, -1);
    return inner === "" ? null : inner;
  }
  if (t.startsWith("'")) {
    if (t.length < 2 || !t.endsWith("'")) return null;
    const inner = t.slice(1, -1);
    return inner === "" ? null : inner;
  }
  return t;
}

/**
 * Parse goose's operator `config.yaml` for the active provider's model (#284).
 *
 * Shape (docs): `active_provider` + `providers.<id>.model`. Effort is global
 * env-only (`GOOSE_THINKING_EFFORT` / provider knobs) — never per-model on
 * disk, so we never invent one. Fail-soft: never throws; callers treat
 * `model: null` as "no selection known".
 *
 * Minimal line-oriented reader (no YAML dependency). Handles the documented
 * nesting depth and quoted/bare scalars; unexpected structure degrades to null.
 */
export function parseGooseSelectedModel(text: string): {
  model: string | null;
  /** Non-null only for clearly broken structure (callers still fail soft). */
  error: string | null;
} {
  if (text.trim() === "") {
    return { model: null, error: null };
  }

  type Line = { indent: number; key: string; value: string | null };
  const lines: Line[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const stripped = stripYamlLineComment(raw);
    if (stripped.trim() === "") continue;
    const indentMatch = /^(\s*)/.exec(stripped);
    const indent = indentMatch?.[1]?.length ?? 0;
    const body = stripped.trim();
    // Skip list items and other non-mapping shapes.
    if (body.startsWith("-") || body.startsWith("---")) continue;
    const colon = body.indexOf(":");
    if (colon < 0) continue;
    const key = body.slice(0, colon).trim();
    if (key === "") continue;
    const rest = body.slice(colon + 1);
    const value = rest.trim() === "" ? null : rest.trim();
    lines.push({ indent, key, value });
  }

  if (lines.length === 0) {
    // Present file with no parseable mappings — treat as unusable.
    return { model: null, error: "unexpected config.yaml shape" };
  }

  let activeProvider: string | null = null;
  for (const line of lines) {
    if (line.indent === 0 && line.key === "active_provider" && line.value !== null) {
      activeProvider = yamlScalar(line.value);
      break;
    }
  }
  if (activeProvider === null || activeProvider === "") {
    return { model: null, error: null };
  }

  // Locate `providers:` then the active provider block, then its `model:`.
  let providersIndent: number | null = null;
  let providerIndent: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (providersIndent === null) {
      if (line.key === "providers" && line.value === null) {
        providersIndent = line.indent;
      }
      continue;
    }
    if (line.indent <= providersIndent) {
      // Left the providers mapping without finding the active provider.
      break;
    }
    if (providerIndent === null) {
      if (line.indent > providersIndent && line.key === activeProvider) {
        providerIndent = line.indent;
        // Inline value on the provider key is not the model — keep scanning children.
      }
      continue;
    }
    if (line.indent <= providerIndent) {
      // Left this provider block.
      break;
    }
    if (line.key === "model" && line.value !== null) {
      const model = yamlScalar(line.value);
      if (model === null || model === "") {
        return { model: null, error: null };
      }
      return { model, error: null };
    }
  }
  return { model: null, error: null };
}

/**
 * Read the operator's goose selection from `config.yaml` under the operator
 * config directory (#284). Fail soft on every path — never throws.
 */
export function readGooseSelectedModel(
  env: NodeJS.ProcessEnv = process.env,
): SelectedModel | null {
  const home = resolveOperatorVendorHome("goose", env);
  if (home === null) return null;
  const configPath = path.join(home, OPERATOR_CONFIG_FILE);
  let text: string;
  try {
    const stat = fs.statSync(configPath);
    if (stat.size > GOOSE_CONFIG_MAX_BYTES) return null;
    text = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    if (isEnoent(err)) return null;
    return null;
  }
  const { model } = parseGooseSelectedModel(text);
  if (model === null || model === "") return null;
  // No per-model effort on disk — global env-only knobs are out of scope.
  return { model, effort: null };
}
