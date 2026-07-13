import { describe, expect, it } from "vitest";
import { buildLogLines, classifyLogLine, LogAccumulator } from "../src/app/hooks/logClassify.js";

describe("classifyLogLine classifies raw vendor log lines by kind (#68)", () => {
  it("classifies a codex-shaped reasoning/agent-message line", () => {
    const line = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Surveying the bay." } });
    expect(classifyLogLine(line)).toEqual({ kind: "reasoning", text: "Surveying the bay." });
  });

  it("classifies a codex-shaped shell/command line", () => {
    const line = JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "ls -la" } });
    expect(classifyLogLine(line)).toEqual({ kind: "shell", text: "ls -la" });
  });

  it("classifies a line as error from an error field alone, even under a neutral type", () => {
    const line = JSON.stringify({ type: "note", error: { message: "boom" } });
    expect(classifyLogLine(line)).toEqual({ kind: "error", text: "boom" });
  });

  it("classifies a codex-shaped fatal-error line", () => {
    const line = JSON.stringify({ type: "turn.failed", error: { message: "the ship ran aground" } });
    expect(classifyLogLine(line)).toEqual({ kind: "error", text: "the ship ran aground" });
  });

  it("classifies a tool_result line", () => {
    const line = JSON.stringify({ type: "tool_result", tool: "submit_report", ok: true });
    expect(classifyLogLine(line)).toEqual({ kind: "tool", text: "tool_result: submit_report" });
  });

  it("classifies a question-raising line", () => {
    const line = JSON.stringify({ type: "question.raised", question: "Which shoal?" });
    expect(classifyLogLine(line).kind).toBe("question");
  });

  it("falls back to a raw dump for an unrecognised JSON shape (unknown lines still shown)", () => {
    const line = JSON.stringify({ type: "thread.started", thread_id: "t-1" });
    const result = classifyLogLine(line);
    expect(result.kind).toBe("fallback");
    expect(result.text).toBe(line);
  });

  it("treats non-JSON output as plain stdout, not dropped", () => {
    expect(classifyLogLine("plain text from the child process")).toEqual({
      kind: "stdout",
      text: "plain text from the child process",
    });
  });

  it("treats a blank line as an empty fallback", () => {
    expect(classifyLogLine("   ")).toEqual({ kind: "fallback", text: "" });
  });
});

describe("buildLogLines splits, classifies, and caps a raw buffer (#68)", () => {
  it("classifies each non-empty line and assigns a stable absolute-position key", () => {
    const raw = ["one", JSON.stringify({ type: "turn.failed", error: { message: "boom" } }), "", "three"].join("\n");
    const lines = buildLogLines(raw);
    expect(lines).toEqual([
      { key: 0, kind: "stdout", text: "one" },
      { key: 1, kind: "error", text: "boom" },
      { key: 2, kind: "stdout", text: "three" },
    ]);
  });

  it("keeps only the last `cap` lines but preserves their absolute keys", () => {
    const raw = Array.from({ length: 5 }, (_, i) => `line-${i}`).join("\n");
    const lines = buildLogLines(raw, 2);
    expect(lines).toEqual([
      { key: 3, kind: "stdout", text: "line-3" },
      { key: 4, kind: "stdout", text: "line-4" },
    ]);
  });

  it("returns an empty list for an empty buffer", () => {
    expect(buildLogLines("")).toEqual([]);
  });
});

describe("LogAccumulator classifies incrementally across chunk boundaries (#68)", () => {
  it("holds a line split across two chunks until its newline arrives", () => {
    const acc = new LogAccumulator();
    expect(acc.append("hel")).toBe(false);
    expect(acc.lines()).toEqual([]);
    expect(acc.append("lo\nworld\n")).toBe(true);
    expect(acc.lines()).toEqual([
      { key: 0, kind: "stdout", text: "hello" },
      { key: 1, kind: "stdout", text: "world" },
    ]);
  });

  it("reports no change for an idle (empty) chunk", () => {
    const acc = new LogAccumulator();
    acc.append("one\n");
    expect(acc.append("")).toBe(false);
  });

  it("flush renders the trailing line-in-progress (the eof case)", () => {
    const acc = new LogAccumulator();
    acc.append("done, no trailing newline");
    expect(acc.lines()).toEqual([]);
    expect(acc.flush()).toBe(true);
    expect(acc.lines()).toEqual([{ key: 0, kind: "stdout", text: "done, no trailing newline" }]);
  });

  it("caps the window while keeping absolute-position keys, without re-parsing old lines", () => {
    const acc = new LogAccumulator(2);
    acc.append("a\nb\nc\n");
    expect(acc.lines()).toEqual([
      { key: 1, kind: "stdout", text: "b" },
      { key: 2, kind: "stdout", text: "c" },
    ]);
  });

  it("keeps line-object identity stable across appends (memo-friendly)", () => {
    const acc = new LogAccumulator();
    acc.append("a\n");
    const [first] = acc.lines();
    acc.append("b\n");
    expect(acc.lines()[0]).toBe(first);
  });
});
