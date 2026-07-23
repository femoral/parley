import { describe, expect, it } from "vitest";
import { formatTaskMeta, toDisplayTask } from "../src/app/hooks/displayTask.js";

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

  it("drops the redundant short id when the branch already embeds it", () => {
    // Worktree branches look like parley/<short-id> — repeating the id is noise.
    // shortId truncates to 8 chars; a ≤8-char task id is shown in full.
    expect(
      toDisplayTask({
        id: "t-aw1",
        model: "gpt-5.6-sol",
        vendor: "codex",
        branch: "parley/t-aw1",
      }).meta,
    ).toBe("parley/t-aw1");
  });
});

describe("formatTaskMeta", () => {
  it("keeps branch · shortId when the branch does not contain the short id", () => {
    expect(formatTaskMeta("feat/cove", "1234567890")).toBe("feat/cove · 12345678");
  });

  it("omits the short id when a path segment equals the short id", () => {
    // Task id ≤8 chars is not truncated; branch names embed that form.
    expect(formatTaskMeta("parley/t-aw1", "t-aw1")).toBe("parley/t-aw1");
    // Truncated short id matches a whole segment (not a bare substring).
    expect(formatTaskMeta("parley/t51-abcd", "t51-abcdefghij")).toBe("parley/t51-abcd");
  });

  it("does not treat a short id as embedded when it is only a substring of a segment", () => {
    // id "a" must not collapse "feat/x" (substring of neither segment).
    expect(formatTaskMeta("feat/x", "a")).toBe("feat/x · a");
    // id "x" equals the last segment — still a whole-segment match, so omit.
    expect(formatTaskMeta("feat/x", "x")).toBe("feat/x");
  });

  it("uses the no-branch label with a short id", () => {
    expect(formatTaskMeta(null, "short-id")).toBe("no branch · short-id");
    expect(formatTaskMeta(undefined, "abcdefghij")).toBe("no branch · abcdefgh");
  });
});
