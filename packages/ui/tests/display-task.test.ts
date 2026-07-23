import { describe, expect, it } from "vitest";
import { toDisplayTask } from "../src/app/hooks/displayTask.js";

describe("toDisplayTask", () => {
  it.each([
    {
      model: "gpt-5.6-sol",
      vendor: "codex",
      faction: "GPT via Codex",
      coat: "#18A886",
      coatDark: "#08634F",
    },
    {
      model: "qwen-3-max",
      vendor: "opencode",
      faction: "Qwen via OpenCode",
      coat: "#80A83D",
      coatDark: "#465F1D",
    },
  ])("projects the $faction identity", ({ model, vendor, faction, coat, coatDark }) => {
    const identity = toDisplayTask({
      id: "1234567890",
      model,
      vendor,
      branch: "feat/cove",
    });
    expect(identity).toMatchObject({
      coat,
      coatDark,
      faction,
      meta: "feat/cove · 12345678",
    });
    expect(identity.emblem.kind).toBe("svg");
  });

  it("uses unknown fallbacks and the no-branch label", () => {
    expect(
      toDisplayTask({
        id: "short-id",
        model: "custom-model",
        vendor: "home-grown",
        branch: null,
      }),
    ).toEqual({
      coat: "#FFFFFF",
      coatDark: "#5B3A24",
      emblem: { kind: "glyph", char: "?" },
      faction: "Unknown vendor via Unknown harness",
      meta: "no branch · short-id",
    });
  });
});
