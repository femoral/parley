/**
 * Vendor model+effort allowlist (#185 / ADR-0014).
 *
 * Pure helpers: config shape lives on `VendorConfig.models`; every spawn path
 * (delegate, fix, profiles) validates through {@link resolveAllowedCombo}.
 * The model catalog remains advisory — used only for nearest-combo ranking
 * when the caller supplies one. CLI selected-model data (#284) is advisory
 * for rejection messages only — it never gates or widens a spawn.
 */
import type { SelectedModel } from "./adapter.js";
import type { VendorConfig, VendorModelAllowlistEntry } from "./config.js";
import type { ModelCatalog } from "./models.js";

/** One allowed model+effort pair (effort null = effort-less model). */
export interface AllowedCombo {
  model: string;
  effort: string | null;
  hint?: string;
  /** True when this combo is the vendor's default (omitted -m/-e). */
  isDefault: boolean;
}

/** Successful resolution of model+effort against an allowlist. */
export interface ResolvedAllowedCombo {
  model: string;
  effort: string | null;
  /** True when the allowlist default filled a fully omitted model+effort. */
  usedDefault: boolean;
}

/** Failure to resolve/validate a combo (maps to DelegateError message). */
export class ModelAllowlistError extends Error {
  readonly code: "no_allowlist" | "no_default" | "not_allowed";

