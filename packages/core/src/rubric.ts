/**
 * Rubric schema, scoring formula, and the nine shipped rubrics (#157 / #133 /
 * #134). Daemon computes score + baseline from boolean answers; orchestrators
 * never assert a free score.
 */

/** Criterion polarity: positive earns points; negative deducts when triggered. */
export type CriterionKind = "positive" | "negative";

/** One binary weighted criterion in a rubric. */
export interface Criterion {
  id: string;
  kind: CriterionKind;
  /** Positive integer weight. */
  weight: number;
  text: string;
}

/** Versioned rubric document (one per task type / custom rubric id). */
export interface Rubric {
  id: string;
  /** Bump-on-edit integer version. */
  version: number;
  criteria: Criterion[];
}

/** Boolean answers keyed by criterion id. */
export type RubricAnswers = Record<string, boolean>;

/** Daemon-computed score result for one evaluation. */
export interface ScoreResult {
  /** 0–10 inclusive; floor exactly 0. */
  score: number;
  /** Persisted baseline = round(10 · baseline_raw / max). */
  baseline: number;
  /** Raw weighted points before 0–10 scaling. */
  raw: number;
  /** Maximum raw points (all positives passed, no negatives). */
  max: number;
  /** Sum of all negative weights (pre-scale baseline numerator). */
  baseline_raw: number;
  /** True when score < baseline (deductions outweighed earned points). */
  below_baseline: boolean;
}

/** Universal negative trio shared by every built-in rubric (#134). */
export const UNIVERSAL_NEGATIVES: readonly Criterion[] = [
  {
    id: "broke-existing",
    kind: "negative",
    weight: 5,
    text: "The work broke or regressed something that worked before.",
  },
  {
    id: "fabricated-claim",
    kind: "negative",
    weight: 5,
    text: "The report asserts something the work doesn't actually do.",
  },
  {
    id: "scope-creep",
    kind: "negative",
    weight: 3,
    text: "Substantial work outside the brief was done unrequested.",
  },
] as const;

/** Fallback rubric id for `other` and custom types without their own rubric. */
export const GENERIC_RUBRIC_ID = "generic";

function criterion(
  id: string,
  kind: CriterionKind,
  weight: number,
  text: string,
): Criterion {
  return { id, kind, weight, text };
}

function builtIn(id: string, positives: Criterion[]): Rubric {
  return {
    id,
    version: 1,
    criteria: [...positives, ...UNIVERSAL_NEGATIVES],
  };
}

/**
 * Nine shipped rubrics at version 1 (#134). Domain positives (~5, core outcome
 * weighted 5) plus the universal negative trio. `generic` is the custom-type /
 * `other` fallback.
 */
