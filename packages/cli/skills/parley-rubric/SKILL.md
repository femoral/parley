---
name: parley-rubric
description: Set up task evaluation for parley — interview the user to define concrete Size (T-shirt) and Difficulty classification metrics plus binary, MECE success rubrics, then write the project rubric file the orchestrator classifies and evaluates against. Use when the user wants to turn on evaluation, define task metrics, or calibrate parley scoring.
---

# Setting up a parley evaluation rubric

You are about to define how delegated tasks get classified and judged in this
project. The output is one file, `.parley/rubric.md`, committed to the repo.
Orchestrators read it at two moments: when delegating (classify the brief) and
when reviewing a completed branch (evaluate it). Metrics (`parley metrics`)
then slice results by the classifications recorded on each task.

**Interview the user — do not fill the rubric in for them.** The templates
below are calibrated starting points; every threshold in them is a question to
confirm or adjust. A rubric only works when its lines match how this project
actually experiences work.

## The three artifacts

1. **Size metric** — T-shirt sizes (XS–XL) measuring *expected scope*,
   estimable from the brief alone before any work happens.
2. **Difficulty metric** — orthogonal to size: how much ambiguity, design
   judgment, and risk the task carries (`trivial|easy|medium|hard|extreme`).
   A 400-line mechanical rename is XL/trivial; a 10-line concurrency fix is
   XS/hard.
3. **Success rubric** — binary, MECE checks applied to the completed branch.
   Binary: each item is PASS or FAIL, never partial. MECE: no two items judge
   the same fact, and together they cover everything "done" means here.

## Interview flow

Ask, in order (adapt wording, keep substance):

1. **Calibration anchors.** "Name a recent task you'd call XS and one you'd
   call XL. What made them so?" Use the answers to set the size boundaries
   (files touched, expected diff size, subsystems crossed).
2. **Difficulty signals.** "What makes a task risky here, independent of its
   size?" (unknown subsystems, concurrency, migrations, external APIs,
   performance constraints…). Fold these into the difficulty ladder.
3. **Verification commands.** "What must pass before you'd merge anything?"
   (typecheck, test suite, lint, build, smoke run). These become the
   mechanical rubric items — get exact commands.
4. **Non-mechanical done-ness.** "What do failed merges usually get wrong
   besides red tests?" (scope creep, missing tests for new code, docs drift,
   API breaks). Each answer becomes one binary rubric line.
5. **Score mapping.** Confirm the default: score = round(9 × passed/total) + 1
   (all-pass = 10, all-fail = 1), recorded with
   `parley eval <task> --score <n> --feedback "<one line per rubric item: PASS/FAIL + why>"`.

Then write `.parley/rubric.md` from [templates/rubric-template.md](templates/rubric-template.md),
replacing every `«…»` placeholder with the interview's answers. Show the user
the result and adjust until they accept. Done when the file is committed.

## How orchestrators consume it

- **At delegate time**: classify the brief and record it —
  `parley delegate --size M --difficulty hard …`. Sizes and difficulties are
  the exact enum values above; classification is required for evaluated
  projects (it is what metrics group by).
- **At review time**: walk the success rubric top to bottom against the
  branch diff and report, mark each PASS/FAIL, compute the score, record it
  with `parley eval`. Never skip a FAIL because the report claimed success —
  the rubric exists precisely for that gap.
