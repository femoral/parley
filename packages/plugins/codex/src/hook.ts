import { recordCodexSession } from "./index.js";

async function main(): Promise<void> {
  let body = "";
  for await (const chunk of process.stdin) body += chunk;
  recordCodexSession(JSON.parse(body) as unknown as Record<string, unknown>);
}

// Codex hooks are fail-open. Do not emit stdout: hook stdout becomes
// model-visible developer context rather than session environment.
void main().catch(() => {});
