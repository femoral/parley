import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import parleyProvenance from "../src/index.js";

const PARLEY_ENV = [
  "PARLEY_SESSION_ID",
  "PARLEY_HARNESS",
  "PARLEY_MODEL",
  "PARLEY_EFFORT",
] as const;

type Handler = (...args: unknown[]) => void;

function extensionHarness(thinkingLevel = "high") {
  const handlers = new Map<string, Handler>();
  const pi = {
    on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    getThinkingLevel: vi.fn(() => thinkingLevel),
  };

  parleyProvenance(pi as never);
  return { handlers, pi };
}

describe("Pi session provenance extension", () => {
  beforeEach(() => {
    for (const name of PARLEY_ENV) delete process.env[name];
  });

  afterEach(() => {
    for (const name of PARLEY_ENV) delete process.env[name];
  });

  it("registers all deterministic provenance handlers", () => {
    const { handlers } = extensionHarness();

    expect([...handlers.keys()]).toEqual([
      "session_start",
      "model_select",
      "thinking_level_select",
    ]);
  });

  it("sets fresh-session provenance from Pi runtime state", () => {
    const { handlers, pi } = extensionHarness("xhigh");

    handlers.get("session_start")?.(
      { reason: "startup" },
      {
        sessionManager: { getSessionId: () => "pi-session-123" },
        model: { provider: "anthropic", id: "claude-sonnet-4" },
      },
    );

    expect(process.env.PARLEY_SESSION_ID).toBe("pi-session-123");
    expect(process.env.PARLEY_HARNESS).toBe("pi");
    expect(process.env.PARLEY_MODEL).toBe("anthropic/claude-sonnet-4");
    expect(process.env.PARLEY_EFFORT).toBe("xhigh");
    expect(pi.getThinkingLevel).toHaveBeenCalledOnce();
  });

  it("removes stale model provenance when the session has no model", () => {
    process.env.PARLEY_MODEL = "stale/model";
    const { handlers } = extensionHarness("off");

    handlers.get("session_start")?.(
      { reason: "startup" },
      {
        sessionManager: { getSessionId: () => "model-less-session" },
        model: undefined,
      },
    );

    expect(process.env.PARLEY_MODEL).toBeUndefined();
  });

  it("keeps model and effort current after runtime selections", () => {
    const { handlers } = extensionHarness();

    handlers.get("model_select")?.({
      model: { provider: "openai", id: "gpt-5" },
    });
    handlers.get("thinking_level_select")?.({ level: "medium" });

    expect(process.env.PARLEY_MODEL).toBe("openai/gpt-5");
    expect(process.env.PARLEY_EFFORT).toBe("medium");
  });
});
