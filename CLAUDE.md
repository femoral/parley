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
