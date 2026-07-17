---
name: parley-wizard
description: Configure a parley project by interview — full init (eval, types, rubrics, classification, retention, resume/retries, remote daemon, vendors) or targeted reconfig. Use when the user wants to set up parley, run /parley-wizard, reconfigure .parley, turn eval on/off, edit task types or rubrics, or fix project config.
---

# Configuring parley

Walk the user to a correct project setup through conversation. Two branches:

| Invocation | Path |
| --- | --- |
| `/parley-wizard`, `init`, or "set up parley" | **Full interview** — every area below, in order |
| `/parley-wizard {intent}` (e.g. "turn eval on", "add a type", "change retention") | **Targeted reconfig** — only that intent's steps, then lint + verification offer |

**Ground rules (every run):**

1. **Start from what exists.** Load current project and daemon settings first. Never factory-reset; never wipe files the user didn't ask to change.
2. **Accepting everything is a no-op.** If the user keeps every current value (or every shipped default when nothing is written yet), write nothing.
3. **Show before write.** Diff or full content of every file you are about to create or change; wait for approval.
4. **Project vs daemon.** Project lives under `.parley/` in the repo. Daemon-home settings (`retention.days`, `daemon.url`, vendors, profiles) go through `parley config` — same surface for local and remote daemons.
5. **Finish with lint, then offer a dry run.** See [After writes](#after-writes).

---

## Full interview (`init`)

Work the stages in order. Each stage ends when the user confirms the value (or accepts the current/default). Rubric editing is skippable wholesale; every other stage still needs an explicit accept.

### 0. Load current state

From the project root:

```
ls -la .parley/ .parley/rubrics/ 2>/dev/null
cat .parley/config.json 2>/dev/null
cat .parley/classification.json 2>/dev/null
parley config show --json 2>/dev/null
parley models --json 2>/dev/null
command -v codex grok claude gemini opencode goose pi cline kilo openhands hermes openclaw kimi 2>/dev/null
```

Summarize what is already configured vs still at shipped defaults. Done when you know the baseline you will edit from.

### 1. Evaluation on/off

Default is **OFF**. Ask whether this project should require structured evaluation of completed tasks.

**Cost warning (always state when enabling):** turning eval on means every reviewed task needs `parley eval … --answers` (and session provenance when eval is on). That is orchestrator token cost and process overhead — not free. Prefer OFF unless the user wants metrics and scored rubrics.

Write under `.parley/config.json`:

```json
{ "eval": { "enabled": false } }
```

Done when the user confirms on or off.

### 2. Task types

Shipped set (8 + automatic fallback `other`, which is always valid and never listed):  
`coding`, `design`, `research`, `infrastructure`, `writing`, `data`, `review`, `planning`.

Negotiate keep / trim / add / override. Each configured type maps to a rubric id:

```json
{
  "taskTypes": {
    "coding": { "rubric": "coding" },
    "my-type": { "rubric": "generic" }
  }
}
```

- Shorthand `"coding": "coding"` is also valid.
- **Custom types default to the `generic` rubric** unless the user picks or authors another.
- Omitting `taskTypes` entirely means shipped defaults — prefer omit when the user wants the full shipped set unchanged.

Done when the effective type set is confirmed.

### 3. Rubrics (skippable wholesale)

Ask once: "Edit any rubrics now, or keep shipped/generic defaults?" If skip → leave `.parley/rubrics/` alone and continue.

If editing:

- Shape: `{ "id", "version", "criteria": [{ "id", "kind": "positive"|"negative", "weight": <positive int>, "text" }] }`.
- One file per rubric: `.parley/rubrics/<id>.json` (`id` must match the filename stem).
- **Bump `version` on every criteria edit** (integer; lint warns if criteria diverge from a shipped rubric at the same version).
- Shipped rubrics resolve without project files; only write a file when customizing or adding. Materialize from an existing project file when present; otherwise author the full document from the interview.
- Custom types without their own file keep resolving to `generic`.

Done when the user accepts the rubric set (or explicitly skipped).

### 4. Classification guidance

Sizes and difficulties are project-owned how-to-classify lines in `.parley/classification.json`. Shipped ids:

- sizes: `XS` `S` `M` `L` `XL`
- difficulties: `trivial` `easy` `medium` `hard` `extreme`

```json
{
  "version": 1,
  "sizes": [{ "id": "M", "guidance": "…" }],
  "difficulties": [{ "id": "hard", "guidance": "…" }]
}
```

Walk guidance only where the user wants project-specific wording; omit the file entirely when shipped guidance is fine. Bump `version` when changing guidance. Every entry needs non-empty `guidance`.

Done when the user accepts guidance (or shipped defaults).

### 5. Retention

Daemon-side only: how long terminal task data is kept before `parley gc` may purge it (rows, logs, worktrees — never branches). Default **30** days.

```
parley config set retention.days 30
```

Done when the user confirms the number of days.

### 6. Resume and retries

Project `.parley/config.json` (merge with eval/taskTypes):

| Key | Default | Meaning |
| --- | --- | --- |
| `resume.enabled` | `true` | `parley fix` resumes the parent vendor session |
| `retry.max` | `1` | Max *resumed* fixes per attempt chain |
| `retry.window` | `"30m"` | Freshness window for resume (`30m`, `90s`, bare ms) |

Confirm each; only write keys that differ from what is already effective.

Done when resume/retry policy is confirmed.

### 7. Remote daemon

Only when the daemon runs elsewhere (or the user asks). Otherwise leave unset so the CLI auto-spawns locally.

```
parley config set daemon.url "http://host:port"
```

Unset with `parley config unset daemon.url` when returning to local. Done when local-vs-remote is confirmed.

### 8. Vendors and models

Probe PATH (stage 0). For each vendor the user wants:

- Confirm the CLI is installed and credentials exist (vendor-specific env / login).
- Optional overrides: `parley config set vendors.<id>.bin|args|env|plugin …`
- Named profiles for real use-cases:  
  `parley config set profiles.<name>.vendor <id>` (+ `.model`, `.effort` as needed).

Catalog (advisory, hand-editable): `parley models` / `parley models --refresh`. Profiles beat ad-hoc flags for metrics.

Done when the user confirms the vendor set and any profiles.

### 9. Write

Apply only approved diffs. Typical project merge for `.parley/config.json`:

```json
{
  "eval": { "enabled": false },
  "resume": { "enabled": true },
  "retry": { "max": 1, "window": "30m" },
  "taskTypes": { "coding": { "rubric": "coding" } }
}
```

Write classification and rubric files only when those stages changed them. Do not create empty stub files.

Done when disk matches the approved plan (or no writes were needed).

Then go to [After writes](#after-writes).

---

## Targeted reconfig (`{intent}`)

Map the intent to the smallest set of stages above:

| Intent examples | Stages |
| --- | --- |
| turn eval on/off | 1 |
| add/trim/rename types | 2, maybe 3 for new custom types |
| edit a rubric | 3 (bump version) |
| change size/difficulty wording | 4 |
| retention | 5 |
| fix/retry policy | 6 |
| point at a remote daemon | 7 |
| vendors / profiles / models | 8 |

Load current state (stage 0), change only what the intent needs, show diffs, write, then [After writes](#after-writes).

---

## After writes

### Lint

```
parley lint
```

Must exit 0. Fix every error with the user before offering a dry run. Warnings (e.g. rubric version-bump reminders) are callouts — address or consciously keep.

### Dry-run offer (token-cost warning)

**Before launching anything**, warn explicitly:

> A dry run still spawns a real vendor child and **consumes tokens**. It records no task row (`--dry-run`), but it is not free. Proceed only if you accept that cost.

Only after the user consents:

```
parley delegate -v <vendor> -n wizard-dry --session wizard-dry --dry-run \
  "Reply via submit_report with outcome success and a one-line summary. Change no files."
```

Use a profile instead of `-v` when they configured one. Prefer a throwaway session id. Optionally `parley watch --json --session wizard-dry` if they want to see completion — still costs tokens while the child runs.

Skip the dry run entirely when the user declines. Done when lint is clean and the dry-run choice is resolved.

---

## Surfaces (where things live)

| Concern | Surface |
| --- | --- |
| eval, taskTypes, resume, retry | `.parley/config.json` |
| size/difficulty guidance | `.parley/classification.json` |
| custom/edited rubrics | `.parley/rubrics/<id>.json` |
| retention, daemon.url, vendors, profiles | `parley config` (daemon home) |
| model catalog | `parley models` → `~/.parley/models.json` |
| validate project files | `parley lint` |

Missing project files mean shipped defaults — that is valid. `other` is always a valid `--type`; it is not listed in `taskTypes`.

Orchestrator loop after setup: install `parley-delegate` (`parley skills install`) and use that skill for delegate → watch → review.
