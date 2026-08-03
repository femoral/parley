# 302 — Prior art: capability advertisement and repo sync in CI runner systems

Research asset for [#302](https://github.com/femoral/parley/issues/302), part of the
distributed-execution wayfinder map ([#301](https://github.com/femoral/parley/issues/301)).
Surveys GitHub Actions self-hosted runners, GitLab Runner, Buildkite agents, and
Nomad clients, then distills the patterns relevant to parley's lease-based model.
Facts verified against official docs at research time (2026-08); unverifiable
details are flagged inline.

## Comparison

| | GitHub Actions | GitLab Runner | Buildkite | Nomad |
| --- | --- | --- | --- | --- |
| **Registration** | `config.sh` with short-lived (1 h) registration token; runner persists at repo/org/enterprise scope | Runner created server-side first, issues a long-lived runner auth token (`glrt-…`) used by `gitlab-runner register` | Long-lived per-cluster agent token → session token for the connection → per-job token | Client connects to servers; registration carries the fingerprint |
| **Capabilities** | Operator-declared **labels** (defaults: `self-hosted`, OS, arch); editable post-registration only via UI/API | Operator-declared **tags** + run-untagged / protected flags; editable via UI/API | Operator-declared **tags** (`queue` special, one per agent); no live refresh mechanism found | **Self-fingerprinted**: OS, CPU, memory, installed task drivers, devices; plus operator-declared `node_class`/`meta`/`node_pool`; drivers/devices re-fingerprint periodically |
| **Liveness** | The 50 s HTTPS long-poll connection *is* presence; auto-removal after 14 days offline (1 day ephemeral) | Short poll (`check_interval` 3 s); status tiers: online (<2 h), offline, stale (7 d+) | Heartbeats; **lost** after 3 min of misses; running job on a lost agent fails, reassigned ~4 min | Heartbeat TTL scaled to cluster size (~10–20 s); missed TTL → node `down`, allocations `lost` and **auto-migrated** |
| **No matching executor** | Job queues until a matching runner appears; fails after 24 h queued | Distinguishes cases: pending **with** matching runners dropped at 24 h, pending with **no** matching runner dropped at **1 h**; running-but-silent fails at 30 min | Job sits in `SCHEDULED` indefinitely (queue metrics surface it) | **Blocked evaluation** waits for capacity; `eval status` reports explicit per-dimension failed-placement reasons (missing driver, constraint, resources) |
| **Repo onto executor** | Runner-side (`actions/checkout` step); shallow fetch depth 1 by default into a reused workspace | Runner-side git step; `GIT_STRATEGY` fetch (cached workdir) / clone / none; default depth 20 | Agent-side checkout phase; **git-mirrors**: shared bare mirror + per-job `clone --reference`, lock-protected | Client-side `artifact` block (go-getter: git/http/s3) into the task dir |
| **Git credentials** | Platform-minted ephemeral `GITHUB_TOKEN` (per job, ≤24 h, permissions per workflow) | Platform-minted ephemeral `CI_JOB_TOKEN` (job lifetime; push only ≥17.2 behind a setting) | **Operator-provisioned** SSH keys on the agent host (or an SSH key in Buildkite Secrets) | Operator-provisioned (SSH keys, basic auth, cloud creds) |
| **Routing** | Pull: server assigns queued job to an online idle runner matching **all** `runs-on` labels (+ runner groups); tie-breaking undocumented | Pull: eligible polling runner gets a job whose tags are a **subset** of the runner's; FIFO per project/group, fair-usage for shared runners | Pull: agent polls its queue; first available agent whose tags satisfy all criteria; agents ordered by most-recent job completion | **Server-side placement**: feasibility filter (pool, drivers, constraints) then bin-packing rank; delivery still client-pull |

## Patterns for parley

**1. Registration is separate from work acquisition — everywhere.** No surveyed
system carries capabilities on the work-request itself. All four keep a
server-side capability record (labels/tags/fingerprint) established at
registration and refreshed out-of-band; the poll/lease call is thin (identity
only) and matching happens server-side against the stored record. An
enriched-lease-only design (capabilities repeated on each `POST /runner/lease`)
has no precedent — though sending capabilities *on connect* and treating the
lease long-poll as the presence signal (GitHub's model) is a lightweight middle
ground that fits parley's existing long-poll.

**2. Self-fingerprinting fits parley better than operator-declared tags.** The
label/tag camp makes the operator responsible for truthfulness (a mistagged
runner takes jobs it can't run). Nomad instead detects drivers on the host and
refreshes them — and routing filters on *detected* capability. Parley's vendors
are exactly as detectable as Nomad drivers (PATH probe of the vendor bin — the
logic already exists CLI-side as `detectHarnesses`), so the runner can
fingerprint its vendors itself and re-fingerprint periodically or on demand.
Operator-declared metadata (name, arbitrary tags) can ride alongside, as in
Nomad's `node_class`/`meta`.

**3. Never dispatch to an incapable executor; queue with a diagnosis.** All
four match before dispatch, so "unknown vendor on runner" post-lease failure
(parley today) has no precedent. When nothing matches, the mature systems
*queue and explain*: Nomad's failed-placement reasons are best-in-class;
GitLab's split timeouts are the pragmatic version — fail fast (1 h) when **no
registered executor even matches**, wait long (24 h) when a matching executor
is merely offline. Both distinguish "impossible" from "not right now", which is
the distinction parley's routing policy needs.

**4. Presence can be the connection itself, with tiered staleness.** GitHub
derives online/offline purely from the long-poll being open — no separate
heartbeat while idle. Parley's runner already long-polls for leases and
heartbeats while executing; an open lease poll doubling as presence would add
no new wire traffic. Status tiers (online / offline / stale) and auto-removal
of long-dead runners (GitHub 14 d, GitLab stale cleanup) keep the registry
honest.

**5. The executor always clones itself; mirror + per-job checkout is the
established shape.** In every system the server ships a *reference* (repo URL +
ref), never content; the executor fetches. Buildkite's git-mirrors — one shared
bare mirror per repo on the agent host, per-job checkouts referencing it,
lock-protected — is exactly the shared-clone-plus-worktrees shape parley
already has for the local daemon, and maps cleanly onto "runner keeps a managed
clone per origin URL, cuts parley worktrees from it". Shallow/limited fetch is
the default everywhere (depth 1 GH, 20 GitLab), with a strategy knob
(`GIT_STRATEGY`) for pristine-clone or no-checkout cases — but note shallow
fetch must still guarantee `base_sha` is resolvable (fetch the specific sha,
not just a depth).

**6. Credentials: parley is in the Buildkite/Nomad camp.** Ephemeral per-job
tokens (GH/GitLab) are only possible because the CI platform *is* the forge and
can mint scoped tokens. Buildkite and Nomad — third parties to the forge, like
parley — settle on operator-provisioned host credentials (SSH keys / git
credential helpers on the executor host), optionally distributed via a secrets
store. Prior art therefore supports keeping "the runner host must be able to
clone and push origin" as an explicit operator contract, with parley validating
early (e.g. `git ls-remote` at registration or clone time) rather than minting
credentials.

**7. Don't over-engineer tie-breaking.** Among multiple capable executors:
GitHub doesn't document an order, GitLab is FIFO/fair-usage, Buildkite prefers
the agent that most recently finished a job (warm caches), Nomad bin-packs.
Only Nomad — a general scheduler — does anything sophisticated. For parley's
scale, "any capable idle executor, prefer warm" (Buildkite) is the ceiling
worth considering.

## Sources

GitHub: [about self-hosted runners](https://docs.github.com/en/actions/hosting-your-own-runners/about-self-hosted-runners),
[labels](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/using-labels-with-self-hosted-runners),
[runner reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners),
[GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token),
[choosing the runner](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job).
GitLab: [runner overview](https://docs.gitlab.com/runner/),
[runners scope](https://docs.gitlab.com/ci/runners/runners_scope/),
[configure runners](https://docs.gitlab.com/ci/runners/configure_runners/),
[advanced configuration](https://docs.gitlab.com/runner/configuration/advanced-configuration/),
[job troubleshooting](https://docs.gitlab.com/ci/jobs/job_troubleshooting/),
[CI_JOB_TOKEN](https://docs.gitlab.com/ci/jobs/ci_job_token/).
Buildkite: [agent lifecycle](https://buildkite.com/docs/agent/v3),
[tokens](https://buildkite.com/docs/agent/v3/tokens),
[queues](https://buildkite.com/docs/agent/v3/queues),
[git-mirrors](https://buildkite.com/docs/agent/v3/git-mirrors),
[monitoring / lost agents](https://buildkite.com/docs/agent/v3/monitoring),
[ssh keys](https://buildkite.com/docs/agent/v3/ssh-keys).
Nomad: [client config](https://developer.hashicorp.com/nomad/docs/configuration/client),
[how scheduling works](https://developer.hashicorp.com/nomad/docs/concepts/scheduling/how-scheduling-works),
[node pools](https://developer.hashicorp.com/nomad/docs/concepts/node-pools),
[artifact block](https://developer.hashicorp.com/nomad/docs/job-specification/artifact),
[eval status](https://developer.hashicorp.com/nomad/commands/eval/status).
