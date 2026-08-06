# Console v1 — proof-ledger completeness (#359)

Cross-check of every **must-add** item in
`packages/dashboard/docs/design/coverage-audit.md` §2A against landed surfaces
(#347–#358) and their ledgers. Tone-bound Cove cuts and wire-bound invented
items are listed explicitly so coverage is judged on **capability**, not
artifact fidelity.

Legend: **proven** = demo/ledger evidence · **cut** = explicit tone- or wire-bound cut · **gap** = landed capability missing proof (none remaining for v1 must-adds).

## §2A must-add → proof

| # | Must-add (coverage-audit) | Verdict | Where proven |
| --- | --- | --- | --- |
| 1 | Executors/runners surface (`GET /runners`, presence, vendors, in-flight, ONLINE/STALE) | **proven** | Fleet side panel `fleet-runners` + `useRunners`; unit `tests/fleet/runners.test.ts`; demo `issue-355/fleet-board` (runner status classes online/stale/offline) |
| 2 | Connection honesty: loading / offline / stale-reconnecting / per-panel error + empty | **proven** | Harness: `issue-353` intercept-error + reconnect; fleet honesty empty/error/offline in `issue-355/fleet-board`; metrics loading/error/empty/stale in `issue-358/metrics-board`; find loading/error/noMatch/results in `issue-354/find-honesty`; task empty selection + band error/stale in `issue-357/task-inspector`; run empty/error shells in `issue-356/run-detail` |
| 3 | Copy scaffolds: `parley answer`, `parley fix`, `parley delegate`, copy task id | **proven** | Task `CopyScaffold` + panels (`task-answer-scaffold`, `task-fix-scaffold`, …); fleet empty `fleet-delegate-scaffold`; tests `tests/task/format.test.ts`, `wiring.test.ts`; demos task-inspector + fleet-board |
| 4 | "Why it failed" error well; task-level eval score + feedback | **proven** | `task-why-failed` region; `task-eval-score` / `task-eval-feedback` / criteria; demo `issue-357/task-inspector` |
| 5 | Soundings filter bar + comparison view + size/difficulty buckets; reasoned group-by set | **proven** | Metrics filter bar, comparison panel, size/difficulty buckets; dims vendor/type/workflow/session (session = scope filter per wire-verification); demo `issue-358/metrics-board` |
| 6 | Find/search results treatment (task + session hits, states) | **proven** | Find combobox + honesty states demo `issue-354/find-honesty` (loading/error/noMatch/results) |
| 7 | Settings (follow logs, shortcuts opt-out) + full keyboard accelerator set | **proven** | `SettingsSurface`, `useAccelerators`, shell-chrome settings-open a11y + accelerator coverage in `issue-354/shell-chrome` |
| 8 | Accessibility bar: live regions, tablist/listbox/combobox, skip links, reduced motion | **proven** | Per-screen axe + ariaSnapshot + keyboardWalk; chrome a11yByState resting/findPopup/settingsOpen; consolidated in `issue-359/a11y-sweep.json` + acceptance-sweep |
| 9 | Deliverable fetch-state honesty (not_fetched/none/ready/error, purged, missing-worktree) | **proven** | Task deliverables panel `task-dlv-state` data-state; run deliverables; demos task-inspector + run-detail |
| 10 | Block-reason vocabulary rendering | **proven** | Run screen block / loop / gate held states; demo `issue-356/run-detail` (gateHeldState, fork inherited/skipped) |

## §1 tone-bound cuts (Cove register — not Console)

These are **explicit cuts** so coverage is judged on capability, not Cove art:

| Feature | Cut reason |
| --- | --- |
| Scene/world (islands, ships, wake/wreck/fog/flare, camera, edge-alert chips) | Cove register; Console is instrument panel |
| Day-at-sea tenure + weather | Cove tone |
| Nautical copy voice | Cove tone; Console uses plain instrument labels |
| Vendor emblem art | Coat + text on fleet rows; emblems deferred |
| Parchment RunChart (wax seals, loop arcs, marginalia) | Replaced by pipeline / iteration grid / node table |
| KitBand dev toys | Cove-only |

## §2B invented → build / cut / reframe (wire-verification)

| Invented mock element | Wire verdict | Console disposition | Proof / cut |
| --- | --- | --- | --- |
| Token-burn 24h histogram | wire-supported (client bucket) | **built** — retention-bound sparkline | `issue-355` burnBound + `fleet-burn-bound` |
| Fleet tokens + duration columns | wire-supported | **built** | `issue-355` tasksTable1280 |
| Firehose event text | partial (task rich, run thin) | **built** to wire capacity; rich gate-verb lines cut | `issue-355` firehose panel |
| Metrics `group_by=workflow` | via `/run-metrics` | **built** | `issue-358` |
| Metrics `group_by=session` | filter only | **reframed** as session scope filter | `issue-358` metrics-session-scope |
| Concurrency cap denominator | needs daemon | **honesty** — "cap unknown" when absent | `issue-355` capAbsent gate |
| Report file churn (+/−) | needs daemon | **cut** — paths only; no invented +/− | `task-report-nochurn` note when absent |
| Global header `tail` status | reframe | **reframed** — live-status / selected-task tail, not global log | shell `live-status` |

## Screen × ledger map

| Screen / surface | Ticket ledger | Demo id(s) |
| --- | --- | --- |
| Harness (staged / intercept / reconnect) | `issue-353` | staged-daemon, intercept-error, reconnect |
| Shell + chrome + find honesty | `issue-354` | shell-chrome, find-honesty |
| Fleet board | `issue-355` | fleet-board |
| Run detail | `issue-356` | run-detail |
| Task inspector | `issue-357` | task-inspector |
| Metrics | `issue-358` | metrics-board |
| v1 acceptance gate | `issue-359` | acceptance-sweep (+ packed-install, e2e record) |

## Gaps remaining (structural — not hacked)

None of the §2A must-adds lack landed proof. Structural follow-ups (daemon work, not Console hacks):

1. Report file churn on the wire (if product wants +/− columns).
2. Concurrency cap denominator on `/health` or `/info`.
3. Richer run/gate firehose event payloads.

These are **report items** for triage, not v1 Console blockers.
