# ADR-0001: Hierarchy from content, not geometry; no filler termination elements

**Status**: accepted · **Date**: 2026-08-07 · **Decided**: [#371](https://github.com/femoral/parley/issues/371) (reverses part of [#368](https://github.com/femoral/parley/issues/368))

## Context

The #368 honesty pass made two hierarchy contracts pass geometrically:

- The task-screen ask band carried `min-height: 200px` and a `min-height: 5.5em`
  question box, and `[data-ask="true"]` capped the log column at
  `min(32vh, 240px)` — so the band's measured area outranked the log by padding
  and by shrinking the log, not by content. A short question rendered ~32px of
  ink in a 132px box while ~81% of the log was hidden exactly when the operator
  needs it to answer.
- The run and metrics screens ended with residual-filling termination strips
  ("END OF RUN" / "END OF METRICS", 440–605px at 1920) whose only content was
  the label — decoration by the register's own law ("every pixel is data or
  structure").

The void gate required the strip to be present and to fill the residual, so the
gates enforced the geometric treatment.

## Decision

### Ask band: rank from position, ink, and scale

The band sizes to its content — no geometric minimums on the band or question.
Hierarchy is carried by what is real: first position in the task column, the
awaiting-state ink (left rule + tinted ground), and the question set at the
largest type scale on the screen. The log is not capped while an ask is open;
answering needs the log, and layout order already keeps the band on top.

### Termination: calm ground, no filler

Terminal content just ends. Residual board ground after the last content row is
intentional calm ground, **not** "dead void" needing treatment. Filler
termination elements (strips, labels, decorative blocks that exist to occupy
residual space) are forbidden on any Console screen.

### Gates follow the contract

- Ask hierarchy gate asserts position, rendered type scale, state ink, question
  visibility, and the *absence* of geometric minimums and log caps.
- Void gate inverts: no termination element renders; nothing decorative occupies
  the residual; termination styling forces no board scroll.

## Consequences

- A validator sweep that flags residual ground under run/metrics as "dead void"
  is re-flagging a ratified decision — cite this ADR, do not re-add a strip.
- A short question renders a short band; that is honest, not a hierarchy defect.
- DESIGN.md Don'ts carry the operative rules.
