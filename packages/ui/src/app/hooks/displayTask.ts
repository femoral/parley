import type { DisplayIdentity } from "../../hud/types.js";
import { harnessColorFor, modelVendorFor } from "../../tokens/factions.js";
import { shortId, type RosterTaskInput } from "./roster.js";

/**
 * Branch · short-id meta for roster/inbox rows. When a path segment of the
 * branch is exactly the short task id (e.g. `parley/t-aw1`), omit the
 * redundant second segment — the full id stays available to AT via the row's
 * visually-hidden span. Whole-segment match only so short ids like `a` do not
 * false-positive inside unrelated branches (`feat/x`).
 */
export function formatTaskMeta(branch: string | null | undefined, id: string): string {
  const sid = shortId(id);
  if (!branch) return `no branch · ${sid}`;
  if (branch.split("/").some((seg) => seg === sid)) return branch;
  return `${branch} · ${sid}`;
}

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
    meta: formatTaskMeta(task.branch, task.id),
  };
}
