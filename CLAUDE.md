# parley

## Agent skills

### Issue tracker

Issues live in GitHub Issues (`gh` CLI); external PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at repo root. See `docs/agents/domain.md`.

### Troubleshooting a failed parley task

Check the task's `error` field, then `diag.log`, before reading raw vendor
logs. See `docs/agents/troubleshooting.md`.

## Design Context

The web cockpit (`packages/ui`, "Parley Cove") has captured design context for
agents doing UI work:

- `packages/ui/PRODUCT.md` — strategic: register (product), users, positioning
  ("agent work you want to watch"), personality, anti-references, principles.
- `packages/ui/DESIGN.md` — visual system (tokens, typography, components).
- `docs/design/design-manifest.md` — the source design export the UI implements.
