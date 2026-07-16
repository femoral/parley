# Vendor token-usage event coverage — Codex vs Grok

Research for [vendor token-usage event coverage](https://github.com/femoral/parley/issues/38), part of the
[Parley traceability v2](https://github.com/femoral/parley/issues/35) map. Grounds the display decision in
[status/logs display for token usage and task duration](https://github.com/femoral/parley/issues/39).

## Summary

**Coverage is not uniform.** Codex reports raw token counts per turn; Grok's pinned headless format
(`streaming-json`) reports none at all today. Neither vendor's headless stream reports a context-window
denominator, so "X of Y used" isn't computable from stream data alone for either vendor — only a raw count
(codex) or nothing (grok).

## Codex

`src/daemon/engine.ts` already extracts `usage` from every `turn.completed` event
(`src/daemon/adapters/codex.ts:280-289`) and persists it to the `usage` DB column, merged shallowly
(`usage = { ...usage, ...event.usage }`) on each occurrence.

- **Fields observed/documented**: `input_tokens`, `cached_input_tokens`, `output_tokens` — no `total_tokens`
  field ships in the event; a display layer would sum it itself. (Elixir SDK docs corroborate this shape.)
- **Cumulative vs per-turn is not confirmed from our own docs/fixtures** — `tests/fixtures/codex/` has no
  JSONL fixture with a `turn.completed` line to check against, and no pinned-version note settles it either
  way. An open upstream issue, [openai/codex#17539](https://github.com/openai/codex/issues/17539) ("Include
  per-API-call token usage (`last`) in turn.completed JSONL events"), implies the *current* field is a
  running/session total, not the last call alone — which would make the engine's shallow-merge-on-each-event
  approach roughly correct already (each new `usage` object supersedes the prior one). This should be
  verified directly against a real `codex exec --json` run before the display ticket assumes cumulative
  semantics — the current shallow merge is otherwise silently wrong for a multi-resume task if the field
  turns out to be per-turn-only.
- **No context-window size in the stream.** `codex debug models` (already probed for the model catalog,
  `parseCodexModels` in `src/daemon/adapters/codex.ts`) does *not* keep a context-window field — the parser
  only retains `slug`, `supported_reasoning_levels[].effort`, `default_reasoning_level`, deliberately dropping
  the rest of each model's catalog entry (including `base_instructions` and, per the raw catalog shape,
  likely a context-size field). If a "X of Y" display is wanted, the catalog parser would need to start
  keeping that field.

## Grok

`src/daemon/adapters/grok.ts` `parseEvent` handles `text`, `thought`, `end`, `error`, `fatal` — **no case
extracts usage into a `session_meta` event**. The pinned golden fixture
(`tests/fixtures/grok/v0.2.93-fresh.jsonl`) confirms the `end` event's actual fields are only `stopReason`,
`sessionId`, `requestId` — no token counts, no cost, nothing usage-shaped. `usage` is therefore always `null`
in the DB for every grok task today; this isn't a bug, there's nothing to extract from the interface parley
uses.

- Grok Build does expose usage *interactively* — public docs mention a `/tokens` slash command in its TUI and
  a 256K context window figure for its default model — but that's not part of the `streaming-json` headless
  format parley spawns with, and isn't something `grok -p` exposes non-interactively as far as this research
  found.
- Grok's own config format supports a `context_window` key for BYOK custom models
  (`docs/research/grok-build-cli-automation.md:36`), so the CLI clearly *has* the concept — it's just not
  surfaced in the headless event stream we consume. Worth a follow-up probe (`grok models --json`, if it
  exists, or a version bump) rather than assuming this stays permanently unavailable.
- No GitHub issue tracker access was available to check for an open feature request equivalent to
  openai/codex#17539 on the grok-build side; this research is web/docs-only, not exhaustive of xAI's issue
  tracker.

## Implication for the display ticket

A uniform "N of M tokens used" bar isn't deliverable today for either vendor. What's realistic for v1:

- **Codex**: raw `input_tokens` / `output_tokens` / `cached_input_tokens` counts, no percentage — pending
  verification of cumulative-vs-per-turn semantics above.
- **Grok**: no usage data at all; display must show an explicit "not reported" state, not a blank or zero
  (a bare `0` would misread as "used nothing").
