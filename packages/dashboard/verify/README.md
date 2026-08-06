# Console verification harness

Package-local harness for **Parley Console** (`@useparley/dashboard`). Implements
the verification plan from [#345](https://github.com/femoral/parley/issues/345)
(built as [#353](https://github.com/femoral/parley/issues/353)).

## What lives here

| Path | Role |
| --- | --- |
| `lib/` | Headless browser drive, measurement, honesty intercepts, a11y, daemon+vite session, ledger I/O |
| `scripts/library.mjs` | Named **fake-vendor action scripts** (fan-out leaf, questions, failures, stalls, reports, churn) |
| `demos/` | Acceptance demos on the placeholder shell (#347) |
| `check.mjs` | **Merge-time screen check** (local; no CI wiring in v1) |
| `ledger/<ticket>/` | Per-ticket **proof ledger** |

### Constraints

- Imports **nothing** from `packages/ui` / `@useparley/ui` and loads no Cove context.
- **No test hooks in shipped code** (`src/` is never modified for verification).
- Dev-deps only: `playwright-core`, `axe-core`, `@axe-core/playwright` (already in package.json).

## Proof ledger

Per-ticket proofs land under:

```
verify/ledger/<ticket-id>/
  entry.json          # measurements, intercept probes, a11y, metadata
  shots/*.png         # screenshots (gitignored — bulky)
```

### Artifact policy

| Artifact | Commit? | Why |
| --- | --- | --- |
| `entry.json` | **yes** | Measured rects, computed styles, probes, a11y (YAML ARIA trees). Issue #353 baseline is ~400KB — not "small"; still text and diffs usefully. |
| `shots/*.png` | **no** | Bulky binary; regenerate with `pnpm verify` |
| absolute `/home/…` paths | **never** | Ledger uses paths relative to the ticket dir / repo root |

**Size policy for future screens:** keep full rects + styles at the three board widths; prefer compact a11y (axe summary + `locator.ariaSnapshot()` YAML, not DOM dumps). If a ticket's `entry.json` grows past ~1MB, split per-demo files under `ledger/<ticket>/` or drop redundant intermediate-phase style dumps — never commit PNGs to shrink JSON.

Screenshots are ignored by `verify/.gitignore`. Re-run demos to refresh PNGs locally.

### Entry shape (sketch)

```json
{
  "ticket": "issue-353",
  "package": "@useparley/dashboard",
  "demos": {
    "staged-daemon": {
      "kind": "staged-daemon",
      "daemon": { "taskId": "…", "state": "completed", "report": { } },
      "viewports": [
        {
          "name": "1280",
          "width": 1280,
          "height": 900,
          "screenshot": "shots/staged-daemon-1280.png",
          "elements": {
            "shell": {
              "found": true,
              "box": { "x": 0, "y": 0, "width": 1280, "height": 900 },
              "styles": { "backgroundColor": "…", "…": "…" }
            }
          }
        }
      ],
      "a11y": { "axe": { }, "aria": { }, "keyboardWalk": [] },
      "recordedAt": "ISO-8601"
    }
  }
}
```

## Running

From the monorepo root (Node ≥ 24):

```sh
# All three acceptance demos + ledger write
pnpm --filter @useparley/dashboard verify

# Merge-time check (re-runs demos, asserts ledger completeness)
pnpm --filter @useparley/dashboard verify:check

# Re-validate an existing ledger without re-driving the browser
pnpm --filter @useparley/dashboard verify:check -- --ledger-only

# Single demos
pnpm --filter @useparley/dashboard verify:staged
pnpm --filter @useparley/dashboard verify:intercept
pnpm --filter @useparley/dashboard verify:reconnect
```

### Chromium

`playwright-core` does not ship a browser. Resolution order:

1. `$PARLEY_VERIFY_CHROMIUM` or `$PARLEY_LAB_CHROMIUM`
2. Playwright cache under `$PLAYWRIGHT_BROWSERS_PATH` or `~/.cache/ms-playwright`
3. System `chromium` / `google-chrome`

```sh
npx playwright install chromium   # if none found
```

## Acceptance demos (#353)

1. **staged-daemon** — real daemon + fake-vendor script `report-success`; measure shell at 1280 / 1460 / 1920; axe + ARIA snapshot + keyboard walk.
2. **intercept-error** — Playwright route interception forces `/tasks` 500 and `/health` 503; measure under forced error (daemon wire stays healthy).
3. **reconnect** — real daemon kill → offline / stale samples → restart + vite rebind → recovered; measure each phase.

The current UI is the **placeholder shell** only. Measurements are honest about what paints today (scaffold status `—`); later screen tickets reuse the same harness and append ledger demos.

## Staging daemon state

```js
import { openVerifySession } from "./lib/session.mjs";
import { listScripts } from "./scripts/library.mjs";

const session = await openVerifySession();
const { taskId } = await session.daemon.stageScript("awaiting-answer");
const task = await session.daemon.waitTask(taskId);
// task.state === "awaiting_answer"
await session.close();
```

Named scripts in `scripts/library.mjs`:

| Name | Stages |
| --- | --- |
| `report-success` | completed + report |
| `report-with-churn` | completed + files_changed paths |
| `awaiting-answer` | blocks on `ask_orchestrator` |
| `vendor-failure` | fatal → failed |
| `long-running` / `stall` | long sleep (running / stall paths) |
| `exit-no-report` | exit 0 without report |
| `fan-out-leaf` | completed leaf-shaped report |

## Honesty forcing

| Goal | Mechanism |
| --- | --- |
| Per-panel error / empty / delay | `lib/honesty.mjs` — `page.route` on daemon API paths |
| Offline → stale → reconnect | `daemon.kill()` / `daemon.restart()` — **real server lifecycle, in-process** (`startServer` + `server.close()`, same process; no child pid). Socket-level offline is real (proxied `/health` → 502). |

No UI test hooks.

## A11y

- `runAxe(page)` — `@axe-core/playwright`
- `ariaSnapshot(page)` — Playwright `locator.ariaSnapshot()` YAML tree (not a DOM walk; `page.accessibility` is undefined on playwright-core 1.62)
- `keyboardWalk(page)` — counts focusables; if zero, records `focusableCount: 0` + placeholder note; if focusables exist, Tabs/Enters and **fails** when focus never leaves `body`
- `collectA11y(page)` — all three for a ledger demo entry

## Viewports

Board widths from DESIGN.md / PRODUCT.md: **1280 / 1460 / 1920** (height 900 in the harness). Every visual claim must include measured rects + computed styles at all three.
