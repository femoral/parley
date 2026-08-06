/**
 * Observation-only copy scaffolds — the console hands verbs to the
 * orchestrating agent. Ready-to-paste CLI lines.
 */

export function answerScaffold(taskId: string): string {
  return `parley answer ${taskId} "..."`;
}

export function fixScaffold(taskId: string): string {
  return `parley fix ${taskId} "..."`;
}

export function delegateScaffold(hint?: string): string {
  const body = hint?.trim() ? hint.trim() : "…";
  return `parley delegate "${body}"`;
}
