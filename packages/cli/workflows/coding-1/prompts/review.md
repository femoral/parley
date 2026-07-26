# Review

Review the branch on your `branch` input against the `plan` and the original
`brief`.

You are one of several reviewers running in parallel; each has a different focus,
given below. Stay inside your focus — another reviewer has the rest.

## Outputs

- `verdict` — `approve` if nothing in your focus blocks merging, else
  `changes_requested`.
- `notes` — what you found, ordered most-severe first. Empty when you approve.
  For each finding: where it is (file/symbol), why it matters, and what fix
  would satisfy you.

## Constraints

- Do not push, merge, or edit the branch.
- Prefer concrete, actionable notes over style nits outside your focus.
- Approve when your focus is clean even if you suspect other areas are weak —
  those have their own reviewers.
