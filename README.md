# parley

**Delegate coding tasks to agent CLIs — any of them — and stay in command.**

Parley runs child coding agents (Codex, Claude Code, Grok, Gemini, OpenCode,
Goose, and more) in isolated git worktrees, coordinated by one local daemon.
You — or the agent driving you — write the brief, answer questions, review the
branch, and record how well it went. Parley never merges; judgment stays with
the orchestrator.

```
┌─────────────┐   delegate / watch / answer   ┌────────┐   spawn-per-turn   ┌─────────────┐
│ orchestrator │ ────────────────────────────▶ │ daemon │ ─────────────────▶ │ child agent │
│ (you / an    │ ◀──────────────────────────── │ sqlite │ ◀───────────────── │ in its own  │
│  agent CLI)  │      attention inbox          │  state │   MCP · HTTP · CLI │  worktree   │
└─────────────┘                               └────────┘                    └─────────────┘
```

## Why

- **Fan-out**: ten briefs, ten worktrees, ten agents in parallel — no
  stepping on each other, every branch reviewable on its own.
- **One wait primitive**: `parley watch` delivers exactly the events that
  need you (question, stall, failure, completion), priority-ordered, with
  at-least-once redelivery until you ack. No polling loops.
- **Vendor-agnostic**: one interface over 12 harnesses, plus a public plugin
  contract for your own.
- **Accountable**: every task records tokens (input/output/cached), duration,
  profile, size/difficulty classification, and your evaluation — sliceable by
  vendor, model, or profile with `parley metrics`.

## Install

```bash
npm install -g @useparley/cli        # the CLI (daemon auto-spawns on first use)
npm install -g @useparley/ui        # optional: the web cockpit (parley ui)
```

Requires Node ≥ 24 and git. Each vendor CLI you delegate to must be installed
and authenticated on the machine that runs it.

## Quickstart

```bash
cd your-repo

# 1. Delegate (returns immediately with a pending task)
parley delegate -v codex -n fix-flaky --session s1 \
  "Fix the flaky retry test in packages/api. Done when 'pnpm test' is green."

# 2. Wait — the only wait primitive. Exit codes tell you what happened:
parley watch --json --session s1
#   3 = child asked a question  → parley answer <task> "…"
#   4 = stalled                 → parley answer resumes it
#   5 = failed                  → triage, then watch --ack <seq>
#   6 = completed               → review the branch, merge if it holds up,
#                                 then watch --ack <seq>
#   0 = all done, inbox empty

# 3. Review & integrate — the branch is yours to judge
git diff main..parley/t1-fix-flaky
parley eval t1 --score 9 --feedback "clean fix, good test"
parley clean t1        # removes the worktree, keeps the branch
```

Orchestrating from an agent harness? `parley skills install` ships the
orchestrator skills (`parley-delegate`, `parley-wizard`, `parley-rubric`)
into your harness's skills directory.

## Vendors

| Vendor | CLI | Notes |
| ------ | --- | ----- |
| `codex` | OpenAI Codex CLI | flags-only injection, rich usage |
| `grok` | Grok Build | config-file injection, custom sandbox profiles |
| `claude` | Claude Code | stream-json + strict MCP isolation |
| `gemini` | Gemini CLI | project settings injection |
| `opencode` | OpenCode | hermetic `OPENCODE_CONFIG_CONTENT` |
| `goose` | Goose | hermetic `GOOSE_PATH_ROOT`, name-based resume fallback |
| `pi` | Pi coding agent | MCP via `pi-mcp-adapter` |
| `cline` | Cline CLI | private data-dir isolation |
| `kilo` | Kilo CLI | `KILO_CONFIG_CONTENT` injection |
| `openhands` | OpenHands | env-isolated persistence dirs |
| `hermes` | Hermes Agent | quiet-mode text surface, private `HERMES_HOME` |
| `openclaw` | OpenClaw | session-key resume, state-dir isolation |

Every adapter is written against a pinned, live-verified research doc in
[`docs/research/`](docs/research/) and normalizes the same posture surface:
`--sandbox read-only|workspace|full` and `--no-network` (ADR-0006). Model and
reasoning effort pass through opaquely (`-m`, `--effort`).

