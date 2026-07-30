# ADR-0006: Default sandbox workspace+network; vendor approvals disabled

**Status**: accepted · **Date**: 2026-07-09 · **Decided**: [#12](https://github.com/femoral/parley/issues/12)

## Context
Headless defaults are hostile: codex exec is read-only (child can't edit its worktree); grok defaults to permission_mode=ask and stalls. Vendor approval prompts have no headless answerer.

## Decision
- Default posture: write access to the worktree, network **on** (dependency installs just work). Normalized `--sandbox read-only|workspace|full` + `--no-network`; adapters map to vendor mechanisms.
- **Enforcement is not portable** (#279): each adapter declares what each posture request actually gets (`VendorAdapter.enforcement` — `enforced` / `approximate` / `none` / `refused`). The user-facing matrix lives in the README and `parley info`; prepare emits a non-fatal `PARLEY-DIAG` when a requested posture is only approximate/none.
- Vendor approvals disabled (codex `-a never`, grok `--always-approve` + permission rules). Where a vendor has a real sandbox, that is the guardrail; escalation is social via `ask_orchestrator`.

## Consequences
- Children can reach the network by default — accepted for a personal tool because parley never merges and the orchestrator reviews diffs (ADR-0005).
- Mechanical approval-routing through the hub deferred; would require persistent-protocol adapters (ADR-0004).
- Operators must consult the enforcement matrix before assuming `--sandbox` / `--no-network` are OS-real on a given vendor.
