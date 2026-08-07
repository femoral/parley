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

  // Include message/body text so "fatal: …" inside type:"log" still classifies as error.
  const haystack = `${type} ${itemType} ${text}`.toLowerCase();

  const hasError = errorObj !== undefined || typeof obj.error === "string";
  if (
    hasError ||
    haystack.includes("error") ||
    haystack.includes("fail") ||
    haystack.includes("fatal")
  ) {
    return { kind: "error", text };
  }
  if (haystack.includes("question") || haystack.includes("ask")) return { kind: "question", text };
  if (haystack.includes("command") || haystack.includes("shell")) return { kind: "shell", text };
  if (haystack.includes("tool") || haystack.includes("function_call")) return { kind: "tool", text };
  if (
    type.toLowerCase().includes("message") ||
    type.toLowerCase().includes("reasoning") ||
    itemType.toLowerCase().includes("message") ||
    itemType.toLowerCase().includes("reasoning")
  ) {
    return { kind: "reasoning", text };
  }
  // Session hello envelope (cwd/pid/hub boilerplate) — collapsed in the log UI.
  if (isHelloEnvelope(obj, raw)) {
    return { kind: "fallback", text: summarizeHello(obj, text) };
  }
  return { kind: "fallback", text };
}

/** Vendor session-start JSON: cwd + pid + hub URL boilerplate. */
function isHelloEnvelope(obj: Obj, raw: string): boolean {
  const keys = Object.keys(obj).map((k) => k.toLowerCase());
  const has = (n: string) => keys.some((k) => k === n || k.includes(n));
  const score =
    (has("cwd") || has("workdir") || has("work_dir") ? 1 : 0) +
    (has("pid") ? 1 : 0) +
    (has("hub") || has("url") ? 1 : 0) +
    (has("session") ? 1 : 0);
  if (score >= 2) return true;
  // Long JSON dump with path-like cwd is almost always hello boilerplate.
  return raw.length > 200 && (has("cwd") || has("pid"));
}

function summarizeHello(obj: Obj, fallback: string): string {
  const cwd =
    asStr(obj.cwd) ??
    asStr(obj.workdir) ??
    asStr(obj.work_dir) ??
    asStr(asObj(obj.session)?.cwd);
  const pid = obj.pid != null ? String(obj.pid) : asStr(obj.pid);
  const bits = ["session hello"];
  if (cwd) bits.push(cwd.length > 48 ? `…${cwd.slice(-48)}` : cwd);
  if (pid) bits.push(`pid ${pid}`);
  return bits.length > 1 ? bits.join(" · ") : fallback.slice(0, 80);
}

/** True when a classified line is collapsed session-hello boilerplate. */
export function isHelloLogLine(line: Pick<LogLine, "kind" | "text" | "raw">): boolean {
  if (line.kind !== "fallback") return false;
  if (line.text.startsWith("session hello")) return true;
  try {
    const obj = asObj(JSON.parse(line.raw));
    return obj ? isHelloEnvelope(obj, line.raw) : false;
  } catch {
    return false;
  }
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
