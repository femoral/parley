import type {
  AdapterEnforcement,
  ModelEntry,
  ProbedModels,
  SpawnPlan,
  TaskSpec,
  VendorAdapter,
  VendorEvent,
} from "./types.js";
import { VENDOR_DIAG_PREFIX, withPostureDiagnostics } from "./types.js";
import { runProbe } from "./probe.js";

/**
 * The `antigravity` vendor adapter — real delegation to Google's Antigravity
 * CLI (`agy` binary, #286 / ADR-0026). Verified against `agy` v1.1.7
 * (2026-08-02); see `docs/research/antigravity-cli-automation.md` for the
 * surface. Breaking rename of the retired `gemini` vendor id — no alias
 * (ADR-0026).
 *
 * Headless one-shot (research §2 / §9):
 *   agy --output-format stream-json --dangerously-skip-permissions
 *       --model <id> [--effort low|medium|high]
 *       [--add-dir …] --print-timeout <budget> -p <prompt>
 *
 * Structured output is NDJSON (`event` discriminator with nested payload) even
 * though `--output-format` is absent from 1.1.7 `--help` (research §2). Exit
 * codes lie both ways — success requires `result.status === "SUCCESS"` **and**
 * a non-empty `response` **and** no `jetski: no output produced` stderr line
 * (research §2/§5).
 *
 * Child channel is **http** (ADR-0026 amendment / #298), not MCP. Research
 * §3/§9's per-task-HOME + stdio MCP bridge recipe was verified but **rejected
 * for parley**: agy's MCP config is global-only under `$HOME/.gemini`, so
 * per-task injection forced either credential copying into the task tree or
 * mutation of the operator's `mcp_config.json`. Neither is acceptable. The
 * engine already injects `PARLEY_HUB_URL` / `PARLEY_TASK_ID` and teaches the
 * child REST surface (`POST /child/report`, `POST /child/ask`) in the protocol
 * preamble when `childChannel: "http"` (ADR-0011). No MaterializedFiles, no
 * HOME override, no write to the operator's mcp config.
 *
 * Spawns against the operator's real `~/.gemini` (no `HOME` override —
 * deliberate deviation from research §3/§9; see ADR-0026). Auth and
 * `--conversation` resume work natively. Conversation-store sharing across
 * concurrent tasks is accepted (same posture as kimi/codex, ADR-0025).
 *
 * Effort: only `low|medium|high` (research §6). Strip only those suffixes when
 * parsing `agy models`; `-thinking` is part of the model id. Suffixless models
 * (e.g. `claude-sonnet-4-6`) reject `--effort` entirely — never pass it unless
 * `task.effort` is set (allowlist is the spawn authority). Discovery is a real
 * `listModels` probe with efforts (ADR-0026) — not a hand-maintained id list.
 *
 * Network: no lever at all (research §5). Refuse `network:false` for every
 * sandbox value rather than under-isolate (ADR-0023). Do not pass `--sandbox`
 * (fails open). `--mode plan|accept-edits` are no-ops in print mode — do not
 * map postures onto them.
 *
 * `sandbox=read-only` stays approximate: without a private home we cannot
 * inject `permissions.allow`, and reporting over http needs a command tool
 * (curl) the RO allowlist would not grant. Headless default still auto-denies
 * permissioned tools unless `--dangerously-skip-permissions` is set.
 */

/** Default binary; override via `PARLEY_ANTIGRAVITY_BIN` (smoke tests, custom installs). */
const DEFAULT_ANTIGRAVITY_BIN = "agy";

/** Probe command recorded as catalog `source` on refresh (research §7). */
const MODELS_SOURCE = "agy models";

/**
 * Effort suffixes stripped from piped/TTY model listing ids (research §6/§7).
 * Only these three — never `-thinking` or any other trailing token.
 */
const EFFORT_SUFFIX_RE = /-(high|medium|low)$/;

/** Valid `--effort` values (research §6). */
const VALID_EFFORTS = new Set(["low", "medium", "high"]);

/**
 * Headless auto-deny diagnostic (research §2/§5). The only failure signal when
 * tools are permission-denied with exit 0 + empty SUCCESS response.
 */
const JETSKI_DENY_RE = /^jetski:\s*no output produced/i;

