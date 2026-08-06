# How children talk back

A child agent owes the daemon exactly two things: a final **report**
(`submit_report`) and, optionally, **questions** along the way
(`ask_orchestrator`). One contract, three transports; every adapter declares
which one its vendor gets taught in the protocol preamble.

## The three channels

| Channel | How | When it is used |
| ------- | --- | --------------- |
| **MCP** | injected per vendor, with an `x-parley-task` header | the default, for harnesses with a configurable MCP client |
| **HTTP** | plain `curl`-able endpoints on the daemon | harnesses that can fetch but have no MCP client |
| **CLI** | `parley child report\|ask\|task` | shell scripts and MCP-less harnesses |

All three converge on the same engine methods, so report validation and
question handling behave identically no matter the transport.

Every spawned child gets `PARLEY_HUB_URL` and `PARLEY_TASK_ID` in its
environment, plus `.parley/child.json` in its workspace for children that
lose env. The untaught transports keep working, which makes them a useful
escape hatch when a vendor's tool-calling misbehaves.

## HTTP surface

```bash
# Submit the final report (default schema shape)
curl -sS -X POST "$PARLEY_HUB_URL/child/report" \
  -H "content-type: application/json" \
  -H "x-parley-task: $PARLEY_TASK_ID" \
  -d '{"summary":"done","outcome":"success","files_changed":["src/a.ts"]}'

# Ask the orchestrator (long-polls until answered, or answer-timeout)
curl -sS -X POST "$PARLEY_HUB_URL/child/ask" \
  -H "content-type: application/json" \
  -H "x-parley-task: $PARLEY_TASK_ID" \
  -d '{"question":"which database should I use?"}'

# Self-inspection envelope
curl -sS "$PARLEY_HUB_URL/child/task" -H "x-parley-task: $PARLEY_TASK_ID"
```

## CLI surface

```bash
parley child report --summary "done" --outcome success --file src/a.ts
parley child report --json-file report.json   # custom report schemas
parley child ask "which database should I use?"
parley child task
```

The child commands resolve the hub URL and task id from env, or from
`.parley/child.json` walking up from the current directory.

## Reports are contracts

A task does not complete because the process exited; it completes when a
schema-valid report lands. `parley delegate --report-schema <file>` swaps in
a custom JSON Schema when the default shape (summary, outcome, files
changed) is not enough. A child that exits without reporting fails the task
with a diagnostic trail; see
[Troubleshooting](/reference/troubleshooting).

On [remote runners](/guide/remote-runners), children talk to a local hub
proxy that forwards these same channels to the daemon with the runner's
credentials, so a child never needs direct daemon reachability.
