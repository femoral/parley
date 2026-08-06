# Getting started

Three moves: initialize the repo, open the cockpit, and hand the keys to your
agent. You will not be typing delegation commands yourself; that is the
agent's surface.

## 1. Initialize your repo

```bash
cd your-repo
parley init
```

One command does the setup:

- installs the **orchestrator skills** into your harness layout
  (`--layout claude|agents|<path>`, default `agents`),
- detects which vendor CLIs are on your PATH,
- refreshes the model catalog for each detected vendor,
- walks you through an opt-in picker: which vendors to allow, which models,
  which reasoning efforts, and the defaults,
- seeds example workflows under `.parley/workflows/` (project scope).

Everything is skippable; submit an empty selection to move on. Re-run it any
time, it never overwrites your workflow files.

::: tip Model allowlists are deny-by-default
A vendor with no allowed models cannot be delegated to. If you skip the picker
now, `/parley-wizard` or `parley models set` can fill it in later.
:::

Two skills are installed:

| Skill | Purpose |
| ----- | ------- |
| `parley-delegate` | the orchestrator loop: brief, delegate, watch, answer, review |
| `parley-wizard` | conversational setup: profiles, task types, eval rubrics, project config |

Both ship with automatic invocation disabled: they load only when you call
them explicitly (`/parley-delegate`, `/parley-wizard`), since that is how they
are used most of the time. To let the model trigger them on its own, remove
`disable-model-invocation: true` from the skill's frontmatter.

## 2. Open the cockpit

```bash
parley ui
```

If [the Console](/guide/console) is installed this opens the fleet board in
your browser. Keep it on a second screen; it is the easiest way to follow a
fan-out without interrupting your agent.

## 3. Hand the keys to your agent

In your harness session, invoke the skill and describe the work:

```text
/parley-delegate

Split the API error-handling refactor into independent tasks and farm them
out. Use codex for the mechanical parts and grok for the tricky retry logic.
Review every branch before you merge anything, and ask me before touching
the public API surface.
```

From there the agent runs the loop on its own:

1. registers its session (`parley session`) so events route back to it,
2. writes one brief per task and delegates each into an isolated worktree,
3. blocks on `parley watch`, answering child questions as they come up,
4. reviews each finished branch, merges what holds up, and opens
   `parley fix` reattempts for what does not.

You stay at the level you care about: answering the occasional design
question the agent escalates, and judging the final diffs.

::: tip Want the gory details?
[How the orchestrator works](/explainer/how-the-orchestrator-works) walks
through the exact commands and events, and the
[CLI reference](/reference/cli) covers every flag.
:::

## 4. Review what came back

Every task ends as a branch, never a merge:

```bash
git branch --list 'parley/*'
git diff main..parley/t1-fix-flaky
```

Merge what you like, delete what you do not. `parley clean <task>` removes a
finished task's worktree and keeps the branch.

## Where to go next

- [The Console](/guide/console): the cockpit in depth.
- [Vendors and sandboxing](/guide/vendors): who can be on the crew and how
  contained they are.
- [Configuration and profiles](/guide/configuration): defaults, allowlists,
  and reusable launch templates.
