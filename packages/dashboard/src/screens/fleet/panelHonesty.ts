/**
 * Per-panel honesty phases for fleet surfaces.
 * Global honesty comes from useHonesty; panels refine empty/error/loading.
 */
import type { HonestyPhase, TransportStatus } from "../../data/types.js";

export type PanelPhase =
  | "loading"
  | "live"
  | "empty"
  | "offline"
  | "stale-reconnecting"
  | "error";

export function panelPhaseFromTransport(
  transport: TransportStatus,
  count: number,
  error: string | null | undefined,
  global: HonestyPhase,
): PanelPhase {
  if (global === "offline") return "offline";
  if (global === "stale-reconnecting") return "stale-reconnecting";
  if (global === "loading" || global === "connecting") return "loading";
  if (error) return "error";
  if (transport === "connecting") return "loading";
  if (transport === "offline") return "offline";
  if (count === 0) return "empty";
  return "live";
}

export function panelPhaseFromSnapshot(
  global: HonestyPhase,
  count: number,
): PanelPhase {
  if (global === "offline") return "offline";
  if (global === "stale-reconnecting") return "stale-reconnecting";
  if (global === "loading" || global === "connecting") return "loading";
  if (global === "panel-error") return "error";
  if (global === "empty" || count === 0) return "empty";
  return "live";
}

export function panelMessage(phase: PanelPhase, kind: string): string {
  switch (phase) {
    case "loading":
      return `Hailing the ${kind}…`;
    case "offline":
      return `Daemon offline — ${kind} unavailable`;
    case "stale-reconnecting":
      return `Reconnecting — last known ${kind}`;
    case "error":
      return `Could not load ${kind}`;
    case "empty":
      if (kind === "fleet") {
        return "No tasks yet. Copy a scaffold to start work.";
      }
      // Seed-silent firehose is not "no events exist" — only none since connect.
      if (kind === "events") return "No events since connect";
      return `No ${kind}`;
    default:
      return "";
  }
}
