# Parley task rubric

<!-- Written by the parley-rubric interview. Orchestrators: read this file
     before delegating (classify) and before acking a completed task
     (evaluate). Keep every check binary — PASS or FAIL, never partial. -->

## Size (expected scope, judged from the brief alone)

| Size | Definition (all must hold) |
| ---- | -------------------------- |
| XS | «e.g. one file, ≤ ~30 changed lines, no new dependencies, no schema/API change» |
| S  | «e.g. ≤ 3 files in one package, ≤ ~150 lines, no cross-package surface change» |
| M  | «e.g. one package end-to-end (source + tests + docs), ≤ ~500 lines» |
| L  | «e.g. crosses 2+ packages or changes a public contract/schema» |
| XL | «e.g. new package, new subsystem, or a migration touching most of the codebase» |

When a task straddles two sizes, take the larger. Record at delegate time:
`parley delegate --size <XS|S|M|L|XL> …`

## Difficulty (ambiguity + risk, independent of size)

| Difficulty | Definition |
| ---------- | ---------- |
| trivial | Mechanical; the brief fully determines the diff; established pattern to copy |
| easy    | Minor judgment; pattern exists nearby; failure is obvious if it happens |
| medium  | Real design choices among known options; «project signal, e.g. touches the engine state machine» |
| hard    | Unknowns to resolve; cross-cutting invariants; «e.g. concurrency, migrations, sandbox semantics» |
| extreme | Research-grade; success uncertain; approach must be discovered |

Record at delegate time: `parley delegate --difficulty <trivial|easy|medium|hard|extreme> …`

## Success rubric (binary, MECE — judge the branch, not the report)

Mechanical gates (run them; command output is the verdict):

- [ ] **build**: `«pnpm typecheck»` passes on the branch
- [ ] **tests**: `«pnpm test»` green, including new tests
- [ ] **lint**: `«pnpm lint»` introduces no new findings

Judgment gates (inspect the diff):

- [ ] **scope**: every changed file is in service of the brief — no drive-by
      edits, no unrelated refactors
- [ ] **coverage**: new behavior has tests that would fail without the change
- [ ] **report-accuracy**: the task report's summary and files_changed match
      the actual diff
- [ ] **conventions**: code matches surrounding style, naming, and register
      («project-specific: e.g. doc comments cite the research/ADR they serve»)
- [ ] «any project-specific gate discovered in the interview, e.g. docs
      updated when a public surface changes»

## Scoring

score = round(9 × passed / total) + 1 → `parley eval <task> --score <n>
--feedback "<one line per gate: PASS/FAIL + evidence>"`.

A FAIL on **build** or **tests** caps the score at 4 regardless of the ratio —
a branch that doesn't verify is not partially done.
