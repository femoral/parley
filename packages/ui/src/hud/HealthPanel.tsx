import type { CSSProperties } from "react";
import { Mark, Plate, PlateHeader } from "../primitives/index.js";
import { MARK_ANCHOR } from "../tokens/chrome-glyphs.js";
import type { HealthView } from "./types.js";

/**
 * Layer 2 — the daemon health panel (design-manifest §4.14). Plain props only:
 * the hooks layer probes `/health` + `/tasks` and hands this a fully-projected
 * {@link HealthView}. Daemon facts only (connection, version, host/port/pid,
 * uptime, durable sessions) — fleet counts (total/active) live on the roster.
 *
 * Compact density: at a glance the probe lifecycle matters (neutral HAILING…
 * until resolved, then HEALTHY/OFFLINE). Host/port/PID/uptime/sessions stay
 * visible as dense mono meta so the right rail frees vertical space for the
 * inspector (LOGBOOK payoff).
 */
export function HealthPanel({ health }: { health: HealthView }) {
  const status = health.status ?? (health.online ? "online" : "offline");
  const connecting = status === "connecting";
  const chipColor = connecting
    ? "var(--brass-soft)"
    : health.online
      ? "var(--healthy-dot)"
      : "var(--state-failed)";
  const chipStyle = {
    "--health-chip-color": chipColor,
    "--dot-color": connecting ? "var(--brass-frame)" : chipColor,
  } as CSSProperties;
  const chipLabel = connecting ? "HAILING…" : health.online ? "HEALTHY" : "OFFLINE";
  const pid = health.pid !== null ? String(health.pid) : "—";
  const uptime = health.uptime || "—";
  return (
    <Plate padded={false}>
      <PlateHeader
        icon={<Mark mark={MARK_ANCHOR} size={14} />}
        title="DAEMON HEALTH"
        subtitle={health.version ? `v${health.version}` : "connecting…"}
        divider
        aside={
          <span
            className={`pc-health-chip${connecting ? " pc-health-chip--connecting" : ""}`}
            style={chipStyle}
            role="status"
            aria-live="polite"
          >
            <span className={`pc-dot${health.online ? " pc-dot--beacon" : ""}`} />
            {chipLabel}
          </span>
        }
      />
      <div className="pc-plate__body">
        <div className="pc-health__compact" data-testid="health-compact">
          <div className="pc-health__compact-row">
            <span className="pc-health__compact-item">
              <span className="pc-health__compact-k">Host</span>
              <span className="pc-health__compact-v">{health.host}</span>
            </span>
            <span className="pc-health__compact-sep" aria-hidden="true">
              ·
            </span>
            <span className="pc-health__compact-item">
              <span className="pc-health__compact-k">Port</span>
              <span className="pc-health__compact-v">{health.port}</span>
            </span>
            <span className="pc-health__compact-sep" aria-hidden="true">
              ·
            </span>
            <span className="pc-health__compact-item">
              <span className="pc-health__compact-k">PID</span>
              <span className="pc-health__compact-v">{pid}</span>
            </span>
          </div>
          <div className="pc-health__compact-row">
            <span className="pc-health__compact-item">
              <span className="pc-health__compact-k">Uptime</span>
              <span className="pc-health__compact-v">{uptime}</span>
            </span>
            <span className="pc-health__compact-sep" aria-hidden="true">
              ·
            </span>
            <span className="pc-health__compact-item">
              <span className="pc-health__compact-k">Sessions</span>
              <span className="pc-health__compact-v">{String(health.durableSessions)}</span>
            </span>
          </div>
        </div>
      </div>
    </Plate>
  );
}
