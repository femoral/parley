/**
 * Layer 4 (hooks) — the raw vendor log-line classifier (design-manifest §2.8,
 * §4.17 "Logs": "raw JSON lines colored by kind"; §7's implementation notes
 * call out porting "the log-line classifier (kind → level/color and raw-JSON
 * → friendly text)" from the design prototype). No such classifier exists in
 * the daemon or core — `vendor.jsonl` is the raw, unnormalized stdout of
 * whichever vendor ran (docs/spec/ui-interface-contract.md's logs endpoint;
 * each adapter's own event shape, e.g. codex's `item.completed`/`turn.failed`,
 * is never reshaped before it hits disk). This is therefore a best-effort,
 * vendor-agnostic heuristic over common JSON shapes, not a decode of a fixed
 * schema — unrecognised shapes fall back to a raw, still-legible line rather
 * than being dropped (the manifest's raw log is a durable record; "unknown
 * lines included").
 */
import type { LogLine } from "../../hud/types.js";

type Obj = Record<string, unknown>;

function asObj(v: unknown): Obj | undefined {
  return typeof v === "object" && v !== null ? (v as Obj) : undefined;
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Classify one raw log line into a kind + friendly display text. */
export function classifyLogLine(raw: string): { kind: LogLine["kind"]; text: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "fallback", text: "" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Plain non-JSON output (a shell echo, a stray print) — still a real line.
    return { kind: "stdout", text: trimmed };
  }
  const obj = asObj(parsed);
  if (!obj) return { kind: "stdout", text: trimmed };

  const item = asObj(obj.item);
  const type = asStr(obj.type) ?? asStr(obj.kind) ?? "";
  const itemType = item ? (asStr(item.type) ?? "") : "";
  const haystack = `${type} ${itemType}`.toLowerCase();

  const errorObj = asObj(obj.error);
  const text =
    (item && asStr(item.text)) ||
    (item && asStr(item.command)) ||
    asStr(obj.message) ||
    asStr(obj.text) ||
    asStr(obj.note) ||
    asStr(obj.error) ||
    (errorObj && asStr(errorObj.message)) ||
    (asStr(obj.tool) && `${type || "tool_result"}: ${asStr(obj.tool)}`) ||
    trimmed;

  // An error field is as strong a signal as an error-y type string — a bare
  // `{"error": {...}}` line under a neutral type must not badge as fallback
  // while its display text was pulled from that very error.
  const hasError = errorObj !== undefined || typeof obj.error === "string";
  if (hasError || haystack.includes("error") || haystack.includes("fail")) {
    return { kind: "error", text };
  }
  if (haystack.includes("question") || haystack.includes("ask")) return { kind: "question", text };
  if (haystack.includes("command") || haystack.includes("shell")) return { kind: "shell", text };
  if (haystack.includes("tool") || haystack.includes("function_call")) return { kind: "tool", text };
  if (haystack.includes("message") || haystack.includes("reasoning")) return { kind: "reasoning", text };
  return { kind: "fallback", text };
}

/** The manifest's Logs-tab window: "last 60" raw lines. */
export const LOG_LINE_CAP = 60;

/**
 * Incremental log-tail accumulator: feed it raw chunks as they arrive and it
 * maintains the classified last-{@link LOG_LINE_CAP} window. Each chunk is
 * split/classified exactly once (never re-parsing the already-seen log —
 * a multi-hour chatty task must not cost O(total log) per poll tick) and
 * dropped from memory once classified, so a long tail holds only the capped
 * window plus the trailing incomplete line. Keys are the line's absolute
 * position in the stream, so they stay stable and unique as the window slides.
 */
export class LogAccumulator {
  private partial = "";
  private counter = 0;
  private window: LogLine[] = [];

  constructor(private readonly cap = LOG_LINE_CAP) {}

  /** Classify a newly arrived chunk's complete lines; true when the window changed. */
  append(chunk: string): boolean {
    if (!chunk) return false;
    const parts = (this.partial + chunk).split("\n");
    this.partial = parts.pop() ?? "";
    let changed = false;
    for (const raw of parts) {
      changed = this.push(raw) || changed;
    }
    return changed;
  }

  /** Classify the trailing line-in-progress (call at eof — no newline is coming). */
  flush(): boolean {
    const raw = this.partial;
    this.partial = "";
    return this.push(raw);
  }

  /** The current window, as a fresh array with identity-stable line objects. */
  lines(): LogLine[] {
    return [...this.window];
  }

  private push(raw: string): boolean {
    if (!raw.trim()) return false;
    this.window.push({ key: this.counter, ...classifyLogLine(raw) });
    this.counter += 1;
    if (this.window.length > this.cap) this.window.shift();
    return true;
  }
}

/**
 * Split a full raw log buffer into classified {@link LogLine}s, keeping only
 * the last `cap` with stable absolute-position keys. One-shot counterpart of
 * {@link LogAccumulator} for callers that already hold the whole text.
 */
export function buildLogLines(raw: string, cap = LOG_LINE_CAP): LogLine[] {
  const acc = new LogAccumulator(cap);
  acc.append(raw);
  acc.flush();
  return acc.lines();
}
