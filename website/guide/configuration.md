# Configuration and profiles

Parley works with almost no configuration: install, `parley init`, delegate.
Everything below is optional and validated loudly when present.

## Where configuration lives

| Layer | Path | Scope |
| ----- | ---- | ----- |
| Global | `~/.parley/parley.json` | every repo on the machine |
| Project | `.parley/` in the repo | this repo: workflows, task types, rubrics, classification |

`parley config` reads and writes the effective daemon config over HTTP:

```bash
parley config show
parley config get profiles.heavy.vendor
parley config set defaults.vendor codex
parley config pull backup.json     # snapshot
parley config push backup.json    # validate, then replace wholesale
```

`parley info` renders the effective project configuration as prose meant for
the orchestrator: instructions, vendors and profiles, task types,
classification, eval and retry policy. `parley lint` validates every project
surface (config, classification, rubrics, workflows) and exits non-zero on
error, which makes it CI-friendly.

## Vendors

```json
{
  "vendors": {
    "grok":  { "env": { "XAI_API_KEY": "your-key-here" } },
    "mycli": { "plugin": "parley-adapter-mycli" }
  }
}
```

Per-vendor `bin`, `args`, and `env` apply to every spawn of that vendor.
Explicit delegate flags always win. `plugin` loads a
[custom adapter](/reference/adapter-authoring).

## Model allowlists

`vendors.<id>.models` is **deny-by-default**: a vendor with no allowlist
cannot be delegated to at all. Each entry names the allowed efforts and
optionally marks the default combo:

```json
{
  "vendors": {
    "codex": {
      "models": {
        "gpt-5.6-sol": { "efforts": ["low", "medium", "high"], "default": "medium" }
      }
    }
  }
}
```

`parley init` fills this in interactively; later, use `/parley-wizard` or:

```bash
parley models                       # show the daemon-wide allowlist
parley models set codex.gpt-5.6-sol '{"efforts":["low","high"],"default":"low"}'
parley models refresh               # re-fingerprint host catalogs (fleet-wide)
```

One allowlist, enforced by the daemon, for every client and every runner.

## Profiles

Profiles are named launch templates:

```json
{
  "profiles": {
    "heavy": { "vendor": "grok",  "model": "grok-4.5", "effort": "high" },
    "cheap": { "vendor": "codex", "effort": "low" }
  }
}
```

`parley delegate --profile heavy ...` replaces the vendor, model, and effort
flags in one word. The profile name is recorded on the task, so
`parley metrics --group-by profile` can compare templates head-to-head.
Profiles may also set `sandbox`, `network`, `args`, and `env`.

## Prompt layers

`parley prompt` previews the exact composed prompt a child would receive from
the current directory: the protocol preamble plus any `PROMPT.md` layers.
`parley prompt --orchestrator` shows the compounded orchestrator `PROMPT.md`
instead (which is never injected into children). Useful when a child seems to
be getting instructions you did not expect.

## Remote daemon

By default the daemon is loopback-only and tokenless. To drive a daemon on
another host, point the client at it:

```json
{
  "daemon": { "url": "http://build-box:7777", "client": "laptop", "token": "a-long-random-secret" }
}
```

The daemon host must register that client name and token. Bearer auth is
mandatory for every non-loopback peer, and config writes are refused
off-loopback regardless of token. The full posture, including runner tokens,
lives in [Remote runners](/guide/remote-runners).