  constructor(code: ModelAllowlistError["code"], message: string) {
    super(message);
    this.name = "ModelAllowlistError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a vendor config has a non-empty models allowlist. */
export function hasModelAllowlist(
  vendorCfg: VendorConfig | undefined | null,
): boolean {
  const models = vendorCfg?.models;
  return isRecord(models) && Object.keys(models).length > 0;
}

/**
 * Expand a vendor allowlist into concrete combos (one per model×effort, plus
 * model×null when efforts is empty).
 */
export function listAllowedCombos(
  vendorCfg: VendorConfig | undefined | null,
): AllowedCombo[] {
  const models = vendorCfg?.models;
  if (!isRecord(models)) return [];
  const out: AllowedCombo[] = [];
  for (const [modelId, entry] of Object.entries(models)) {
    if (!isRecord(entry)) continue;
    const efforts = Array.isArray(entry.efforts)
      ? entry.efforts.filter((e): e is string => typeof e === "string")
      : [];
    const hint = typeof entry.hint === "string" ? entry.hint : undefined;
    const defaultEffort = defaultEffortOf(entry as VendorModelAllowlistEntry);
    if (efforts.length === 0) {
      out.push({
        model: modelId,
        effort: null,
        ...(hint === undefined ? {} : { hint }),
        isDefault: defaultEffort !== undefined && defaultEffort === null,
      });
      continue;
    }
    for (const effort of efforts) {
      out.push({
        model: modelId,
        effort,
        ...(hint === undefined ? {} : { hint }),
        isDefault: defaultEffort === effort,
      });
    }
  }
  return out;
}

/**
 * Default effort for an entry, or `undefined` when the entry is not the
 * default. `null` means default combo is model with no effort.
 */
function defaultEffortOf(
  entry: VendorModelAllowlistEntry,
): string | null | undefined {
  const d = entry.default;
  if (d === undefined || d === false) return undefined;
  if (d === true) {
    if (entry.efforts.length === 0) return null;
    if (entry.efforts.length === 1) return entry.efforts[0]!;
    return undefined; // invalid config should have been rejected at load
  }
  if (typeof d === "string") return d;
  return undefined;
}

/** Human list of allowed combos, e.g. `model@effort`, `model` (no effort). */
export function formatAllowedCombos(combos: readonly AllowedCombo[]): string {
  if (combos.length === 0) return "(none)";
  return combos
    .map((c) => (c.effort === null ? c.model : `${c.model}@${c.effort}`))
    .join(", ");
}

/**
 * Format an error when the vendor has no allowlist. Names wizard + config path.
 */
export function noAllowlistMessage(vendor: string, configPath: string): string {
  return (
    `vendor ${vendor} has no models configured (deny-by-default). ` +
    `Run /parley-wizard to pick model+effort combos, or set vendors.${vendor}.models ` +
    `in ${configPath}`
  );
}

/** Format an error when no default combo is flagged and -m/-e were omitted. */
export function noDefaultMessage(vendor: string, combos: readonly AllowedCombo[]): string {
  return (
    `vendor ${vendor} has no default model+effort (pass -m/-e, or mark one combo ` +
    `with default in vendors.${vendor}.models). Allowed: ${formatAllowedCombos(combos)}`
  );
}

/**
 * Simple edit-distance (Levenshtein) for nearest-combo ranking. Small strings
 * only (model/effort ids).
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const prev = new Array<number>(cols);
  const cur = new Array<number>(cols);
  for (let j = 0; j < cols; j++) prev[j] = j;
  for (let i = 1; i < rows; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j < cols; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    for (let j = 0; j < cols; j++) prev[j] = cur[j] ?? 0;
  }
  return prev[b.length] ?? 0;
}

/**
 * Pick the closest allowed combo to a requested model/effort.
 * Preference: same model (different effort) first, then nearest model id
 * (catalog order is a weak tie-break when provided).
 */
export function suggestNearestCombo(
  combos: readonly AllowedCombo[],
  model: string | null,
  effort: string | null,
  catalog?: ModelCatalog | null,
): AllowedCombo | null {
  if (combos.length === 0) return null;
  if (model !== null && model !== "") {
    const sameModel = combos.filter((c) => c.model === model);
    if (sameModel.length > 0) {
      if (effort === null || effort === "") {
        return sameModel.find((c) => c.isDefault) ?? sameModel[0]!;
      }
      // Prefer closest effort string on the same model.
      let best = sameModel[0]!;
      let bestDist = editDistance(effort, best.effort ?? "");
      for (let i = 1; i < sameModel.length; i++) {
        const c = sameModel[i]!;
        const d = editDistance(effort, c.effort ?? "");
        if (d < bestDist) {
          best = c;
          bestDist = d;
        }
      }
      return best;
    }
  }
  // Nearest model id among allowed combos.
  const targetModel = model ?? "";
  let best = combos[0]!;
  let bestDist = editDistance(targetModel, best.model);
  for (let i = 1; i < combos.length; i++) {
    const c = combos[i]!;
    const d = editDistance(targetModel, c.model);
    // Catalog adjacency: if both models appear in the same vendor catalog
    // slice, slightly prefer earlier/closer index (weak tie-break).
    if (catalog && model) {
      // no-op structural use keeps catalog "advisory for suggestions"
      void catalog;
    }
    if (d < bestDist) {
      best = c;
      bestDist = d;
    } else if (d === bestDist && c.isDefault && !best.isDefault) {
      best = c;
    }
  }
  return best;
}

function formatCombo(model: string, effort: string | null): string {
  return effort === null || effort === "" ? model : `${model}@${effort}`;
}

/**
 * Whether a CLI selected model+effort is already covered by the allowlist.
 * Effort-less allowlist entries match any/null selected effort; when the
 * entry lists efforts, the selected effort must be among them (or null
 * only if the model is selected without a stored effort).
 */
function selectedIsAllowlisted(
  selected: SelectedModel,
  combos: readonly AllowedCombo[],
): boolean {
  for (const c of combos) {
    if (c.model !== selected.model) continue;
    if (selected.effort === null || selected.effort === "") {
      // CLI has no effort on the selection — any allowlisted row for the model counts.
      return true;
    }
    if (c.effort === null || c.effort === selected.effort) return true;
  }
  return false;
}

/**
 * Advisory line naming the CLI's current selection when it is readable and
 * not on the allowlist (#284). Empty string when there is nothing to add.
 * Never includes credential material — only model id and optional effort.
 */
export function formatCliSelectedHint(
  selected: SelectedModel | null | undefined,
  combos: readonly AllowedCombo[],
): string {
  if (selected === null || selected === undefined) return "";
  if (selected.model === "") return "";
  if (selectedIsAllowlisted(selected, combos)) return "";
  const combo = formatCombo(selected.model, selected.effort);
  return ` CLI currently has ${combo} selected (not on the allowlist).`;
}

function notAllowedMessage(
  body: string,
  combos: readonly AllowedCombo[],
  selected: SelectedModel | null | undefined,
): string {
  return body + formatCliSelectedHint(selected, combos);
}

/**
 * Resolve model+effort against a vendor allowlist.
 *
 * @param vendor - vendor id (for error text)
 * @param vendorCfg - vendors.<id> entry (may be undefined)
 * @param model - resolved request/profile model, or null if omitted
 * @param effort - resolved request/profile effort, or null if omitted
 * @param configPath - path shown in no-allowlist remedy
 * @param catalog - optional advisory catalog for nearest suggestions
 * @param cliSelected - optional CLI-selected model (#284); enriches
 *   `not_allowed` messages only — never gates or widens a spawn
 */
export function resolveAllowedCombo(options: {
  vendor: string;
  vendorCfg: VendorConfig | undefined | null;
  model: string | null;
  effort: string | null;
  configPath: string;
  catalog?: ModelCatalog | null;
  /** Operator CLI selection for advisory rejection text (#284). */
  cliSelected?: SelectedModel | null;
}): ResolvedAllowedCombo {
  const { vendor, vendorCfg, configPath, catalog } = options;
  const model = options.model === "" ? null : options.model;
  const effort = options.effort === "" ? null : options.effort;
  const cliSelected = options.cliSelected;

  if (!hasModelAllowlist(vendorCfg)) {
    throw new ModelAllowlistError("no_allowlist", noAllowlistMessage(vendor, configPath));
  }

  const combos = listAllowedCombos(vendorCfg);
  const fullyOmitted = model === null && effort === null;

  if (fullyOmitted) {
    const def = combos.find((c) => c.isDefault);
    if (def === undefined) {
      throw new ModelAllowlistError("no_default", noDefaultMessage(vendor, combos));
    }
    return { model: def.model, effort: def.effort, usedDefault: true };
  }

  // Model required when effort alone is supplied.
  if (model === null) {
    const nearest = suggestNearestCombo(combos, null, effort, catalog);
    const suggest =
      nearest === null
        ? ""
        : `; did you mean ${formatCombo(nearest.model, nearest.effort)}?`;
    throw new ModelAllowlistError(
      "not_allowed",
      notAllowedMessage(
        `vendor ${vendor}: model is required when effort is set (got effort=${JSON.stringify(effort)}). ` +
          `Allowed: ${formatAllowedCombos(combos)}${suggest}`,
        combos,
        cliSelected,
      ),
    );
  }

  const entry = vendorCfg?.models?.[model];
  if (entry === undefined) {
    const nearest = suggestNearestCombo(combos, model, effort, catalog);
    const suggest =
      nearest === null
        ? ""
        : `; did you mean ${formatCombo(nearest.model, nearest.effort)}?`;
    throw new ModelAllowlistError(
      "not_allowed",
      notAllowedMessage(
        `vendor ${vendor}: model ${JSON.stringify(model)} is not allowed. ` +
          `Allowed: ${formatAllowedCombos(combos)}${suggest}`,
        combos,
        cliSelected,
      ),
    );
  }

  const efforts = entry.efforts ?? [];
  if (efforts.length === 0) {
    // Effort-less model: only null effort allowed.
    if (effort !== null) {
      const nearest = suggestNearestCombo(combos, model, effort, catalog);
      const suggest =
        nearest === null
          ? ""
          : `; did you mean ${formatCombo(nearest.model, nearest.effort)}?`;
      throw new ModelAllowlistError(
        "not_allowed",
        notAllowedMessage(
          `vendor ${vendor}: model ${JSON.stringify(model)} allows no effort (got ${JSON.stringify(effort)}). ` +
            `Allowed: ${formatAllowedCombos(combos)}${suggest}`,
          combos,
          cliSelected,
        ),
      );
    }
    return { model, effort: null, usedDefault: false };
  }

  if (effort === null) {
    // Model set, effort omitted — do not imply an effort; require explicit.
    const nearest = suggestNearestCombo(combos, model, null, catalog);
    const suggest =
      nearest === null
        ? ""
        : `; did you mean ${formatCombo(nearest.model, nearest.effort)}?`;
    throw new ModelAllowlistError(
      "not_allowed",
      notAllowedMessage(
        `vendor ${vendor}: effort is required for model ${JSON.stringify(model)} ` +
          `(allowed efforts: ${efforts.join(", ")}). Allowed combos: ${formatAllowedCombos(combos)}${suggest}`,
        combos,
        cliSelected,
      ),
    );
  }

  if (!efforts.includes(effort)) {
    const nearest = suggestNearestCombo(combos, model, effort, catalog);
    const suggest =
      nearest === null
        ? ""
        : `; did you mean ${formatCombo(nearest.model, nearest.effort)}?`;
    throw new ModelAllowlistError(
      "not_allowed",
      notAllowedMessage(
        `vendor ${vendor}: effort ${JSON.stringify(effort)} is not allowed for model ${JSON.stringify(model)} ` +
          `(allowed efforts: ${efforts.join(", ")}). Allowed combos: ${formatAllowedCombos(combos)}${suggest}`,
        combos,
        cliSelected,
      ),
    );
  }

  return { model, effort, usedDefault: false };
}
