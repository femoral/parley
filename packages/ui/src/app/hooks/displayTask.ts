import type { DisplayIdentity } from "../../hud/types.js";
import { harnessColorFor, modelVendorFor } from "../../tokens/factions.js";
import { shortId, type RosterTaskInput } from "./roster.js";

/** Project the shared task fields into the visual identity every Cove surface uses. */
export function toDisplayTask(
  task: Pick<RosterTaskInput, "model" | "vendor" | "branch" | "id">,
): DisplayIdentity {
  const vendor = modelVendorFor(task.model, task.vendor);
  const harness = harnessColorFor(task.vendor);
  return {
    coat: harness.coat,
    coatDark: harness.coatDark,
    emblem: vendor.emblem,
    faction: `${vendor.label} via ${harness.label}`,
    meta: `${task.branch ?? "no branch"} · ${shortId(task.id)}`,
  };
}