/** Antigravity posture declaration (research §5, ADR-0023). */
const ANTIGRAVITY_ENFORCEMENT: AdapterEnforcement = {
  "read-only": {
    level: "approximate",
    via: "omit dangerously-skip-permissions; no private-home permissions.allow inject (#298); host-wide reads, silent deny on write/command",
  },
  workspace: {
    level: "none",
    via: "dangerously-skip-permissions; no write confinement (path-scoped allow rules do not work)",
  },
  full: {
    level: "enforced",
    via: "dangerously-skip-permissions, no --sandbox",
  },
  "network:false": {
    level: "refused",
    via: "no network lever exists (research §5); prepare refuses rather than under-isolate",
  },
};

/**
 * Loud capability gap: refuse network:false for every sandbox (research §5
 * gotcha 12). Call before building argv so the task fails with a clear error.
 */
export function assertAntigravityNetworkPosture(task: TaskSpec): void {
  if (task.network) return;
  throw new Error(
    `antigravity: network:false is not enforced for sandbox=${task.sandbox} ` +
      `(agy has no network lever — research §5). Refuse rather than under-isolate. ` +
      `Use network:true, or wrap the child in a real netns/container.`,
  );
}

/**
 * Format `answerTimeoutMs` as a Go duration for `--print-timeout` (research
 * §2 default `5m0s`). Ceiling to whole seconds so short timeouts never round
 * to zero.
 */