export const SHIPPED_RUBRICS: Readonly<Record<string, Rubric>> = {
  coding: builtIn("coding", [
    criterion("brief-implemented", "positive", 5, "The requested behavior works as described."),
    criterion(
      "change-verified",
      "positive",
      3,
      "New behavior is covered by tests or a demonstrated run.",
    ),
    criterion("suite-green", "positive", 3, "Existing test suite passes after the change."),
    criterion("minimal-diff", "positive", 2, "Diff contains no unrelated changes."),
    criterion(
      "report-complete",
      "positive",
      1,
      "Report names what changed, how verified, and caveats.",
    ),
  ]),
  design: builtIn("design", [
    criterion("matches-intent", "positive", 5, "The result matches the brief's described intent/spec."),
    criterion(
      "system-coherent",
      "positive",
      3,
      "Uses the project's existing tokens/components/conventions.",
    ),
    criterion(
      "states-covered",
      "positive",
      3,
      "All requested states, screens, or breakpoints are delivered.",
    ),
    criterion(
      "artifacts-usable",
      "positive",
      2,
      "Deliverables are in editable/integrable form, not screenshots only.",
    ),
    criterion("rationale-noted", "positive", 1, "Report explains the key design choices made."),
  ]),
  research: builtIn("research", [
    criterion(
      "question-answered",
      "positive",
      5,
      "The report states an explicit answer/conclusion to the brief's question.",
    ),
    criterion(
      "claims-sourced",
      "positive",
      3,
      "Every load-bearing claim cites a checkable source.",
    ),
    criterion("alternatives", "positive", 2, "Competing options or counter-evidence are addressed."),
    criterion("scope-covered", "positive", 2, "Every sub-question in the brief is addressed."),
    criterion(
      "method-stated",
      "positive",
      1,
      "Report states how the research was conducted (queries, docs read).",
    ),
  ]),
  infrastructure: builtIn("infrastructure", [
    criterion("system-works", "positive", 5, "The target system/pipeline works after the change."),
    criterion(
      "run-verified",
      "positive",
      3,
      "Verified by an actual run (CI green, deploy done, plan output shown).",
    ),
    criterion(
      "reproducible",
      "positive",
      3,
      "Change is captured as code/config, not manual steps.",
    ),
    criterion("rollback-stated", "positive", 2, "A rollback or recovery path is documented."),
    criterion("runbook-updated", "positive", 1, "Relevant docs/runbooks are updated."),
  ]),
  writing: builtIn("writing", [
    criterion(
      "covers-brief",
      "positive",
      5,
      "The text covers everything the brief asked for, at the audience's level.",
    ),
    criterion("accurate", "positive", 3, "Statements are factually/technically correct."),
    criterion(
      "fit-for-form",
      "positive",
      2,
      "Organization and tone fit the form the brief requested (doc, article, spec, ...).",
    ),
    criterion(
      "house-style",
      "positive",
      2,
      "Matches the project's existing conventions and terminology where they apply.",
    ),
    criterion(
      "no-placeholders",
      "positive",
      1,
      "No unfinished sections or TODOs remain, except ones the brief explicitly requested.",
    ),
  ]),
  data: builtIn("data", [
    criterion(
      "output-delivered",
      "positive",
      5,
      "The requested dataset/analysis/migration output exists and is usable.",
    ),
    criterion(
      "method-sound",
      "positive",
      3,
      "The method is stated and fits the question (joins, filters, assumptions explicit).",
    ),
    criterion(
      "reproducible",
      "positive",
      3,
      "A script/query is included and re-runs to the same result.",
    ),
    criterion(
      "sanity-checked",
      "positive",
      2,
      "Results are validated against known totals or plausibility checks, and checks are shown.",
    ),
    criterion("limitations", "positive", 1, "Known gaps, exclusions, or caveats are stated."),
  ]),
  review: builtIn("review", [
    criterion(
      "verdict-given",
      "positive",
      5,
      "A clear verdict/assessment is delivered with justification.",
    ),
    criterion(
      "findings-concrete",
      "positive",
      3,
      "Each finding points to a specific location with evidence.",
    ),
    criterion(
      "coverage-full",
      "positive",
      3,
      "The whole requested surface was examined, not a sample.",
    ),
    criterion("severity-ranked", "positive", 2, "Findings carry severity/priority."),
    criterion(
      "majors-verified",
      "positive",
      1,
      "Major findings include how to reproduce or verify them.",
    ),
  ]),
  planning: builtIn("planning", [
    criterion(
      "decisions-explicit",
      "positive",
      5,
      "The plan states unambiguously what will be built/done.",
    ),
    criterion(
      "actionable",
      "positive",
      3,
      "Steps are sized and ordered so an implementer can start without further design.",
    ),
    criterion(
      "risks-identified",
      "positive",
      2,
      "Constraints, risks, and dependencies are named.",
    ),
    criterion("alternatives", "positive", 2, "Rejected alternatives are noted with why."),
    criterion(
      "acceptance-defined",
      "positive",
      1,
      "Done-ness criteria are defined for the planned work.",
    ),
  ]),
  generic: builtIn("generic", [
    criterion(
      "brief-fulfilled",
      "positive",
      5,
      "The deliverable the brief asked for exists and is usable.",
    ),
    criterion("evidenced", "positive", 3, "The result is demonstrated or supported by evidence."),
    criterion("complete", "positive", 3, "Every part of the brief is addressed."),
    criterion(
      "report-complete",
      "positive",
      2,
      "Report states what was done, evidence, and caveats.",
    ),
  ]),
};

/** Ids of the nine shipped rubrics, stable order. */
export const SHIPPED_RUBRIC_IDS = [
  "coding",
  "design",
  "research",
  "infrastructure",
  "writing",
  "data",
  "review",
  "planning",
  "generic",
] as const;

export type ShippedRubricId = (typeof SHIPPED_RUBRIC_IDS)[number];

/** Return a deep-cloned shipped rubric, or null when the id is not built-in. */
export function getShippedRubric(id: string): Rubric | null {
  const r = SHIPPED_RUBRICS[id];
  if (r === undefined) return null;
  return {
    id: r.id,
    version: r.version,
    criteria: r.criteria.map((c) => ({ ...c })),
  };
}

/**
 * Parse and validate a raw rubric JSON document. Throws a descriptive Error on
 * any schema violation (never coerces).
 */
