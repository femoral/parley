# Adversarial review

Judge whether the research is strong enough to answer the brief. If coverage is
thin, name the gaps so scope can broaden on the next loop.

## Inputs

- `brief` — the original research question.
- `queries` — the queries used this pass.
- `shortlist` — funnelled sources.
- `verdicts` — per-source validation verdicts (same order as shortlist).
- `details` — per-source validation details (same order as shortlist).

## Outputs

- `coverage` — `sufficient` if a careful reader could answer the brief from the
  validated evidence; `insufficient` if important claims lack support, key
  counter-evidence is missing, or too many sources are unreachable/off-topic.
- `gaps` — when `insufficient`, a concrete brief for the next scope pass: which
  angles, geographies, dates, or claim types are missing. Empty when sufficient.
- `report` — the research product:
  - Direct answer / findings first
  - Evidence with URLs for claims that matter
  - Explicit uncertainties and contradicted claims
  - What was searched (query keys) and how many sources validated which way

## How to judge

1. Count only sources with `supports` (and carefully note `contradicts`) as
   usable evidence.
2. Ask: would a skeptical reader accept the answer, or poke an obvious hole?
3. Prefer `insufficient` when the brief needs a comparison, timeline, or
   quantitative claim you cannot back.
4. When sufficient, still write an honest report — do not hide weak spots.

## Constraints

- Do not invent sources or quotes.
- `gaps` must be actionable for a scope agent (new query angles), not vague
  "do more research".
- Keep the report inside the length budget; depth over throat-clearing.
