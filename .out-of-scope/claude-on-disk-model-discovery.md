# Claude on-disk model discovery

Parley does not implement a `readModels()` on-disk discovery reader for the
claude vendor. The shipped catalog's hardcoded floor of base aliases (with
efforts) is the mechanism, deliberately.

## Why this is out of scope

The proposal was that a reader could contribute the *entitlement delta* — the
entitled-model cache plus the additional-model options cache in the CLI's
config file — so newly released models could become selectable without a
parley release. The evidence did not survive verification:

- Claude's base model aliases are compiled into the binary; nothing on disk
  enumerates them. Any reader could only ever be additive over a hardcoded
  floor.
- In **two independent, actively-used authenticated homes** (both subscription
  OAuth), the entitled-model cache was an **empty array**.
- The additional-options cache held exactly one entry in both homes —
  byte-identical: a `[1m]` context variant of a base model. The shipped
  catalog already excludes routing aliases and context variants by deliberate
  decision ("not distinct models worth an allowlist slot"), so even that one
  entry contributes nothing.
- Every other model-shaped key in the file is feature-flag configuration or
  client-side cache slots — not a catalog by any reading.

Whether the cache populates under API-key or enterprise auth (Bedrock,
Vertex) was left unverified, and deliberately so: those modes very likely use
the same files, and **plain subscription OAuth is the common denominator
parley supports** — a discovery channel that is provably empty for the common
case is not worth building on speculation about the uncommon ones.

## Reopening condition

A real home whose entitled-model cache is non-empty, with the field names of
one entry (no credential material) and the auth mode + action that produced
it. That would establish the delta the proposal rests on, and the issue can be
reopened with `readModels()` plumbing from #281 ready to build against.

## Prior requests

- #285 — "models: claude on-disk model discovery — entitlement cache was empty
  in the surveyed home" (split out of #283 during triage)