export function parseRubric(raw: unknown): Rubric {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("rubric must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id === "") {
    throw new Error("rubric.id must be a non-empty string");
  }
  if (typeof obj.version !== "number" || !Number.isInteger(obj.version) || obj.version < 1) {
    throw new Error("rubric.version must be a positive integer");
  }
  if (!Array.isArray(obj.criteria) || obj.criteria.length === 0) {
    throw new Error("rubric.criteria must be a non-empty array");
  }
  const seen = new Set<string>();
  const criteria: Criterion[] = [];
  for (let i = 0; i < obj.criteria.length; i++) {
    const c = obj.criteria[i];
    if (typeof c !== "object" || c === null || Array.isArray(c)) {
      throw new Error(`rubric.criteria[${i}] must be an object`);
    }
    const cr = c as Record<string, unknown>;
    if (typeof cr.id !== "string" || cr.id === "") {
      throw new Error(`rubric.criteria[${i}].id must be a non-empty string`);
    }
    if (seen.has(cr.id)) {
      throw new Error(`rubric.criteria: duplicate criterion id "${cr.id}"`);
    }
    seen.add(cr.id);
    if (cr.kind !== "positive" && cr.kind !== "negative") {
      throw new Error(
        `rubric.criteria[${i}].kind must be "positive" or "negative", got: ${String(cr.kind)}`,
      );
    }
    if (typeof cr.weight !== "number" || !Number.isInteger(cr.weight) || cr.weight < 1) {
      throw new Error(`rubric.criteria[${i}].weight must be a positive integer`);
    }
    if (typeof cr.text !== "string" || cr.text === "") {
      throw new Error(`rubric.criteria[${i}].text must be a non-empty string`);
    }
    criteria.push({
      id: cr.id,
      kind: cr.kind,
      weight: cr.weight,
      text: cr.text,
    });
  }
  return { id: obj.id, version: obj.version, criteria };
}

/**
 * Validate that `answers` covers the rubric's criterion ids exactly — every
 * criterion present once as a boolean, no extras. Throws a descriptive Error
 * (callers map to usage / 400).
 */
export function validateAnswers(rubric: Rubric, answers: unknown): asserts answers is RubricAnswers {
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
    throw new Error("answers must be a JSON object mapping criterion ids to booleans");
  }
  const map = answers as Record<string, unknown>;
  const expected = new Set(rubric.criteria.map((c) => c.id));
  const provided = new Set(Object.keys(map));

  const missing: string[] = [];
  for (const id of expected) {
    if (!provided.has(id)) missing.push(id);
  }
  const unknown: string[] = [];
  for (const id of provided) {
    if (!expected.has(id)) unknown.push(id);
  }
  if (missing.length > 0 || unknown.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing criterion ids: ${missing.join(", ")}`);
    if (unknown.length > 0) parts.push(`unknown criterion ids: ${unknown.join(", ")}`);
    throw new Error(`answers must cover rubric criteria exactly (${parts.join("; ")})`);
  }
  for (const [id, value] of Object.entries(map)) {
    if (typeof value !== "boolean") {
      throw new Error(`answers.${id} must be a boolean, got: ${typeof value}`);
    }
  }
}

/**
 * Compute score and baseline from a rubric and validated boolean answers.
 *
 * Spec formula (#150 / #133):
 * ```
 * baseline_raw = Σ negative weights
 * raw   = baseline_raw + Σ passed-positive weights − Σ triggered-negative weights
 * max   = baseline_raw + Σ all positive weights
 * score    = round(10 · raw / max)          # 0–10, floor exactly 0
 * baseline = round(10 · baseline_raw / max) # persisted per result
 * below-baseline: score < baseline
 * ```
 */
export function scoreRubric(rubric: Rubric, answers: RubricAnswers): ScoreResult {
  let baseline_raw = 0;
  let positives = 0;
  let passed_pos = 0;
  let triggered_neg = 0;

  for (const c of rubric.criteria) {
    if (c.kind === "negative") {
      baseline_raw += c.weight;
      if (answers[c.id] === true) triggered_neg += c.weight;
    } else {
      positives += c.weight;
      if (answers[c.id] === true) passed_pos += c.weight;
    }
  }

  const max = baseline_raw + positives;
  if (max <= 0) {
    // Degenerate empty-weight rubric — should be rejected by parse, but keep a
    // safe floor so callers never divide by zero.
    return {
      score: 0,
      baseline: 0,
      raw: 0,
      max: 0,
      baseline_raw,
      below_baseline: false,
    };
  }

  const raw = baseline_raw + passed_pos - triggered_neg;
  const score = Math.max(0, Math.round((10 * raw) / max));
  const baseline = Math.round((10 * baseline_raw) / max);
  return {
    score,
    baseline,
    raw,
    max,
    baseline_raw,
    below_baseline: score < baseline,
  };
}

/**
 * Resolve which rubric id a task type maps to given the project's taskTypes
 * map. Unmapped types (including automatic `other`) fall back to `generic`.
 */
export function resolveRubricIdForType(
  taskType: string,
  taskTypes: Record<string, { rubric: string }>,
): string {
  const entry = taskTypes[taskType];
  if (entry !== undefined && entry.rubric !== "") return entry.rubric;
  return GENERIC_RUBRIC_ID;
}
