# Console v1 acceptance record — issue #359

Wave-4 acceptance gate for Parley Console v1 (#347–#358). Contract:
GitHub issue #359 (Scope + Acceptance).

## Environment

| Fact | Value |
| --- | --- |
| Node | ≥ 24 (verified at run time) |
| Package | `@useparley/dashboard` |
| Base program | shell/chrome #354, fleet #355, run #356, task #357, metrics #358, data #352, verify harness #353, ordered probe #348 |
| Design register | `packages/dashboard/docs/design/` (frozen; not edited by this ticket) |
| e2e bed | sibling `parley-e2e` (read/run in place; **no commits there**) |

## Deliverables checklist

| Scope item | Artifact |
| --- | --- |
| e2e-bed acceptance pass | this file §e2e + `e2e-record.json` |
| Full a11y sweep | `a11y-sweep.json` + `entry.json` demo `acceptance-sweep` |
| Proof-ledger completeness | [`coverage.md`](./coverage.md) |
| Onboarding/README | root `README.md` + CLI hint `packages/cli/src/commands/ui.ts` |
| Publish readiness | `packed-install.json` via `pnpm --filter @useparley/dashboard verify:packed` |

## How to re-run

```sh
# From monorepo root (Node ≥ 24)
pnpm --filter @useparley/dashboard build
pnpm --filter @useparley/dashboard verify          # all screen demos + ledger refresh
pnpm --filter @useparley/dashboard verify:check    # merge gates
pnpm --filter @useparley/dashboard verify:acceptance
pnpm --filter @useparley/dashboard verify:packed   # offline pack + daemon serve
pnpm exec vitest run --project integration packages/cli/tests/ui.test.ts
```

Screenshots under `shots/` are gitignored; regenerate with the verify commands.
Ledger `entry.json` / JSON proofs are committed (no absolute `/home/…` paths).

## e2e-bed acceptance pass

### What the bed is

Sibling repo scenarios (conformance × 15 vendors + feature scenarios 0101–0119).
Orchestration matrix expects Docker + real vendor credentials for a full
real-vendor pass. This machine's preflight (host) reported:

- **Ready** baseline (`npm run check` green in the e2e repo)
- **fake** vendor always available
- Real CLIs present: codex, claude, grok, agy, opencode, pi, hermes, cursor-agent
- Missing CLIs (scenarios skipped if targeted): goose, cline, kilo, openhands, openclaw, kimi
- Hermetic label set is currently the **remote-runner / remote-daemon / client-auth**
  fake scenarios (0112, 0115–0119) — not a full fake conformance substitute

### What we ran (honest)

| Layer | Vendor | What ran | Console surfaces |
| --- | --- | --- | --- |
| **Inner loop (primary)** | fake | All `verify/` demos (#353–#358) + `acceptance-sweep` against real in-process daemon + fake-vendor action scripts (`report-success`, `vendor-failure`, `awaiting-answer`, `long-running`, …) | Fleet, Run, Task, Metrics, chrome at 1280/1460/1920 |
| **e2e bed baseline** | n/a | `scripts/preflight.sh` on host → ready (warnings for uninstalled vendors); `npm run check` green | n/a (code under test) |
| **e2e bed hermetic / fake matrix** | fake | Host preflight + issue inventory; full matrix orchestration requires the orchestrator container + credentials (not driven as a complete real-vendor round here) | Documented gap |
| **Real-vendor e2e** | codex/claude/grok/… | **Not fully executed** as an orchestrated multi-round matrix in this task | Documented gap |

**Documented gap (not simulated):** a full real-vendor e2e-bed matrix pass
(every vendor as worker × orchestrator rounds inside `docker/compose.sh`
orchestrator) needs long-running credentials, container mounts, and human/agent
watch-loop time beyond this gate's offline/fake-vendor proof. The Console v1
program's acceptance on **daemon surface coverage** is proven by the fake-vendor
inner loop + per-screen honesty gates; realism against live vendor CLIs remains
an e2e-bed ops run.

### Daemon state reached (acceptance-sweep)

Multi-task fake-vendor staging on a real daemon:

- completed + report (`report-success`)
- failed (`vendor-failure`)
- awaiting_answer (`awaiting-answer`)
- running (`long-running`)

Surfaces exercised: `#/fleet`, `#/run`, `#/task`, `#/metrics` + chrome
(header, nav, find, footer). Measured spot-checks at **1280 / 1460 / 1920**
with screenshots under `shots/acceptance-*.png` (local regenerate).

## Full a11y sweep

Consolidated in `a11y-sweep.json` (machine) and `entry.json` → `acceptance-sweep`.

| Surface | States covered (proof source) | axe | keyboard |
| --- | --- | --- | --- |
| Chrome | resting, find popup, settings open (`issue-354`) | 0 violations | leaves body |
| Find | loading, error, noMatch, results (`issue-354/find-honesty`) | per-state | — |
| Fleet | populated + empty + error + offline (`issue-355`) | 0 | leaves body |
| Run | populated views + empty/error shells (`issue-356`) | 0 | leaves body |
| Task | populated + empty selection + error/stale bands (`issue-357`) | 0 | leaves body |
| Metrics | populated + loading/error/empty/stale (`issue-358`) | 0 | leaves body |
| Harness | staged, intercept 5xx, reconnect offline→recover (`issue-353`) | 0 | leaves body |
| Acceptance | all four screens populated @ 1460 composited (`issue-359`) | 0 | all leave body |

AA contrast measured on composited chrome stacks in `issue-354` (contrast helper)
and sampled again in the acceptance sweep.

**One-liner a11y fixes during this gate:** none required (prior demos already
green). Structural defects: none found that blocked the gate; see coverage.md
for daemon-side follow-ups.

## Publish readiness

Script: `packages/dashboard/verify/scripts/packed-install.mjs`
(`pnpm --filter @useparley/dashboard verify:packed`).

| Check | Result |
| --- | --- |
| Offline (no registry install of transitive deps for the pack step) | yes — `npm pack` local + tarball extract |
| `parley.ui` marker → `www` | pass |
| `files` → `["www"]` only | pass |
| `publishConfig.access` public | pass |
| Tarball has no src/verify/tests/docs | pass |
| Version independence vs daemon | pass (dashboard version ≠ daemon; daemon does not depend on dashboard) |
| Extract into scratch `PARLEY_HOME` → daemon discovers + serves | pass (`health.ui_available`, GET `/` HTML, SPA fallback, `/tasks` not shadowed) |

Note: repo `packages/cli/tests/packed-install.smoke.test.ts` remains an
**environmental** failure here (npm ETIMEDOUT on registry). This ticket's check
is the offline substitute and is re-runnable without registry access.

## Onboarding

- Root README Install leads with `@useparley/dashboard`; documents Cove via
  `config.ui.package` and ADR-0033 probe order.
- `parley ui` with no UI installed prints Console install first, then Cove +
  `config.ui.package` (test updated).

## Definition of done (verification)

Recorded when the gate is cut:

- [x] `pnpm typecheck`
- [x] `pnpm lint`
- [x] dashboard unit + integration tests (from monorepo root: `pnpm exec vitest run packages/dashboard/tests` — 196 passed)
- [x] `pnpm --filter @useparley/dashboard build`
- [x] `pnpm --filter @useparley/dashboard verify` + `verify:check`
- [x] `pnpm --filter @useparley/dashboard verify:acceptance`
- [x] `pnpm --filter @useparley/dashboard verify:packed`
- [x] `pnpm exec vitest run --project integration packages/cli/tests/ui.test.ts` (10 passed)
