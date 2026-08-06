repo: femoral/parley
branch: develop
path: packages/ui

## Last sync

date: 2026-07-30T16:45:00Z

### Updated in this project

- New utility-first console UI ("Parley Console") replacing the Cove scene: neutral dark palette, IBM Plex Sans/Mono, dense 1920×1080 board.
- Workflow runs (develop branch) visualized three ways: pipeline, iteration grid, node table — nodes, gates, fan-out slots, iterations, deliverables.
- Attention queue reframed for orchestrator-only answering: held gates, outstanding asks, stalled and fresh failures; read-only with copy affordances.
- Metrics screen carries Soundings data shapes (group-by, success, eval vs baseline, criterion-failure heatmap).

## Screen map

| Screen | Built from |
| ------ | ---------- |
| Fleet board (`Parley Console.dc.html`, screen `overview`) | `packages/ui/src/app/Cockpit.tsx`, `src/hud/types.ts` (RosterTask / RosterRun / RosterPip), `src/hud/HealthPanel.tsx` props (`HealthView`), `src/tokens/state-meta.ts`, `src/tokens/factions.ts` |
| Run detail (screen `run`) | `packages/ui/src/chart/RunChart.tsx`, `src/hud/Inspector/RunView.tsx`, `src/hud/Inspector/DeliverableView.tsx` (via `InspectorRun*` types), `CONTEXT.md` workflow glossary |
| Task inspector (screen `task`) | `src/hud/types.ts` (BriefView / LogsView / QaTurn / ReportView / AttemptLineageItem), `src/hud/Inspector/*` |
| Metrics (screen `metrics`) | `src/hud/types.ts` (SoundingsView / SoundingsGroupView / Distribution / Heatmap), `src/hud/SoundingsPanel.tsx` |

Notes: `main` was read for the pre-workflow baseline (`Cockpit.tsx`, `tokens/tokens.css`, `PRODUCT.md`); the redesign targets `develop`, which adds runs/nodes/gates. Gate verbs stay with the orchestrating agent — the console is observation-only.
