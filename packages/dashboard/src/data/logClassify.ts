/**
 * Best-effort vendor log-line classifier for the console log tail.
 * Re-implemented from the coverage-audit semantics inventory (not imported
 * from packages/ui).
 */
import type { LogLine, LogLineKind } from "./types.js";

type Obj = Record<string, unknown>;

function asObj(v: unknown): Obj | undefined {
  return typeof v === "object" && v !== null ? (v as Obj) : undefined;
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Classify one raw log line into a kind + friendly display text. */
export function classifyLogLine(raw: string): { kind: LogLineKind; text: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "fallback", text: "" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
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

  const hasError = errorObj !== undefined || typeof obj.error === "string";
  if (hasError || haystack.includes("error") || haystack.includes("fail")) {
    return { kind: "error", text };
  }
  if (haystack.includes("question") || haystack.includes("ask")) return { kind: "question", text };
  if (haystack.includes("command") || haystack.includes("shell")) return { kind: "shell", text };
  if (haystack.includes("tool") || haystack.includes("function_call")) return { kind: "tool", text };
  if (haystack.includes("message") || haystack.includes("reasoning")) {
    return { kind: "reasoning", text };
  }
  return { kind: "fallback", text };
}

/** The log-tail window cap (last N classified lines). */
export const LOG_LINE_CAP = 60;

/**
 * Incremental log-tail accumulator: feed raw chunks; keep the last
 * {@link LOG_LINE_CAP} classified lines without re-parsing history.
 */
export class LogAccumulator {
  private partial = "";
  private readonly buffer: LogLine[] = [];

  /** Append a chunk; returns true when the classified window changed. */
  append(chunk: string): boolean {
    if (chunk.length === 0) return false;
    this.partial += chunk;
    let changed = false;
    let idx: number;
    while ((idx = this.partial.indexOf("\n")) !== -1) {
      const raw = this.partial.slice(0, idx);
      this.partial = this.partial.slice(idx + 1);
      if (raw.length === 0) continue;
      const { kind, text } = classifyLogLine(raw);
      this.buffer.push({ kind, text, raw });
      if (this.buffer.length > LOG_LINE_CAP) this.buffer.shift();
      changed = true;
    }
    return changed;
  }

  /**
   * At eof, flush a trailing partial line (no final newline). Returns true
   * when a line was added.
   */
  flush(): boolean {
    if (this.partial.length === 0) return false;
    const raw = this.partial;
    this.partial = "";
    const { kind, text } = classifyLogLine(raw);
    this.buffer.push({ kind, text, raw });
    if (this.buffer.length > LOG_LINE_CAP) this.buffer.shift();
    return true;
  }

  lines(): LogLine[] {
    return this.buffer.slice();
  }
}
