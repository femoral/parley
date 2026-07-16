# Explainer: the vendor-expansion run (2026-07-16)

One autonomous orchestration run took parley from 2 vendor adapters to a
12-vendor, plugin-extensible, remotely-executable, metrics-instrumented
system. This documents what landed, in what order, and why each decision went
the way it did. Everything was tracked in GitHub milestones M1–M8 and issues
#95–#120 (all closed); every code change was delegated to grok-4.5 (high
effort) via parley itself, reviewed, evaluated, and merged by the
orchestrator.

## What landed

| Area | Result | Issues |
| ---- | ------ | ------ |
| Research | 10 live-verified CLI automation docs under `docs/research/` | #96 |
| Adapters | opencode, claude, gemini, goose, pi, cline, kilo, openhands, hermes, openclaw — golden-fixture tests each | #97–#106 |
| Validation | Adversarial re-derivation of all 10 surfaces; 8 critical + 15 major defects found and fixed | #107 |
| Plugin interface | Adapter contract public in `@useparley/core`; `vendors.<id>.plugin` loading; authoring guide | #108, ADR-0009 |
| Channels | `/child/report`, `/child/ask`, `/child/task` REST + `parley child` CLI beside MCP | #109/#110, ADR-0011 |
| Remote runners | `@useparley/runner`: lease/heartbeat/events/branch-push, bearer auth | #111, ADR-0012 |
| Settings & profiles | `daemon.url`, `vendors.*`, `profiles.*`, `runners.*`; `--profile` tracked per task | #112/#113, ADR-0010 |
| Skills | delegate updated; parley-wizard + parley-rubric new; installer TUI on @clack/prompts | #114–#117 |
| Metrics | size/difficulty classification, canonical usage normalization, `GET /metrics`, `parley metrics`, Cove "Soundings" board | #118/#119 |
| grok usage | daemon-local xAI reverse proxy captures per-task tokens | #95 |
| Docs | README, this explainer, 4 new ADRs, research corpus | #120 |

Final state: 1119 tests green, lint and typecheck clean, everything on `main`.

## How it ran

Research → foundation → implementation → adversarial validation → fixes, as
parley fan-outs (10–12 concurrent grok-4.5 tasks per wave), each task in its
own worktree, merged by cherry-pick onto `main` with local re-verification
(typecheck + targeted tests per merge, full suite per wave). Every task got a
`parley eval` score. Adapter tasks were forbidden from touching the shared
registry — the orchestrator wired `adapters/index.ts` at merge time, which is
what made 10 parallel adapter branches conflict-free. The one deliberate
conflict (runner ∥ metrics, both appending db migrations and delegate flags)
was accepted for wall-clock and resolved by hand in minutes.

## Decisions and why

1. **Research before code, one doc per harness, live-verified.** Adapters
   written from memory hallucinate flags. Each doc pins the interrogated
   binary version and tags every claim VERIFIED/DOCS/UNKNOWN. The validation
   pass later proved the value: most criticals were in exactly the places the
   docs had marked UNKNOWN.
2. **Adapter contract moved to `@useparley/core`, not a new package** (#108).
   Core is already the shared, versioned surface; the daemon keeps a
   re-export shim so nothing broke. Plugins are `createAdapter(env)` factories
   resolved from `~/.parley` (abs path, `file:` URL, or bare specifier), fail
   loud per plugin, never crash the daemon.
3. **Profiles resolve daemon-side** (#113). The daemon reads the same config
   file, so CLI and future UIs get identical resolution; the profile *name*
   is persisted on the task row, which is what makes `parley metrics
   --group-by profile` honest.
4. **Three child channels, one engine** (ADR-0011). MCP stays canonical; the
   REST surface reuses `submitReport`/`askOrchestrator` verbatim so semantics
   can't drift; the CLI wraps REST. Correlation stayed header-based
   (`x-parley-task`) everywhere — one trust model, three transports. This
   paid off immediately: the pi adapter's MCP gap was fixed by materializing
   a hub extension that speaks the REST channel.
5. **Persistent lease-based runners, not per-task ssh sidecars** (ADR-0012).
   Outbound-only auth (runner → daemon bearer token) matches real firewalls;
   one daemon keeps one seq stream so `watch` semantics survive; branch
   handoff is a git push because the commits are already git objects.
6. **Adversarial validation as a separate, hostile pass** (#107). Two
   independent reviewers re-derived every surface from primary sources with
   instructions that zero findings would not be credible. They found a
   systemic engine bug no implementer caught: stderr never reached
   `parseEvent`, silently losing hermes session ids, goose MCP-init failures,
   and openclaw auth errors. The engine now feeds both streams (raw logs stay
   separate). Unfixable upstream limits (openhands' 300s MCP ceiling, cline's
   broken headless resume) are documented and fail loud rather than fake it.
7. **Classification at delegate time, evals unchanged** (#118). Size and
   difficulty describe the *brief*, so they're recorded when the brief is
   written (`--size`/`--difficulty`), not inferred later. `parley eval`
   stays a single score+feedback write; the rubric skill (#116) makes the
   score derivable from binary MECE gates instead of vibes.
8. **Canonical usage keys with raw passthrough.** Vendors disagree on usage
   field names; `normalizeUsage` maps known families to
   input/output/cached and metrics aggregate only those, while raw vendor
   fields stay stored for debugging. grok emits no usage at all in its
   stream, hence the xAI reverse proxy (#95) — a first-class base-URL
   override, no TLS interception.
9. **UI stayed inside the Cove design system.** The Soundings board reuses
   plate/chip/token vocabulary, authored micro-SVG bars instead of a chart
   dependency, refreshes on SSE transitions rather than polling, and passed
   an impeccable polish pass (single drift found: missing ease transition on
   the new chips).
10. **Sensitive-info scrubbing at merge.** Research children occasionally
    leaked absolute home paths into docs; every merge greps and rewrites to
    `~`-relative before anything is pushed.

## Where the bodies are buried (honest limits)

- **cline**: headless resume is broken upstream at 3.0.42 — the adapter
  refuses loudly instead of silently starting a fresh session.
- **openhands**: MCP tool timeout is SDK-fixed at 300s; long
  `ask_orchestrator` waits emit a PARLEY-DIAG instead of working.
- **hermes / openclaw**: no streaming event surface; adapters synthesize
  events from final output — live tool progress is opaque by vendor design.
- **grok proxy**: `restrict_network` loopback exemption (research proposal
  #2) intentionally not implemented; no-network grok tasks may not report
  usage.
- **Kilo success-path stream** was verified from binary emission code, not a
  live authenticated run (no provider key available in the sandbox).

Each limit is documented in the adapter's header comment and the validation
docs — none of them is silent.
