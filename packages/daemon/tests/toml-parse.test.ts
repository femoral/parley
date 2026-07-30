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
});
