import type { CSSProperties } from "react";
import { Plate, PlateHeader, Stat } from "../primitives/index.js";
import type { HealthView } from "./types.js";

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="pc-health__cell">
      <span className="pc-health__label">{label}</span>
      <span className="pc-health__value">{value}</span>
    </div>
  );
}

/**
 * Layer 2 — the daemon health panel (design-manifest §4.14). Plain props only:
 * the hooks layer probes `/health` + `/tasks` and hands this a fully-projected
 * {@link HealthView}. Renders status, version, pid, uptime and task counts.
 */
export function HealthPanel({ health }: { health: HealthView }) {
  const chipColor = health.online ? "var(--healthy-dot)" : "var(--state-failed)";
  const chipStyle = {
    "--health-chip-color": chipColor,
    "--dot-color": chipColor,
  } as CSSProperties;
  return (
    <Plate padded={false}>
      <PlateHeader
        icon="⚓"
        title="DAEMON HEALTH"
        subtitle={health.version ? `v${health.version}` : "connecting…"}
        divider
        aside={
          <span className="pc-health-chip" style={chipStyle}>
            <span className={`pc-dot${health.online ? " pc-dot--beacon" : ""}`} />
            {health.online ? "HEALTHY" : "OFFLINE"}
          </span>
        }
      />
      <div className="pc-plate__body">
        <div className="pc-health__grid">
          <Cell label="Host" value={health.host} />
          <Cell label="Port" value={health.port} />
          <Cell label="PID" value={health.pid !== null ? String(health.pid) : "—"} />
          <Cell label="Uptime" value={health.uptime || "—"} />
        </div>
        <div className="pc-health__wells">
          <div className="pc-well">
            <Stat value={String(health.totalTasks)} label="Total tasks" color="var(--brass)" />
          </div>
          <div className="pc-well">
            <Stat
              value={`${health.activeAgents} / ${health.totalTasks}`}
              label="Active agents"
              color="var(--state-running)"
            />
          </div>
          <div className="pc-well">
            <Stat
              value={String(health.durableSessions)}
              label="Sessions"
              color="var(--sessions-blue)"
            />
          </div>
        </div>
      </div>
    </Plate>
  );
}
