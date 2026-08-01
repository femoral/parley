import { afterEach, describe, expect, it } from "vitest";
import { parseToml } from "../src/adapters/toml.js";
import { parseKimiModelsConfig } from "../src/adapters/kimi.js";

afterEach(() => {
  // Pollution must never stick across tests.
  expect(Object.prototype).not.toHaveProperty("POLLUTED_MARKER");
  expect(Object.prototype).not.toHaveProperty("POLLUTED");
  expect(Object.prototype).not.toHaveProperty("owned");
  expect(Object.prototype).not.toHaveProperty("injected");
  expect(Object.prototype).not.toHaveProperty("default_effort");
});

describe("parseToml prototype pollution guards (finding 1)", () => {
  it("does not pollute Object.prototype via [__proto__]", () => {
    parseToml(`[__proto__]\nPOLLUTED_MARKER = "yes"\n`);
    expect(({} as Record<string, unknown>).POLLUTED_MARKER).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("POLLUTED_MARKER");
  });

  it("does not pollute via nested [__proto__.injected]", () => {
    parseToml(`[__proto__.injected]\nkey = "x"\n`);
    expect(({} as Record<string, unknown>).injected).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("injected");
  });

  it("does not pollute via constructor / prototype segments", () => {
    parseToml(`[constructor.prototype]\nowned = true\n`);
    parseToml(`constructor = "nope"\n`);
    parseToml(`prototype = "nope"\n`);
    expect(({} as Record<string, unknown>).owned).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("owned");
  });

  it("does not invent default_effort on a later clean parse via [models.__proto__]", () => {
    // First parse tries to plant default_effort on the prototype.
    parseToml(`[models.__proto__]\ndefault_effort = "PWNED"\n`);
    // Clean config must not pick up the planted field.
    const { models } = parseKimiModelsConfig(
      `[models."real"]\nsupport_efforts = [ "low" ]\n`,
    );
    expect(models).toEqual([
      { id: "real", efforts: ["low"], default_effort: null },
    ]);
    expect(models[0]!.default_effort).not.toBe("PWNED");
  });

  it("still parses legitimate model tables after hostile input", () => {
    parseToml(`[__proto__]\nPOLLUTED = "yes"\n`);
    const root = parseToml(
      `default_model = "kimi-code/k3"\n[models."kimi-code/k3"]\nsupport_efforts = [ "low", "high" ]\ndefault_effort = "high"\n`,
    );
    expect(root.default_model).toBe("kimi-code/k3");
    const models = root.models as Record<string, Record<string, unknown>>;
    expect(models["kimi-code/k3"]).toMatchObject({
      support_efforts: ["low", "high"],
      default_effort: "high",
    });
  });

  it("keeps # inside quoted strings (quote-aware comment strip)", () => {
    const root = parseToml(`url = "https://example.com/path#frag"\n`);
    expect(root.url).toBe("https://example.com/path#frag");
  });

  it("does not attach keys after a rejected [__proto__] header to the previous table", () => {
    // Fix round 2: splitTableHeader returns null for __proto__, so the old
    // `if (segments === null) continue` left `current` on the prior model and
    // fabricated default_effort / notes onto a real entry.
    const root = parseToml(
      `[models."kimi-code/k3"]\nsupport_efforts = [ "low" ]\n[__proto__]\ndefault_effort = "PWNED"\nmax_context_size = 999\n`,
    );
    const models = root.models as Record<string, Record<string, unknown>>;
    expect(models["kimi-code/k3"]).toEqual({ support_efforts: ["low"] });
    expect(models["kimi-code/k3"]).not.toHaveProperty("default_effort");
    expect(models["kimi-code/k3"]).not.toHaveProperty("max_context_size");
    const { models: projected } = parseKimiModelsConfig(
      `[models."kimi-code/k3"]\nsupport_efforts = [ "low" ]\n[__proto__]\ndefault_effort = "PWNED"\nmax_context_size = 999\n`,
    );
    expect(projected).toEqual([
      { id: "kimi-code/k3", efforts: ["low"], default_effort: null },
    ]);
  });

  it("does not attach keys after an empty [] header to the previous table", () => {
    const root = parseToml(
      `[models."real"]\nsupport_efforts = [ "low" ]\n[]\ndefault_effort = "PWNED"\n`,
    );
    const models = root.models as Record<string, Record<string, unknown>>;
    expect(models.real).toEqual({ support_efforts: ["low"] });
    expect(models.real).not.toHaveProperty("default_effort");
  });

  it("does not attach keys after an unterminated-quote header to the previous table", () => {
    // Header line must still end with `]` to enter the table-header branch;
    // unterminated *inner* quote makes splitTableHeader return null.
    const root = parseToml(
      `[models."real"]\nsupport_efforts = [ "low" ]\n[models."broken]\ndefault_effort = "PWNED"\n`,
    );
    const models = root.models as Record<string, Record<string, unknown>>;
    expect(models.real).toEqual({ support_efforts: ["low"] });
    expect(models.real).not.toHaveProperty("default_effort");
    // Hostile keys must not land on root either.
    expect(root).not.toHaveProperty("default_effort");
  });

  it("does not absorb keys after [[array of tables]] into the previous model table (#289)", () => {
    // Array-of-tables headers were previously skipped without resetting
    // `current`, so keys under [[mcp_servers]] leaked into the model entry.
    const text = `[models."kimi-code/kimi-for-coding"]
support_efforts = ["low","medium","high"]
default_effort = "medium"
max_context_size = 262144

[[mcp_servers]]
default_effort = "HIJACKED"
max_context_size = 1
`;
    const root = parseToml(text);
    const models = root.models as Record<string, Record<string, unknown>>;
    expect(models["kimi-code/kimi-for-coding"]).toEqual({
      support_efforts: ["low", "medium", "high"],
      default_effort: "medium",
      max_context_size: 262144,
    });
    // Array-of-tables content is intentionally not materialised.
    expect(root).not.toHaveProperty("mcp_servers");
    expect(root).not.toHaveProperty("default_effort");
    expect(root).not.toHaveProperty("max_context_size");

    const { models: projected } = parseKimiModelsConfig(text);
    expect(projected).toEqual([
      {
        id: "kimi-code/kimi-for-coding",
        efforts: ["low", "medium", "high"],
        default_effort: "medium",
        notes: "max_context_size=262144",
      },
    ]);
    expect(projected[0]!.default_effort).not.toBe("HIJACKED");
    expect(projected[0]!.notes).not.toBe("max_context_size=1");
  });
});
