import { describe, expect, it } from "vitest";
import {
  classifyLogLine,
  isHelloLogLine,
  LogAccumulator,
  LOG_LINE_CAP,
} from "../../src/data/logClassify.js";

describe("classifyLogLine", () => {
  it("cascades keyword kinds: error > question > shell > tool > reasoning", () => {
    expect(classifyLogLine(JSON.stringify({ type: "error", message: "boom" })).kind).toBe(
      "error",
    );
    expect(
      classifyLogLine(JSON.stringify({ type: "question", text: "wait?" })).kind,
    ).toBe("question");
    expect(
      classifyLogLine(JSON.stringify({ type: "command", text: "ls" })).kind,
    ).toBe("shell");
    expect(
      classifyLogLine(JSON.stringify({ type: "tool_result", tool: "Read" })).kind,
    ).toBe("tool");
    expect(
      classifyLogLine(JSON.stringify({ type: "reasoning", text: "hmm" })).kind,
    ).toBe("reasoning");
  });

  it("classifies fatal lines as error (kind color path)", () => {
    const line = classifyLogLine(JSON.stringify({ type: "fatal", message: "process died" }));
    expect(line.kind).toBe("error");
    expect(line.text).toMatch(/process died/);
  });

  it("classifies fatal inside message text even when type is log", () => {
    const line = classifyLogLine(
      JSON.stringify({ type: "log", message: "fatal: process died" }),
    );
    expect(line.kind).toBe("error");
    expect(line.text).toMatch(/fatal:/);
  });

  it("does not misclassify ordinary lines via bare message-text includes", () => {
    // "task" contains "ask" as a substring — must not become question.
    expect(
      classifyLogLine(
        JSON.stringify({ type: "stdout", text: "starting task 5 of 9" }),
      ).kind,
    ).toBe("fallback");
    // "toolchain" contains "tool" — must not become tool.
    expect(
      classifyLogLine(
        JSON.stringify({ type: "stdout", text: "downloading toolchain" }),
      ).kind,
    ).toBe("fallback");
    // "failures" contains "fail" — must not paint red as error.
    expect(
      classifyLogLine(
        JSON.stringify({ type: "log", message: "no failures detected" }),
      ).kind,
    ).toBe("fallback");
  });

  it("classifies anchored fatal: on extracted message as error", () => {
    const line = classifyLogLine(
      JSON.stringify({ type: "log", message: "fatal: process died" }),
    );
    expect(line.kind).toBe("error");
  });

  it("summarizes session hello envelopes for collapse", () => {
    const raw = JSON.stringify({
      cwd: "/tmp/work/abc",
      pid: 4242,
      hub_url: "http://127.0.0.1:7777",
    });
    const line = classifyLogLine(raw);
    expect(line.kind).toBe("fallback");
    expect(line.text).toMatch(/session hello/);
    expect(isHelloLogLine({ kind: line.kind, text: line.text, raw })).toBe(true);
  });

  it("still collapses hello when embedded prompt mentions ask/fail/error", () => {
    const raw = JSON.stringify({
      type: "hello",
      cwd: "/tmp/work/abc",
      pid: 99,
      hub_url: "http://127.0.0.1:7777",
      prompt:
        "You may ask_orchestrator when stuck; report failures; error recovery is automatic.",
    });
    const line = classifyLogLine(raw);
    expect(line.kind).toBe("fallback");
    expect(line.text).toMatch(/session hello/);
    expect(isHelloLogLine({ kind: line.kind, text: line.text, raw })).toBe(true);
  });

  it("treats plain text as stdout", () => {
    expect(classifyLogLine("hello world").kind).toBe("stdout");
  });
});

describe("LogAccumulator", () => {
  it("classifies complete lines and buffers a trailing partial", () => {
    const acc = new LogAccumulator();
    expect(acc.append('{"type":"tool","tool":"A"}\n{"type":"tool","tool":"B"}')).toBe(true);
    expect(acc.lines()).toHaveLength(1);
    expect(acc.lines()[0]!.kind).toBe("tool");
    // Partial second line — flush at eof.
    expect(acc.flush()).toBe(true);
    expect(acc.lines()).toHaveLength(2);
  });

  it("caps the window at LOG_LINE_CAP", () => {
    const acc = new LogAccumulator();
    let chunk = "";
    for (let i = 0; i < LOG_LINE_CAP + 10; i++) {
      chunk += `line-${i}\n`;
    }
    acc.append(chunk);
    expect(acc.lines()).toHaveLength(LOG_LINE_CAP);
    expect(acc.lines()[0]!.raw).toBe("line-10");
  });
});
