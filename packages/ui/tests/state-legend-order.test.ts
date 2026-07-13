import { describe, expect, it } from "vitest";
import { ATTENTION_ORDER } from "@useparley/core";
import { ATTENTION_DISPLAY_ORDER } from "../src/tokens/state-meta.js";

/**
 * Drift guard for the kit band's state legend (#70).
 *
 * `tokens/state-meta.ts`'s `ATTENTION_DISPLAY_ORDER` is a hand-written
 * literal, not an import of `@useparley/core`'s `ATTENTION_ORDER` — the
 * tokens layer must stay free of the core dependency (component-system spec
 * contract 4: only the hooks layer imports `@useparley/core`), so this test
 * (not bound by that layering contract) is what keeps the two in lockstep:
 * if core ever reorders, renames, or adds an attention state without this
 * literal being updated to match, this fails loudly instead of the kit
 * band's legend silently going stale or omitting the new state.
 */
describe("the kit band's state legend order tracks @useparley/core's ATTENTION_ORDER", () => {
  it("is exactly equal to core's real attention hierarchy", () => {
    expect(ATTENTION_DISPLAY_ORDER).toEqual(ATTENTION_ORDER);
  });
});
