import { describe, expect, it } from "vitest";
import { classifyLogLine, LogAccumulator, LOG_LINE_CAP } from "../../src/data/logClassify.js";

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
