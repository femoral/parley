---
name: parley-wizard
description: Guided parley setup — detect installed agent CLIs, write ~/.parley/parley.json (vendors, profiles, daemon), start the daemon, install orchestrator skills, and verify with a smoke delegation. Use when the user wants to set up parley, configure vendors or profiles, or fix a broken install.
---

# Setting up parley

You are walking a user from "parley is installed" to "a delegation round-trips".
Work through the stages in order; each has a verifiable exit condition. Ask
before writing anything to their home directory, and show every file you are
about to write.

## 1. Detect what's on the machine

Probe for harness CLIs on PATH and report a table of what's usable:

```
for bin in codex grok claude gemini opencode goose pi cline kilo openhands hermes openclaw; do
  command -v "$bin" >/dev/null && echo "$bin: $($bin --version 2>/dev/null | head -1)"
done
```

Cross-check auth: each vendor needs its API key env or logged-in state
(e.g. `CODEX_API_KEY`, `XAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` —
the full per-vendor list is in each `docs/research/<vendor>-cli-automation.md`).
Tell the user which detected vendors are ready vs missing credentials. Done
when the user confirms the vendor set to configure.

## 2. Write settings

Config lives at `~/.parley/parley.json` (see ADR-0010). Build it with the
user, starting minimal — defaults are good; only write keys that deviate:

```json
{
  "vendors": {
    "<id>": { "bin": "<override>", "args": ["--extra"], "env": {"KEY": "VAL"} }
  },
  "profiles": {
    "heavy": { "vendor": "grok", "model": "grok-4.5", "effort": "high" },
    "cheap": { "vendor": "codex", "model": "<fast-model>", "effort": "low" }
  }
}
```

- **Profiles** are the main win: one per real use-case (heavy design work,
  mechanical edits, review). `parley delegate --profile heavy …` then replaces
  vendor/model/effort flags, and metrics slice by profile.
- **Third-party adapters**: `vendors.<id>.plugin` names a module implementing
  the contract in `docs/agents/adapter-authoring.md`.
- **Remote daemon**: only when the daemon runs elsewhere, set
  `daemon.url` — the CLI then never auto-spawns locally.

Validate by round-tripping: `parley models` (or any command) must not report
a config error. Done when the file parses and the user approves its content.

## 3. Start the daemon and install skills

- `parley daemon status` — auto-spawn happens on first use; `parley daemon
  start` if they want it explicit.
- `parley skills install` — interactive picker; choose the orchestrator
  skill(s) and the layout(s) their harness reads (`~/.claude/skills`,
  `~/.agents/skills`, project dirs). The orchestrating harness needs
  `parley-delegate`; add `parley-rubric` if they want evaluation (it sets up
  task classification + scoring — run its interview separately).
- Wire a session id: the orchestrating harness should export
  `PARLEY_SESSION_ID` per session (see the delegate skill's sessions notes).

## 4. Smoke delegation

Round-trip one trivial task against a scratch repo (never their real work):

```
cd "$(mktemp -d)" && git init -q && git commit -q --allow-empty -m init
parley delegate -v <vendor> -n smoke --session wizard-smoke "Reply via submit_report with outcome success and a one-line summary. Change no files."
parley watch --json --session wizard-smoke
```

Exit 6 with a `success` report proves: daemon up, adapter spawns, MCP hub
round-trips, report validates. Then `parley clean smoke` and ack per the
delegate skill's loop. If it fails, triage via the task's `error` field and
`diag.log` (see the troubleshooting doc) before changing config.

Done when the smoke task completes with a valid report and the user knows the
three commands they'll actually live in: `delegate`, `watch`, `answer`.
