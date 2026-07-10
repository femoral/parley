import type {
  HubInfo,
  SpawnPlan,
  TaskSpec,
  VendorAdapter,
  VendorEvent,
} from "./types.js";

/**
 * The `fake` vendor adapter — the contract-test vendor (spec §10). It spawns a
 * scriptable CLI (path injected via `PARLEY_FAKE_VENDOR_BIN`) that speaks a
 * vendor-like JSONL stream and acts as a real MCP client against the hub, so
 * the whole delegate spine is exercised without paid API calls.
 *
 * It goes through the exact same interface as codex/grok adapters will: the
 * daemon core treats it as just another vendor.
 */
export function createFakeAdapter(env: NodeJS.ProcessEnv = process.env): VendorAdapter {
  function plan(task: TaskSpec, hub: HubInfo): SpawnPlan {
    const bin = env.PARLEY_FAKE_VENDOR_BIN;
    if (!bin) {
      throw new Error("fake vendor: PARLEY_FAKE_VENDOR_BIN is not set");
    }
    // Test seam (spec §10 — this adapter is a test double): point the spawn at a
    // deliberately bad binary to exercise the daemon's spawn-failure path.
    const command = env.PARLEY_FAKE_COMMAND ?? process.execPath;
    return {
      argv: [command, bin, task.prompt],
      env: {
        FAKE_MCP_URL: hub.url,
        FAKE_MCP_HEADERS: JSON.stringify(hub.headers),
        // Model passes through opaquely — the adapter never interprets it.
        ...(task.model !== null ? { FAKE_MODEL: task.model } : {}),
        ...(task.sessionId !== undefined ? { FAKE_RESUME_SESSION: task.sessionId } : {}),
      },
      files: [],
      cwd: task.cwd,
    };
  }

  return {
    id: "fake",

    prepare(task, hub) {
      return Promise.resolve(plan(task, hub));
    },

    resume(task, hub) {
      // Spawn-per-turn resume (ADR-0004): respawn with the persisted session id.
      // Exercised by the stalled-task tickets (#16/#17).
      return Promise.resolve(plan(task, hub));
    },

    parseEvent(line: string): VendorEvent[] {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return []; // opaque non-JSON vendor noise — raw log keeps it
      }
      if (typeof parsed !== "object" || parsed === null) return [];
      const event = parsed as Record<string, unknown>;
      switch (event.type) {
        case "message":
          return [{ kind: "message", text: typeof event.text === "string" ? event.text : "" }];
        case "command":
          return [{ kind: "command", text: typeof event.command === "string" ? event.command : "" }];
        case "file_change":
          return [{ kind: "file_change", text: typeof event.path === "string" ? event.path : "" }];
        case "error":
        case "fatal":
          return [{ kind: "error", text: typeof event.message === "string" ? event.message : "" }];
        case "session":
          return [
            {
              kind: "session_meta",
              session_id: typeof event.session_id === "string" ? event.session_id : undefined,
            },
          ];
        case "usage": {
          const usage: Record<string, number> = {};
          for (const [key, value] of Object.entries(event)) {
            if (key !== "type" && typeof value === "number") usage[key] = value;
          }
          return [{ kind: "session_meta", usage }];
        }
        default:
          return []; // unknown event shapes pass through opaque
      }
    },

    sessionId(events: VendorEvent[]): string | undefined {
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (event?.kind === "session_meta" && event.session_id !== undefined) {
          return event.session_id;
        }
      }
      return undefined;
    },
  };
}
