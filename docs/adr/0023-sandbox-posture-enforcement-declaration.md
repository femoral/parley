# ADR-0023: Sandbox posture is best-effort; adapters declare enforcement

**Status**: accepted · **Date**: 2026-07-29 · **Decided**: [#279](https://github.com/femoral/parley/issues/279)

## Context
Every adapter accepts the normalized posture surface (`--sandbox read-only|workspace|full`, `--no-network`; ADR-0006), but enforcement is vendor-dependent: a conformance round (#278) showed writes *above* the worktree root succeeding under `workspace` for grok, kimi, and openhands. kimi and openhands cannot enforce any sandbox matrix (documented only in adapter source comments); grok's behaviour was incoherent (gitdir denied inside the repo, escape above the root). Nothing user-facing says which adapters enforce what — the README reads as a portable guarantee, and the "spec §8 table" cited by ADR-0006 and adapter comments no longer exists.

## Decision
- **Posture is a best-effort request, not a guarantee.** Tasks run even when the adapter cannot enforce the requested posture — no fail-closed prepare, no per-task diagnostic. (Vendors that themselves refuse to start, like grok without bubblewrap, keep their #247 fail-closed prepare.)
- **Adapters self-declare enforcement** via a capability field on the adapter contract in `@useparley/core` (per posture: enforced / advisory / none; plus network-off). Built-in adapters declare what their source already documents. Third-party plugins that don't declare default to unknown, treated as not-enforced.
- **`parley init` shows a disclaimer** when the user sets up a vendor whose declaration says a posture it accepts is not enforced.
- **Docs carry the matrix** generated from the declarations (README), replacing the dead spec-§8 references.
- grok's `workspace` declaration is set from a *measured* re-run of the above-root probe after the #278 gitdir-profile fix lands — not from assumption.

## Consequences
- Users of kimi/openhands keep working defaults but are told at setup time that the sandbox guardrail is advisory there; ADR-0006's "the sandbox is the guardrail" holds only on enforcing adapters.
- Live per-adapter conformance probes are out of scope for the core repo (the e2e bed is their home); the declaration is the honest statement, not a proof.
