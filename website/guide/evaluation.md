# Evaluation

::: warning Experimental
The evaluation flow works but has not been thoroughly tested yet. Expect
rough edges.
:::

Delegation without measurement turns into vibes. Parley's eval flow gives
every delegated task a structured, rubric-based score, so "which model should
get this kind of work" becomes a query instead of a feeling.

## How it works

1. **Classify at delegate time** (optional). Size, difficulty, and work-domain
   type ride along on the task:

   ```bash
   parley delegate --size M --difficulty hard --type coding ...
   ```

2. **Evaluate after review.** The reviewer (usually the orchestrating agent,
   after reading the branch) answers the rubric's boolean criteria and leaves
   feedback:

   ```bash
   parley eval t42 --answers '{"tests-pass": true, "brief-followed": true}' \
     --feedback "clean fix, good regression test"
   ```

   The daemon computes the score and the running baseline from your answers.
   A later `eval` call on the same task overwrites the previous one.

3. **Slice the aggregates.**

   ```bash
   parley metrics --group-by vendor
   parley metrics --group-by profile
   parley metrics --group-by difficulty
   ```

   Counts, eval scores, tokens, and durations per group, in the terminal or
   in [the Console](/guide/console).

## Setting it up

`/parley-wizard` interviews you into the project surfaces under `.parley/`:

- eval settings and versioned **rubrics** (which criteria, per task type),
- **task types** and **classification guidance** (what counts as an `M`, what
  counts as `hard`), so the orchestrator classifies consistently.

`parley info` prints the effective eval and classification policy as prose
the orchestrator reads before delegating; `parley lint` validates the files.

Runs aggregate the same signals per node and whole-run, so a workflow's
review step can be compared across iterations.
