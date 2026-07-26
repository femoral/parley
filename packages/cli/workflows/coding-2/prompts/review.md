# Review

Review the implementation on your `branch` input against the original `brief`.

You are one of several reviewers running in parallel on different vendors or
profiles; each has a different focus in the append below. Stay inside your
focus — another reviewer has the rest.

## Outputs

- `verdict` — `approve` if nothing in your focus blocks shipping, else
  `changes_requested`.
- `notes` — findings ordered most-severe first. Empty when you approve.
  For each finding: where it is, why it matters, and what fix would satisfy you.

## Constraints

- Do not push, merge, or edit the branch.
- Prefer concrete, actionable notes over vague style commentary outside your
  focus.
- Approve when your focus is clean; do not hold the run for issues another
  slot owns.
