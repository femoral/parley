# Parley Console — feature coverage audit

Asset for the wayfinder ticket "Feature coverage audit: Parley Console mock vs what the daemon exposes on develop" (femoral/parley#338, map #337).

Compares the Parley Console mock (`Parley Console.dc.html`, this directory) against the full
feature/data surface the daemon exposes on `develop` and that Parley Cove (`packages/ui`)
renders today. Four verdicts:

- **covered** — the mock has an equivalent element.
- **partial** — present but thinner than Cove/wire; the spec must say how far to go.
- **missing** — Cove/wire feature with no mock element; must be added for the console to earn the default slot.
- **invented** — mock element with no wire support today; decide build (daemon work), cut, or defer.

Both UIs are observation-only: neither issues a single write; gate verbs stay with the
orchestrating agent. The mock states this explicitly (run screen banner, footer).

## 1. Coverage matrix — daemon/Cove surface → Console mock

### Shell & chrome

| Feature (Cove / wire) | Console mock | Verdict | Notes |
|---|---|---|---|
| Mode/screen navigation (Cove↔Soundings) | Header tabs Fleet / Run / Task / Metrics with live sublabels | covered | Console splits center-stage modes into four screens |
| Daemon health chip (`/health`: status, version, pid, host, port, uptime, sessions) | Header `daemon <origin> <detail>` + pulse dot | partial | Mock shows origin + one detail string; version/pid/uptime/sessions have no home |
| Executors / runners fleet (`/runners`, ExecutorsPanel #324) | — | **missing** | No runner presence, vendors, in-flight, or ONLINE/STALE chips anywhere in the mock |
| Attention count pill + document-title badge | `needs orch` header counter | partial | Header pill yes; `(N)` title badge unspecified |
| Connection honesty (chart-stale band, OFFLINE, SSE reconnect, "Hailing…" loading states) | Static `tail` status in header only | **missing** | Mock is a live-data demo; no offline/stale/loading/error treatments for any panel |
| Settings (follow logs, shortcuts opt-out, persisted localStorage) | — | **missing** | |
| Keyboard accelerators (`/`, `n`, `⇧N`, `m`, `Esc`) | `/` hinted in filter box | partial | Others unspecified |
| Skip links, live regions, ARIA listbox/tablist/combobox patterns | — (static export) | missing-by-nature | Spec must carry Cove's a11y bar; mock can't show it |
| State legend + hints (ChartKey popover: states, model marks, harness coats, keys) | Footer legend strip (states only) | partial | Harness coats appear in task rows; vendor emblems and hints/keys absent |
| Day chip / clock | Header clock `HH:MM` | covered | Tenure/weather are Cove-tone; console keeps the clock only |

### Roster / fleet board (Console "Fleet" screen)

| Feature | Console mock | Verdict | Notes |
|---|---|---|---|
| Task list w/ state groups, attention-rank ordering | Tasks table sorted "by attention, then age" + state filter chips | covered | Table replaces grouped list |
| Run list as peer rows w/ pip track (`nodes × loop.max`, cap 20, severity-preserving aggregation) | Runs table with `track` pip cells | covered | Cap/aggregation rule must carry over |
| Session scoping ("All hands" + recent sessions) | `scope · orchestrator session` sidebar panel | covered | Mock hides it on the overview screen (`showScope`); Cove scopes everywhere — spec must decide |
| Find combobox (task hits local, session hits `/sessions?q=`, debounce, a11y states) | Static `/ filter tasks, runs, branches` box | partial | No results treatment, loading/error/no-match states in mock |
| Task row identity: harness coat, vendor emblem, faction | Coat swatch + `harness · model` text | partial | Coats yes; vendor emblems dropped — decide if coat+text suffices |
| Run chip on task rows (`7f3a · review.2.tests`) | `run address` column | covered | |
| Executor label on task rows (multi-runner fleets) | — | **missing** | Ties to the missing executors surface |
| Fresh-failure loud window (5 min), beacons, `⇧N` cycle | `t.note` fresh markers, attention sort | partial | Window/acknowledge semantics unspecified |
| Empty fleet → copyable `parley delegate` scaffold; "Hailing the fleet…" | — | **missing** | No empty/connecting states in mock |
| Footer stats (total, active) | KPI strip (needs-orch, running, queued/pending, runs, settled 24h, token burn) | covered+ | KPI strip is richer; "settled 24h" and success% are client-derivable |
| Per-task tokens + duration columns in the fleet table | `tokens`, `dur` columns | invented? | **Verify wire**: `/tasks` list envelope may not carry usage/duration (Cove reads usage only from `/tasks/:ref` detail). If absent → daemon work or cut |
| Concurrency cap in KPI note (`cap 16`) | KPI note | invented | Cap isn't exposed by any UI-consumed endpoint today |
| Throughput segment bar + state distribution chips | Sidebar `throughput` | covered | Client-derivable from the task set |
| Token burn 24h histogram (sidebar sparkline, in/out/cached totals) | Sidebar `token burn · 24h` | **invented** | No time-bucketed usage endpoint exists (`/metrics` is aggregate-only) — daemon work, or cut |

### Attention queue (right rail) vs Cove inbox + edge alerts

| Feature | Console mock | Verdict | Notes |
|---|---|---|---|
| Outstanding asks (question, age, session, copy `parley answer` scaffold) | AWAITING cards with reason/meta | partial | Cards show the ask; the copy-answer scaffold (Cove's core affordance) isn't drawn — sync notes say "copy affordances", spec must pin them |
| Held gates surfaced as attention | GATE HELD cards | covered | Richer than Cove's inbox (Cove shows gates on roster/run only) |
| Stalled + fresh failures as attention | STALLED / FAILED cards | covered | Console unifies what Cove splits across roster ranks + edge alerts |
| Cards/rows density toggle | cards / rows buttons | covered | New, harmless |
| Live region announcements, "fleet-wide" qualifier under session scope | — | missing-by-nature | Spec item |
| Global event feed | Firehose panel (`watch --follow`) | partial/invented | `/events/stream` SSE carries task lifecycle events; mock's firehose text lines are plausible projections, but run/gate events on the stream need **verification** |

### Run screen vs RunView + RunChart

| Feature | Console mock | Verdict | Notes |
|---|---|---|---|
| Node table: (node, iteration) rows, kind, state, tasks, gist, duration | `node table` view | covered | |
| Fan-out width (`×N`, never N marks), slots | Pipeline node cards with slot bars + fan labels | covered | Slot names shown — richer than Cove |
| Iteration loops (loop-back, `pass N of M`) | `iteration grid` view + loop note bar | covered | Grid is new and stronger than Cove's `.N` suffixes |
| Gates: held vs actioned, `on_reject →` branch, helm notice ("verbs belong to the orchestrating agent") | Gate cards + read-only banner | covered | Verb list matches (approve · reject · redirect · finish) |
| Fork vocabulary: `inherited` (struck/quiet) vs `skipped` (loud cue) | `n.strike` + `n.cue` in node table | covered | |
| Block reasons (`gate`, `loop N/M`, `X/Y slots`, `spawn`, `inputs`) | Loop-budget note, held states | partial | Full reason vocabulary must be specced |
| Deliverables: inline JSON / file / dir refs / purged; `not_fetched`/`none`/`ready`/`error` four-state | Deliverables panel w/ kind, body, meta | partial | Kinds present; the four fetch-states and purged/missing-worktree notes unspecified |
| Run outputs block | `run outputs` dashed card | covered | Cove doesn't render this; wire has it via deliverables |
| Run tasks list (per-run task rows) | `run tasks` panel | covered | **Verify wire**: needs task-by-run filter on `/tasks` (filter query exists) |
| Copy run id | button | covered | |
| Pending ("Hailing the run…") / empty ("No nodes entered yet.") | — | **missing** | |
| Run `workspace` / `type` / run-level usage (on wire, unrendered by Cove) | Brief shows run workspace path; scratch workspace named | covered+ | Console renders wire data Cove drops — good |

### Task screen vs Inspector

| Feature | Console mock | Verdict | Notes |
|---|---|---|---|
| Brief: goal, state, branch, worktree/run-workspace, harness · model · effort, sandbox/network posture, address, duration, usage | Brief key/value list | covered | Matches BriefView + address; posture line included |
| Queue position + blocking cap (`#3 · vendor:x`) | In brief `state` row | covered | |
| Attempt chain: #N, state, cache/resumed badges, score vs baseline, current marker | `attempt chain · parley fix` panel | covered | |
| "WHY IT FAILED" error well + copy `parley fix` scaffold | — | **missing** | Panel header hints `parley fix` but no error well or scaffold drawn |
| Eval score badge + collapsible eval feedback | Attempt scores only | partial | Task-level `evalScore`/`evalFeedback` have no home |
| Log tail: kind-coloured lines, follow/paused/ended/unreachable status, stick-to-bottom | `log tail` center pane w/ status + sticky scroll | covered | Mock even implements scroll-stick |
| Q&A transcript: ask/answer turns, timestamps, copy `parley answer` for outstanding turns | `q&a — orchestrator answers` panel | partial | Turns + pending answers yes; copy-answer scaffold not drawn |
| Report: outcome badge, summary, files changed | `report` panel w/ outcome, summary, file list | covered | |
| Report file churn (`+N −M`) | `f.churn` column | **invented** | Wire carries paths only (`ReportFile.path`) — daemon work or cut |
| Goal/report "read full" popovers, scroll cues | — | missing-by-nature | Spec item |
| Copy branch / copy task id | copy branch button | partial | Task-id copy unspecified |
| Empty states (no log / no report / no parley / no attempts) | — | **missing** | |

### Metrics screen vs Soundings

| Feature | Console mock | Verdict | Notes |
|---|---|---|---|
| Group-by dimensions (Cove: vendor, model, type, profile, difficulty + 8 more) | Tabs: vendor, type, workflow, session | partial+invented | Mock drops model/profile/difficulty/…; adds **workflow** and **session** — `group_by=workflow` support needs **verification**; session exists as a filter, as a group-by needs verification |
| Group table: tasks, success rate bar, eval avg, tokens I/O/C, duration avg·p95 | Metrics table | covered | Same shapes (SoundingsGroupView) |
| Below-baseline rate (comparison tab) | `below base` column | partial | Column yes; full comparison tab (avg delta, first-vs-fix recovery split) absent |
| Score vs baseline distribution (0–10 track, baseline mark, delta) | `score vs baseline` panel | covered | |
| Criterion-failure heatmap (criteria × groups, low-sample cue, no-sample tiles, suspect `100%!` cap) | `criterion failure rate` panel | covered | Low-sample/suspect cues unspecified |
| Eval filter bar (type/vendor/model, orch harness/model, judge harness/model/rubric, first-attempt-only, below-baseline-only, clear) | — | **missing** | Whole filter surface absent |
| Eval-by-size / eval-by-difficulty chips per group | — | **missing** | |
| States: loading / empty / filter-aware empty / error / stale banner / evalPresence | — | **missing** | |
| Session scope label / metrics meta | `metricsMeta` | covered | |

### Cove features deliberately not carried (tone-bound — confirm as cuts)

Scene/world (islands, ships, wake/wreck/fog/flare effects, camera framing, edge-alert chips), Day-at-sea tenure + weather, nautical copy voice, vendor emblem art, parchment RunChart (wax seals, loop arcs, marginalia — the console's three run views replace it), KitBand dev toys. These are Cove's register; the console replaces them by design. The spec should list them as **explicit cuts** so coverage is judged on capability, not artifact.

## 2. Gap lists

### A. Must-add for full coverage (mock → spec additions)

1. Executors/runners surface (#324 parity: presence, vendors, in-flight).
2. Connection honesty everywhere: loading/connecting, offline, stale-reconnecting, per-panel error and empty states (Cove has ~15 distinct ones; inventory in §1).
3. Copy scaffolds: `parley answer`, `parley fix`, `parley delegate`, copy task id (mock has only copy run id / branch).
4. "Why it failed" error well on the task screen; task-level eval score + feedback.
5. Soundings filter bar + comparison view + size/difficulty buckets; full group-by dimension set (or a reasoned subset).
6. Find/search results treatment (task + session hits, states).
7. Settings (follow logs, shortcuts opt-out) + full keyboard accelerator set.
8. Accessibility spec: live regions, tablist/listbox/combobox semantics, reduced motion, skip links, visually-hidden ids — Cove's bar is high and documented in code.
9. Deliverable fetch-state honesty (not_fetched/none/ready/error, purged, missing-worktree).
10. Block-reason vocabulary rendering.

### B. Invented by the mock — build, cut, or defer (feeds the wire-delta decision)

1. Token burn 24h histogram — needs a time-bucketed usage endpoint.
2. Report file churn (+/−) — needs churn on the report wire shape.
3. Fleet-table per-task tokens/duration columns — needs usage/duration on the `/tasks` list envelope (verify first).
4. Firehose event text — verify `/events/stream` carries enough (run/gate events?) or needs enrichment.
5. `group_by=workflow` and `group_by=session` metrics dimensions — verify `/metrics` support.
6. Concurrency cap (`cap 16`) in KPI note — not exposed today.
7. `tail` status in the global header (log-tail status is per-task today).

### C. Verify on the wire before deciding (small research items)

- `/tasks` list envelope fields (usage, duration, note/error presence).
- `/events/stream` event vocabulary (task-only vs run/gate events).
- `/metrics` `group_by` accepted values.
- `/tasks?run=` filtering for the run-tasks panel.
- Unused-but-available endpoints the console could adopt: `/run-metrics`, `/runs/:ref/nodes/:node`, `/info`.

## 3. Reference

- Mock: `Parley Console.dc.html` + `support.js` (this directory); sync notes in `github.md`.
- Cove-side inventory sources: `packages/ui/src/hud/types.ts`, `hud/*`, `hud/Inspector/*`, `chart/`, `scene/`, `app/hooks/*`, `tokens/*`; daemon surface `packages/daemon/src/server.ts` routes + `packages/core/src/sdk.ts` client.
- Both surfaces are strictly read-only; mutating daemon routes exist but no UI calls them.
