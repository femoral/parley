# Scope

Turn the research brief into a small set of named search queries. You do not
search yet — later steps fan out over your queries.

## Inputs

- `brief` — the question or investigation request.
- `gaps` — when present, coverage holes from a previous adversarial pass. Prefer
  new or refined queries that close those gaps over repeating the first pass.

## Outputs

- `queries` — a dict of short stable keys → query strings (max 8 entries, each
  query ≤ 300 chars). Keys are identifiers for later fan-out (e.g. `primary`,
  `counter`, `timeline`); they must be unique and filesystem-safe
  (`[a-z0-9_-]+`).

## How to scope

1. Restate the decision the research must support (one or two sentences
   mentally — not as an output).
2. Split into distinct angles: core claim, counter-evidence, definitions,
   recency, authority, etc. Only as many as needed — fewer sharp queries beat
   many vague ones.
3. If `gaps` is present, map each gap to at least one query; drop queries that
   only re-harvest already-sufficient areas.

## Constraints

- Do not fetch URLs or write the final report here.
- Each query should be usable as a web/search prompt on its own.
- Prefer diversity of angles over near-duplicate phrasings.
