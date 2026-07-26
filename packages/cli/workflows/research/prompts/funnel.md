# Funnel

Collapse the parallel search harvest into a shortlist worth validating.

## Inputs

- `harvest` — dict of query key → source arrays from all search tasks (and,
  across loop iterations, accumulated prior harvests).
- `brief` — the research question.

## Outputs

- `shortlist` — up to 12 sources, globally de-duplicated by URL (or by
  equivalent canonical URL when obvious).

## How to select

1. Pool all sources across query keys.
2. Drop duplicates and near-duplicates; keep the better title/claim pair.
3. Rank by: direct relevance to the brief, source quality, and coverage of
   distinct claims (diversity beats ten links that say the same thing).
4. Prefer a balanced set: supporting *and* challenging evidence when both exist.
5. Keep the claim text accurate; you may lightly edit claims for clarity but
   must not invent facts.

## Constraints

- Do not validate URLs in depth here — that is the next step.
- Do not write the final report yet.
- If the harvest is empty or unusable, return the best you can (possibly empty)
  rather than inventing sources.
