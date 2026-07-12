# Parley bug report template

File with:

```
gh issue create --repo femoral/parley --label needs-triage --title "bug: <one-line symptom>" --body "<template below>"
```

Fill every section; write "n/a" rather than deleting one. Never include credentials, API keys, or absolute paths that reveal local file structure (`~/...` is fine).

```markdown
## Symptom

<what happened vs what you expected, one paragraph>

## Reproduction

<the exact parley command(s), with the prompt trimmed to what matters>

## Task evidence

- `error` field (`parley status <task> --json`): `<verbatim>`
- `diag.log` lines (from the task's `logs_dir`), if any:
  ```
  <verbatim PARLEY-DIAG lines>
  ```

## Environment

- parley: <commit/version>
- vendor + version: <e.g. codex-cli 0.144.0 / grok 0.2.93>
- model / effort: <as delegated>
- sandbox posture: <default | read-only | full | --no-network>

## Notes

<anything else: worktree vs --cwd, resume involved, parallel tasks running, …>
```