**Write your own**: adapters are a public contract in `@useparley/core`.
Point `vendors.<id>.plugin` at your module and the daemon loads it at startup
— see [docs/agents/adapter-authoring.md](docs/agents/adapter-authoring.md)
and ADR-0009.

## Settings & profiles

`~/.parley/parley.json` (all optional, validated loudly):

```json
{
  "daemon":  { "url": "http://build-box:7777" },
  "vendors": {
    "grok":   { "env": { "XAI_API_KEY": "…" } },
    "mycli":  { "plugin": "parley-adapter-mycli" }
  },
  "profiles": {
    "heavy": { "vendor": "grok",  "model": "grok-4.5", "effort": "high" },
    "cheap": { "vendor": "codex", "effort": "low", "args": ["--foo"] }
  },
  "runners": { "gpu-box": { "token": "…" } }
}
```

`parley delegate --profile heavy …` replaces the vendor/model/effort flags;
the profile is recorded on the task, so metrics can compare profiles
head-to-head. Vendor `bin`/`args`/`env` apply to every spawn of that vendor;
explicit flags always win. (ADR-0010)

## How children talk back

Three transports, one contract (`submit_report`, `ask_orchestrator`):

- **MCP** — injected per-vendor; the default.
- **HTTP** — `curl`-able: `POST /child/report`, `POST /child/ask` (long-poll),
  `GET /child/task`, correlated by the `x-parley-task` header. Every child
  gets `PARLEY_HUB_URL` / `PARLEY_TASK_ID` in env and `.parley/child.json`
  in its workspace.
- **CLI** — `parley child report|ask|task` wraps the HTTP surface for shell
  scripts and MCP-less harnesses. (ADR-0011)

## Remote runners

Run children on other machines while keeping one daemon and one inbox:
install `@useparley/runner` on the remote host, give it the daemon URL +
a token from `runners.<name>`, and delegate with `--runner <name>`. The
runner leases tasks, executes them with the same adapters and worktree
semantics, streams logs and heartbeats back, and pushes the finished branch
to your git remote for review. Outbound-only from the runner — no reach-in
credentials. (ADR-0012, [docs/agents/remote-runners.md](docs/agents/remote-runners.md))

## Metrics & evaluation

```bash
parley metrics --group-by profile        # tokens I/O/C, durations, evals
parley eval t42 --score 8 --feedback "…" # your judgment, recorded
parley delegate --size M --difficulty hard …   # classify at delegate time
```

The `parley-rubric` skill interviews you into a committed project rubric:
concrete T-shirt size and difficulty definitions plus binary, MECE success
gates — so classification and scoring stay consistent across orchestrators.
The web cockpit (`parley ui`) renders the same aggregates.

## The cockpit

`parley ui` opens **Parley Cove** — a live view of every task: state,
transcript tail, Q&A history, usage, and metrics. Optional install; the
daemon serves it when present.

## Skills

| Skill | Purpose |
| ----- | ------- |
| `parley-delegate` | the orchestrator loop: brief → delegate → watch → answer → review |
| `parley-wizard` | guided setup: detect CLIs, write settings, smoke-test |
| `parley-rubric` | define evaluation metrics and success rubrics |

`parley skills install` — interactive picker, or `--layout`/`--scope`/`--skill`
for CI.

## Design notes

The decision record lives in [`docs/adr/`](docs/adr/) — worth reading in
order if you want the why: spawn-per-turn adapters (0004), parley-owned
worktrees (0005), sandbox posture (0006), the attention inbox (0007/0008),
plugins (0009), settings/profiles (0010), child channels (0011), remote
runners (0012). Domain vocabulary: [`CONTEXT.md`](CONTEXT.md).

## Development

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm lint
node packages/cli/bin/parley.mjs --help
```

Issues are triaged with the labels in
[docs/agents/triage-labels.md](docs/agents/triage-labels.md); bug reports per
the template in the delegate skill. PRs welcome — adapters especially.
