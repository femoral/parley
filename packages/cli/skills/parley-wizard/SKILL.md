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
4. **Layers: project, global, daemon.** Project files live under `.parley/` in the repo. Shared project-settings (eval, resume, retry, optional taskTypes) may also live in the global home layer (`~/.parley/parley.json` and/or `~/.parley/config.json`); project overrides global per key. Daemon-only keys (`retention.days`, `daemon.url`, vendors, profiles, `defaults.vendor` / `defaults.profile`) go through `parley config` — same surface for local and remote daemons. Effective resolution: shipped defaults < global home < project.
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
ls "${PARLEY_HOME:-$HOME/.parley}/parley.json" "${PARLEY_HOME:-$HOME/.parley}/config.json" 2>/dev/null
parley config show --json 2>/dev/null
parley models --json 2>/dev/null
command -v codex grok claude gemini opencode goose pi cline kilo openhands hermes openclaw kimi 2>/dev/null
```

Summarize what is already configured vs still at shipped defaults — including whether a **global home config** is present. Done when you know the baseline you will edit from.

### 0b. Settings scope

On full interview, decide where shared settings will be written **before** the value stages.

**Global home config** means either of:

- `~/.parley/parley.json` (daemon home; also holds vendors, profiles, retention, defaults)
- `~/.parley/config.json` (optional global project-settings layer; same schema as project `.parley/config.json`)

Use `$PARLEY_HOME` when set instead of `~/.parley`.

| Home state | What to do |
| --- | --- |
| **Either global file exists** | Skip the scope question. Default to **project** scope for this run. Tell the user what you found (e.g. "Detected `~/.parley/parley.json` — configuring this project under `.parley/` only; leaving global as-is unless you ask to change it."). |
| **Neither global file exists** (fresh home) | Ask whether to set up **project settings only**, **global settings**, or **both**. |

Scope outcomes (fresh home only):

| Choice | Write shared defaults (eval, resume, retry, `defaults.vendor` / `defaults.profile`) | Write project-owned (taskTypes when repo-local, classification, rubrics) |
| --- | --- | --- |
| **Project only** | `.parley/config.json` (defaults.* still via `parley config` if set) | `.parley/` as today |
| **Global only** | Global layer (see below) | Only if the user still wants repo-local types/guidance/rubrics; otherwise omit project files |
| **Both** | Global layer | `.parley/` for project-specific keys and any intentional project overrides |

**Global layer writes** (when scope is global or both):

- Prefer `parley config set` for keys it supports: `eval.enabled`, `resume.enabled`, `retry.max`, `retry.window`, `defaults.vendor`, `defaults.profile` → daemon home `parley.json`.
- Optional: `~/.parley/config.json` for the same project-settings schema as the project file. Prefer **one** home surface per key — do not duplicate the same key in both `parley.json` and home `config.json`.

Daemon-only stages (retention, remote daemon, vendors/profiles) always use `parley config` regardless of scope; they are not project files.

Done when scope is fixed (asked, or defaulted because global already exists).

### 1. Evaluation on/off

Default is **OFF**. Ask whether structured evaluation of completed tasks should be required (word as "this project" when scope is project-only; as a shared default when scope includes global).

**Cost warning (always state when enabling):** turning eval on means every reviewed task needs `parley eval … --answers` (and session provenance when eval is on). That is orchestrator token cost and process overhead — not free. Prefer OFF unless the user wants metrics and scored rubrics.

Write according to [settings scope](#0b-settings-scope):

```json
{ "eval": { "enabled": false } }
```

- Project (or project side of both) → `.parley/config.json`
- Global (or global side of both) → `parley config set eval.enabled false` (or home `config.json`)

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

Shared settings (respect [settings scope](#0b-settings-scope); merge with eval/taskTypes on the same layer):

| Key | Default | Meaning |
| --- | --- | --- |
| `resume.enabled` | `true` | `parley fix` resumes the parent vendor session |
| `retry.max` | `1` | Max *resumed* fixes per attempt chain |
| `retry.window` | `"30m"` | Freshness window for resume (`30m`, `90s`, bare ms) |

Confirm each; only write keys that differ from what is already effective.

- Project scope → `.parley/config.json`
- Global / both (global side) → `parley config set resume.enabled|retry.max|retry.window …` (or home `config.json`)

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

When scope includes **global** (or the user wants a home-wide fallback), also offer delegate defaults:

```
parley config set defaults.vendor <id>
parley config set defaults.profile <name>
```

(`defaults.profile` wins over `defaults.vendor` when both are set; CLI flags always win.)

Catalog (advisory, hand-editable): `parley models` / `parley models --refresh`. Profiles beat ad-hoc flags for metrics.

Done when the user confirms the vendor set and any profiles (and defaults, if asked).

### 9. Write

Apply only approved diffs, honoring [settings scope](#0b-settings-scope).

**Project layer** (project-only, or project side of both) — typical `.parley/config.json`:

```json
{
  "eval": { "enabled": false },
  "resume": { "enabled": true },
  "retry": { "max": 1, "window": "30m" },
  "taskTypes": { "coding": { "rubric": "coding" } }
}
```

When scope is **global only** or **both**, put eval/resume/retry (and `defaults.vendor` / `defaults.profile`) on the **global layer** instead of duplicating them in the project file unless the user wants a project override. Example global writes:

```
parley config set eval.enabled false
parley config set resume.enabled true
parley config set retry.max 1
parley config set retry.window 30m
parley config set defaults.vendor <id>
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

Load current state (stage 0). Skip the full-interview scope question unless the user is doing a from-scratch init: keep writing on the layer that already owns the setting (or project when ambiguous). Change only what the intent needs, show diffs, write, then [After writes](#after-writes).

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
| eval, resume, retry, taskTypes (project override) | `.parley/config.json` |
| eval, resume, retry, taskTypes (global defaults) | `parley config` → `~/.parley/parley.json` and/or `~/.parley/config.json` |
| size/difficulty guidance | `.parley/classification.json` |
| custom/edited rubrics | `.parley/rubrics/<id>.json` |
| retention, daemon.url, vendors, profiles, defaults.vendor/profile | `parley config` (daemon home) |
| model catalog | `parley models` → `~/.parley/models.json` |
| validate project files | `parley lint` |

Resolution order for project-settings keys: shipped defaults < global home < project. Missing project files mean that layer is empty — still valid. `other` is always a valid `--type`; it is not listed in `taskTypes`.

Orchestrator loop after setup: install `parley-delegate` (`parley skills install`) and use that skill for delegate → watch → review.