export function formatPrintTimeout(answerTimeoutMs: number): string {
  const totalSec = Math.max(1, Math.ceil(Math.max(0, answerTimeoutMs) / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}m${seconds}s`;
}

/**
 * Parse `agy models` stdout into catalog entries (research §7).
 *
 * Piped form (what probes get): one id per line, no labels.
 * TTY form: `id<spaces>label` — split on the first run of 2+ spaces.
 *
 * Strip only trailing `-high`/`-medium`/`-low` → base id + effort. Collect
 * efforts per base id only from listed rows — never synthesize.
 *
 * Label capture: the TTY two-column branch is kept for unit tests and for a
 * future settings-selection feature that needs the label↔id bridge (settings
 * store a display *label*, not an id — research §7). Real `listModels` probes
 * pipe stdout, so labels are never present on the refresh path; reviving them
 * requires allocating a pty for `agy models`.
 */
export function parseAgyModels(text: string): ModelEntry[] {
  // Map base id → { efforts (order preserved), label? }
  const byId = new Map<string, { efforts: string[]; seen: Set<string>; label?: string }>();

  for (const rawLine of text.split(/\r?\n/)) {
    // Strip spinner/ANSI residue that can precede TTY rows (research §7).
    // eslint-disable-next-line no-control-regex -- intentional ESC CSI strip; research §7 TTY spinner/ANSI
    const line = rawLine.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "").trim();
    if (line === "") continue;
    // Drop spinner / status chatter that is not a model row.
    if (/^fetching available models/i.test(line)) continue;
    if (/^error:/i.test(line)) continue;

    let idPart = line;
    let label: string | undefined;
    // TTY-only label column (research §7). Unreachable on piped probes —
    // keep for tests / future pty allocation; do not invent labels from ids.
    const split = line.match(/^(\S+)\s{2,}(.+)$/);
    if (split) {
      idPart = split[1]!;
      label = split[2]!.trim();
      if (label === "") label = undefined;
    }

    const effortMatch = EFFORT_SUFFIX_RE.exec(idPart);
    let baseId = idPart;
    let effort: string | undefined;
    if (effortMatch) {
      baseId = idPart.slice(0, effortMatch.index);
      effort = effortMatch[1];
    }
    if (baseId === "") continue;

    let entry = byId.get(baseId);
    if (entry === undefined) {
      entry = { efforts: [], seen: new Set() };
      byId.set(baseId, entry);
    }
    if (effort !== undefined && VALID_EFFORTS.has(effort) && !entry.seen.has(effort)) {
      entry.seen.add(effort);
      entry.efforts.push(effort);
    }
    // Prefer the first non-empty label we see for this base id.
    if (label !== undefined && entry.label === undefined) {
      entry.label = label;
    }
  }

  const models: ModelEntry[] = [];
  for (const [id, data] of byId) {
    models.push({
      id,
      efforts: data.efforts,
      default_effort: null,
      ...(data.label !== undefined ? { label: data.label } : {}),
    });
  }
  if (models.length === 0) {
    throw new Error("agy models: no model ids parsed from output");
  }
  return models;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Map `result.usage` into a usage bag (research §8). Prefer result.usage as
 * authoritative over per-step usage. Expose harness field names as-is plus
 * canonical `cached_tokens` from `cache_read_tokens` when present.
 */
function usageFromAgy(usageObj: unknown): Record<string, number> | undefined {
  const obj = asRecord(usageObj);
  if (!obj) return undefined;
  const usage: Record<string, number> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "number") usage[key] = value;
  }
  if (typeof obj.cache_read_tokens === "number") {
    usage.cached_tokens = obj.cache_read_tokens;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export function createAntigravityAdapter(
  env: NodeJS.ProcessEnv = process.env,
): VendorAdapter {
  const bin = env.PARLEY_ANTIGRAVITY_BIN ?? DEFAULT_ANTIGRAVITY_BIN;

  /**
   * Flags shared by fresh runs and resumes (research §2 / §9). Prompt is always
   * `-p <arg>` last among known flags so extraArgs stay unambiguous.
   */
  function commonArgv(task: TaskSpec): string[] {
    const argv: string[] = ["--output-format", "stream-json"];
    // Headless default denies every permissioned tool — including reads —
    // with exit 0 + empty SUCCESS (research §5). Always grant for workspace/full.
    if (task.sandbox !== "read-only") {
      argv.push("--dangerously-skip-permissions");
    }
    // Do NOT pass --sandbox (fails open — research §5 gotcha 11).
    // Do NOT pass --mode plan|accept-edits (no-ops in print mode — gotcha 14).
    if (task.model !== null && task.model !== "") {
      // Base id only — never a flattened effort-suffixed display id (§6/§9).
      argv.push("--model", task.model);
    }
    if (task.effort !== null && task.effort !== "") {
      // Only when set. Suffixless models hard-reject --effort (research §6 Q3);
      // the allowlist is the authority that prevents that combo at spawn.
      argv.push("--effort", task.effort);
    }
    if (task.gitDir !== undefined && task.gitDir !== "") {
      argv.push("--add-dir", task.gitDir);
    }
    if (
      task.gitCommonDir !== undefined &&
      task.gitCommonDir !== "" &&
      task.gitCommonDir !== task.gitDir
    ) {
      argv.push("--add-dir", task.gitCommonDir);
    }
    argv.push("--print-timeout", formatPrintTimeout(task.answerTimeoutMs));
    // extraArgs in the flags region (prompt is a separate -p value).
    argv.push(...task.extraArgs);
    return argv;
  }

  function spawnPlan(task: TaskSpec, resumeSessionId: string | undefined): SpawnPlan {
    assertAntigravityNetworkPosture(task);
    const argv = [bin, ...commonArgv(task)];
    if (resumeSessionId !== undefined) {
      argv.push("--conversation", resumeSessionId);
    }
    argv.push("-p", task.prompt);
    return {
      argv,
      // No HOME override — operator's real ~/.gemini (ADR-0026 / #298).
      // Engine injects PARLEY_HUB_URL / PARLEY_TASK_ID for the http channel.
      env: {},
      // No MaterializedFiles: no credential copy, no MCP bridge, no settings inject.
      files: [],
      cwd: task.cwd,
    };
  }

  return withPostureDiagnostics({
    id: "antigravity",
    // Engine preamble teaches curl → POST /child/report|ask (ADR-0011 / #298).
    childChannel: "http",
    enforcement: ANTIGRAVITY_ENFORCEMENT,

    prepare(task, _hub): Promise<SpawnPlan> {
      try {
        return Promise.resolve(spawnPlan(task, undefined));
      } catch (err) {
        return Promise.reject(err);
      }
    },

    resume(task, _hub): Promise<SpawnPlan> {
      // Spawn-per-turn resume (research §4): --conversation <uuid> against the
      // operator home (same real ~/.gemini as prepare — #298; conversations
      // live there). Without a session id, agy would start fresh or --continue
      // the wrong concurrent session — reject like gemini/grok.
      if (task.sessionId === undefined) {
        return Promise.reject(
          new Error(`antigravity resume for task ${task.id} has no session id`),
        );
      }
      try {
        return Promise.resolve(spawnPlan(task, task.sessionId));
      } catch (err) {
        return Promise.reject(err);
      }
    },

    parseEvent(line: string): VendorEvent[] {
      // stderr dual-feed (engine): jetski denial diagnostic (research §2/§5/§9).
      if (JETSKI_DENY_RE.test(line)) {
        return [
          {
            kind: "error",
            text: `${VENDOR_DIAG_PREFIX} ${line}`,
            fatal: true,
          },
        ];
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return []; // opaque non-JSON
      }
      const event = asRecord(parsed);
      if (!event) return [];

      // Envelope is doubly nested: {"event":"result","result":{…}} (research §2).
      const kind = asString(event.event);
      if (kind === "") return [];

      switch (kind) {
        case "init": {
          // conversation_id at envelope level and inside init (research §4).
          const init = asRecord(event.init);
          const sessionId =
            asString(event.conversation_id) ||
            (init ? asString(init.conversation_id) : "");
          const model = init ? asString(init.model) : "";
          const meta: VendorEvent = { kind: "session_meta" };
          if (sessionId !== "") meta.session_id = sessionId;
          if (model !== "") meta.model = model;
          return sessionId !== "" || model !== "" ? [meta] : [];
        }

        case "step_update": {
          const step = asRecord(event.step_update);
          if (!step) return [];
          const stepType = asString(step.step_type);
          const state = asString(step.state);

          if (stepType === "agent_response") {
            const text = asString(step.text_delta);
            return text !== "" ? [{ kind: "message", text }] : [];
          }
          if (stepType === "tool" && state === "ACTIVE") {
            const name = asString(step.tool_name);
            const info = asRecord(step.tool_info);
            const params = info?.parameters;
            const text =
              params !== undefined
                ? `${name} ${JSON.stringify(params)}`
                : name;
            return name !== "" ? [{ kind: "command", text }] : [];
          }
          // tool DONE, user_input, checkpoint, unknown, anything new → opaque
          // (research §9 — never error on unknown step_type).
          return [];
        }

        case "result": {
          const result = asRecord(event.result);
          if (!result) return [];
          const status = asString(result.status);
          const response = asString(result.response);
          const usage = usageFromAgy(result.usage);
          const conversationId =
            asString(result.conversation_id) || asString(event.conversation_id);

          if (status === "ERROR" || status === "error") {
            const errText = asString(result.error) || "antigravity result status ERROR";
            const events: VendorEvent[] = [
              { kind: "error", text: errText, fatal: true },
            ];
            if (usage !== undefined || conversationId !== "") {
              const meta: VendorEvent = { kind: "session_meta" };
              if (usage !== undefined) meta.usage = usage;
              if (conversationId !== "") meta.session_id = conversationId;
              events.push(meta);
            }
            return events;
          }

          if (status === "SUCCESS" || status === "success") {
            // Success triple (research §2/§5/§9): SUCCESS + non-empty response
            // + no jetski line. Empty response is the silent auto-deny case.
            if (response.trim() === "") {
              const events: VendorEvent[] = [
                {
                  kind: "error",
                  text:
                    `${VENDOR_DIAG_PREFIX} antigravity result SUCCESS with empty response ` +
                    `(tools auto-denied in headless mode — research §5). ` +
                    `Pass --dangerously-skip-permissions.`,
                  fatal: true,
                },
              ];
              if (usage !== undefined || conversationId !== "") {
                const meta: VendorEvent = { kind: "session_meta" };
                if (usage !== undefined) meta.usage = usage;
                if (conversationId !== "") meta.session_id = conversationId;
                events.push(meta);
              }
              return events;
            }
            // Non-empty success — usage + session id; optional final message
            // is already streamed via step_update agent_response deltas.
            if (usage !== undefined || conversationId !== "") {
              const meta: VendorEvent = { kind: "session_meta" };
              if (usage !== undefined) meta.usage = usage;
              if (conversationId !== "") meta.session_id = conversationId;
              return [meta];
            }
            return [];
          }

          // Unknown status — opaque.
          return [];
        }

        default:
          // Unknown/changed event kinds must never fail the task (research §9).
          return [];
      }
    },

    sessionId(events: VendorEvent[]): string | undefined {
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (event?.kind === "session_meta" && event.session_id !== undefined) {
          return event.session_id;
        }
      }
      return undefined;
    },

    async listModels(): Promise<ProbedModels> {
      // Piped stdout is ids-only (research §7) — labels need a pty and are
      // unreachable on this path. Parse ids + effort suffixes only.
      // readModels omitted: no on-disk catalog (issue #286 out of scope).
      const stdout = await runProbe(bin, ["models"]);
      return { source: MODELS_SOURCE, models: parseAgyModels(stdout) };
    },
  });
}
