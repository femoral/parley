/**
 * Vendor model+effort allowlist (#185 / ADR-0014).
 *
 * Pure helpers: config shape lives on `VendorConfig.models`; every spawn path
 * (delegate, fix, profiles) validates through {@link resolveAllowedCombo}.
 * The model catalog remains advisory — used only for nearest-combo ranking
 * when the caller supplies one. CLI selected-model data (#284) is advisory
 * for rejection messages only — it never gates or widens a spawn. The
 * advisory line is appended by engine / run-preflight via
 * {@link formatCliSelectedHint}; this module never reads a vendor home.
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

/**
 * Safe token shape for model/effort ids that may later land in config or
 * rejection text. Real vendor ids use alphanumerics plus `/ . _ - @ ~ : +`
 * (e.g. `kwaipilot/kat-coder`, `kilo/~anthropic/…`, `gpt-5.6-sol`).
 * Rejects whitespace, control chars, and ANSI so a poisoned vendor file
 * cannot inject multi-line rejection text or unreadable allowlist keys.
 */
const SAFE_ALLOWLIST_TOKEN = /^[\w./@~:+-]+$/;
const SAFE_ALLOWLIST_TOKEN_MAX = 200;

/** Whether a disk- or operator-supplied model/effort id is safe to seed. */
export function isSafeAllowlistToken(id: string): boolean {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= SAFE_ALLOWLIST_TOKEN_MAX &&
    SAFE_ALLOWLIST_TOKEN.test(id)
  );
}

/**
 * Format one combo for rejection text. Bare `model@effort` when the ids are
 * safe tokens (the historical shape); JSON-escaped + length-capped otherwise
 * so a hand-edited or poisoned allowlist key cannot open extra terminal lines.
 */
function formatComboForDisplay(model: string, effort: string | null): string {
  const combo = effort === null || effort === "" ? model : `${model}@${effort}`;
  if (isSafeAllowlistToken(model) && (effort === null || effort === "" || isSafeAllowlistToken(effort))) {
    return combo;
  }
  let capped = combo;
  if (capped.length > SAFE_ALLOWLIST_TOKEN_MAX) {
    capped = `${capped.slice(0, SAFE_ALLOWLIST_TOKEN_MAX)}…`;
  }
  return JSON.stringify(capped);
}

/** Human list of allowed combos, e.g. `model@effort`, `model` (no effort). */
export function formatAllowedCombos(combos: readonly AllowedCombo[]): string {
  if (combos.length === 0) return "(none)";
  return combos
    .map((c) => formatComboForDisplay(c.model, c.effort))
    .join(", ");
}

