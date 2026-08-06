# Remote runners

::: warning Experimental
Remote execution works end-to-end but has not been thoroughly tested yet.
Expect rough edges.
:::

Run children on other machines while keeping **one daemon and one inbox**.
The orchestrator surface does not change at all: delegate, watch, answer.
Remote-ness is either an automatic capability match or an explicit pin.

<div class="parley-diagram">
<svg viewBox="0 0 760 300" role="img" aria-label="Remote runner topology: runners dial out to the one daemon, lease tasks, execute with local vendor CLIs, and push finished branches to the git remote">
  <defs>
    <marker id="rarr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 1 L 9 5 L 0 9 z" fill="#2c343b" />
    </marker>
    <marker id="rarr-soft" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 1 L 9 5 L 0 9 z" fill="#43b98c" />
    </marker>
  </defs>

  <rect class="d-box-accent" x="20" y="110" width="170" height="90" rx="10" />
  <text class="d-label" x="105" y="148" text-anchor="middle">parley daemon</text>
  <text class="d-sub" x="105" y="168" text-anchor="middle">all state · one inbox</text>

  <rect class="d-box" x="300" y="30" width="160" height="72" rx="10" />
  <text class="d-label" x="380" y="60" text-anchor="middle">runner: gpu</text>
  <text class="d-sub" x="380" y="80" text-anchor="middle">codex · grok on host</text>

  <rect class="d-box" x="300" y="200" width="160" height="72" rx="10" />
  <text class="d-label" x="380" y="230" text-anchor="middle">runner: build-box</text>
  <text class="d-sub" x="380" y="250" text-anchor="middle">warm mirror held</text>

  <rect class="d-box" x="570" y="110" width="170" height="90" rx="10" />
  <text class="d-label" x="655" y="148" text-anchor="middle">git remote</text>
  <text class="d-sub" x="655" y="168" text-anchor="middle">origin</text>

  <path class="d-edge-soft" d="M 300 70 C 250 80 230 110 194 126" marker-end="url(#rarr-soft)" />
  <text class="d-edge-label" x="222" y="76" text-anchor="middle">register · lease</text>
  <text class="d-edge-label" x="222" y="90" text-anchor="middle">outbound only</text>

  <path class="d-edge-soft" d="M 300 240 C 250 230 230 200 194 184" marker-end="url(#rarr-soft)" />
  <text class="d-edge-label" x="226" y="236" text-anchor="middle">events · heartbeats</text>

  <path class="d-edge" d="M 460 70 C 510 80 530 110 566 126" marker-end="url(#rarr)" />
  <path class="d-edge" d="M 460 240 C 510 230 530 200 566 184" marker-end="url(#rarr)" />
  <text class="d-edge-label" x="530" y="80" text-anchor="middle">push branch</text>
  <text class="d-edge-label" x="530" y="232" text-anchor="middle">fetch · push</text>
</svg>
</div>

The firewall model is strict: the daemon holds **no credentials to any
host**. A runner needs exactly one outbound URL and a token, so it works
through NAT. Finished branches come back through your git remote, not through
the daemon.

## Set up the daemon host

In `~/.parley/parley.json` on the daemon host:

```json
{
  "runners": { "gpu": { "token": "generate-a-long-random-secret" } },
  "clients": { "laptop": { "token": "generate-another-long-random-secret" } },
  "daemon": { "bind": "0.0.0.0" }
}
```

- `runners.<name>.token`: bearer token per runner (the name `local` is
  reserved).
- `clients.<name>.token`: bearer token for a remote CLI or UI principal.
- `daemon.bind`: default is loopback-only; bind wider to accept the fleet.

Bearer auth is mandatory for every non-loopback peer, and config writes are
refused off-loopback regardless of token. Parley speaks plain HTTP: put it on
a private overlay network (Tailscale, WireGuard, LAN), or behind a
TLS-terminating reverse proxy for public exposure.

## Set up the runner host

```bash
npm install -g @useparley/runner
```

`runner.json` (or flags, or env):

```json
{
  "daemonUrl": "https://parley.example.com",
  "name": "gpu",
  "token": "generate-a-long-random-secret"
}
```

```bash
parley-runner --config ./runner.json
```

On start the runner fingerprints its host (vendor CLIs, model catalogs, held
repo mirrors) and registers. Install and authenticate vendor CLIs on the
runner host exactly as you would locally; sandbox postures apply there too.

**The runner host needs push access to your git remote.** Repos sync through
parley-managed bare mirrors using the host's ambient git credentials (SSH
agent, credential helper, deploy keys). Parley never ships tokens around. No
pre-provisioned clones are required.

## How work gets routed

```bash
parley delegate -v codex ...            # automatic placement
parley delegate --runner gpu -v codex ... # hard pin
```

At delegate time the daemon picks placement once:

- Workspace-bound work (`--cwd`, run-owned steps, fixes of local parents) is
  always local.
- Otherwise online runners that advertise the vendor are preferred over the
  daemon, warmest clone first.
- `--runner <name>` pins; if that runner cannot take the task, the delegate
  fails with a diagnosis rather than silently running elsewhere.
- If capable executors exist but none is online, the task waits, up to a
  routing timeout (default one hour).

Before any vendor spawns, the runner fetches the mirror, verifies the base
commit, and preflight-pushes the task branch, so permission problems fail
fast and cheap. On completion it pushes the finished branch to `origin` and
reports the branch name. Review it like any other:

```bash
git fetch origin parley/t42-feature
git diff main..origin/parley/t42-feature
```

There is no local worktree for a remote task, so `parley clean` is a no-op;
logs and the report stay on the daemon (`parley logs`, `parley status`).

## Watching the fleet

```bash
parley runners list            # name, status, vendors, last-seen
parley runners show gpu        # models, held mirrors, reachability, recent tasks
parley runners remove gpu      # drop registration + config (loopback only)
parley clones list             # managed mirrors on the daemon host
parley clones prune            # remove mirrors no live task references
```

Lost runners fail their in-flight task loudly (phase, branch, last-event
age); claim-time git failures are categorized and that runner-repo pairing is
skipped until the runner re-registers.

For wire-level detail (lease protocol, endpoints, failure taxonomy), see
[docs/agents/remote-runners.md](https://github.com/femoral/parley/blob/develop/docs/agents/remote-runners.md)
in the repo.