/** Human list of effort tokens for rejection text (same escaping as combos). */
function formatEffortsForDisplay(efforts: readonly string[]): string {
  return efforts.map((e) => formatComboForDisplay(e, null)).join(", ");
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
 * Max length of the displayed model@effort combo in the advisory line.
 * Disk-derived text is untrusted (undocumented vendor files); without a cap a
 * multi-MiB model id becomes a multi-MiB DelegateError / HTTP body / task error.
 */
const CLI_SELECTED_HINT_COMBO_MAX = 200;

/**
 * Advisory line naming the CLI's current selection when it is readable and
 * not on the allowlist (#284). Empty string when there is nothing to add.
 * Never includes credential material — only model id and optional effort.
 *
 * Disk-derived model/effort are JSON.stringified and length-capped so a
 * newline/ANSI-laden or multi-MiB id cannot inject terminal lines or bloat
 * rejection messages. Runtime shape defence: non-string / whitespace-only
 * model → empty hint (callers may pass untyped adapter output).
 */
export function formatCliSelectedHint(
  selected: SelectedModel | null | undefined,
  combos: readonly AllowedCombo[],
): string {
  if (selected === null || selected === undefined) return "";
  // Shape defence — untyped input must not yield "42@7" / "undefined@…".
  if (typeof selected.model !== "string") return "";
  const model = selected.model.trim();
  if (model === "") return "";
  const effort =
    typeof selected.effort === "string" && selected.effort.trim() !== ""
      ? selected.effort.trim()
      : null;
  const normalized: SelectedModel = { model, effort };
  if (selectedIsAllowlisted(normalized, combos)) return "";
  let combo = formatCombo(model, effort);
  if (combo.length > CLI_SELECTED_HINT_COMBO_MAX) {
    combo = `${combo.slice(0, CLI_SELECTED_HINT_COMBO_MAX)}…`;
  }
  // JSON.stringify escapes newlines/ANSI/quotes — sibling fields do the same.
  return ` CLI currently has ${JSON.stringify(combo)} selected (not on the allowlist).`;
}

/**
 * Resolve model+effort against a vendor allowlist.
 *
 * Pure gate: success/failure and message body do not depend on CLI selection.
 * Callers that want the #284 advisory line append {@link formatCliSelectedHint}
 * themselves after a `not_allowed` / `no_allowlist` failure (engine +
 * run-preflight are the single choke points — do not reintroduce a
 * `cliSelected` parameter here, or a future double-append will reappear).
 *
 * @param vendor - vendor id (for error text)
 * @param vendorCfg - vendors.<id> entry (may be undefined)
 * @param model - resolved request/profile model, or null if omitted
 * @param effort - resolved request/profile effort, or null if omitted
 * @param configPath - path shown in no-allowlist remedy
 * @param catalog - optional advisory catalog for nearest suggestions
 */
export function resolveAllowedCombo(options: {
  vendor: string;
  vendorCfg: VendorConfig | undefined | null;
  model: string | null;
  effort: string | null;
  configPath: string;
  catalog?: ModelCatalog | null;
}): ResolvedAllowedCombo {
  const { vendor, vendorCfg, configPath, catalog } = options;
  const model = options.model === "" ? null : options.model;
  const effort = options.effort === "" ? null : options.effort;

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
        : `; did you mean ${formatComboForDisplay(nearest.model, nearest.effort)}?`;
    throw new ModelAllowlistError(
      "not_allowed",
      `vendor ${vendor}: model is required when effort is set (got effort=${JSON.stringify(effort)}). ` +
        `Allowed: ${formatAllowedCombos(combos)}${suggest}`,
    );
  }

  const entry = vendorCfg?.models?.[model];
  if (entry === undefined) {
    const nearest = suggestNearestCombo(combos, model, effort, catalog);
    const suggest =
      nearest === null
        ? ""
        : `; did you mean ${formatComboForDisplay(nearest.model, nearest.effort)}?`;
    throw new ModelAllowlistError(
      "not_allowed",
      `vendor ${vendor}: model ${JSON.stringify(model)} is not allowed. ` +
        `Allowed: ${formatAllowedCombos(combos)}${suggest}`,
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
          : `; did you mean ${formatComboForDisplay(nearest.model, nearest.effort)}?`;
      throw new ModelAllowlistError(
        "not_allowed",
        `vendor ${vendor}: model ${JSON.stringify(model)} allows no effort (got ${JSON.stringify(effort)}). ` +
          `Allowed: ${formatAllowedCombos(combos)}${suggest}`,
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
        : `; did you mean ${formatComboForDisplay(nearest.model, nearest.effort)}?`;
    throw new ModelAllowlistError(
      "not_allowed",
      `vendor ${vendor}: effort is required for model ${JSON.stringify(model)} ` +
        `(allowed efforts: ${formatEffortsForDisplay(efforts)}). Allowed combos: ${formatAllowedCombos(combos)}${suggest}`,
    );
  }

  if (!efforts.includes(effort)) {
    const nearest = suggestNearestCombo(combos, model, effort, catalog);
    const suggest =
      nearest === null
        ? ""
        : `; did you mean ${formatComboForDisplay(nearest.model, nearest.effort)}?`;
    throw new ModelAllowlistError(
      "not_allowed",
      `vendor ${vendor}: effort ${JSON.stringify(effort)} is not allowed for model ${JSON.stringify(model)} ` +
        `(allowed efforts: ${formatEffortsForDisplay(efforts)}). Allowed combos: ${formatAllowedCombos(combos)}${suggest}`,
    );
  }

  return { model, effort, usedDefault: false };
}
