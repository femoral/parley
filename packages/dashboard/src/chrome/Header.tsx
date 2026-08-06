/**
 * Chrome header — brand mark, screen tablist, daemon live status, needs-orch
 * pill, stream honesty slot (reframed "tail"), clock, settings.
 */
import { forwardRef } from "react";
import type { HonestyState, HealthView, SnapshotView } from "../data/types.js";
import type { ScreenId } from "../screens/types.js";
import { SCREEN_LABELS } from "../screens/types.js";
import { formatClock, formatOrigin, formatUptime } from "./format.js";
import { countNoun, countNeedVerb } from "./plural.js";

export interface HeaderProps {
  screen: ScreenId;
  onNavigate: (screen: ScreenId) => void;
  health: HealthView;
  honesty: HonestyState;
  snapshot: SnapshotView;
  attentionCount: number;
  clock: string;
  tabSubs: Record<ScreenId, string>;
  onOpenSettings: () => void;
  settingsOpen?: boolean;
}

/**
 * Value next to the "stream" label — never re-includes the word "stream"
 * (avoids "streamstream live" concatenation in the accessibility tree).
 */
function honestyValue(honesty: HonestyState): { value: string; live: boolean } {
  switch (honesty.phase) {
    case "live":
      return { value: "live", live: true };
    case "loading":
    case "connecting":
      return { value: "connecting", live: false };
    case "offline":
      return { value: "offline", live: false };
    case "stale-reconnecting":
      return { value: "reconnecting", live: false };
    case "empty":
      return { value: "live · empty", live: true };
    case "panel-error":
      return { value: "panel error", live: honesty.streamConnected };
    default:
      return { value: honesty.phase, live: false };
  }
}

/** Full detail for title tooltip (never clipped in the visible chip). */
function daemonDetailFull(health: HealthView): string {
  if (!health.online) return "unreachable";
  const parts: string[] = [];
  if (health.version) parts.push(`v${health.version}`);
  if (health.pid != null) parts.push(`pid ${health.pid}`);
  const up = formatUptime(health.uptimeMs);
  if (up !== "—") parts.push(`up ${up}`);
  return parts.length > 0 ? parts.join(" · ") : "online";
}

/**
 * Compact visible meta at the 1280 floor — version only (uptime lives in title).
 * Full string used at wider viewports via CSS show/hide.
 */
function daemonDetailCompact(health: HealthView): string {
  if (!health.online) return "unreachable";
  if (health.version) return `v${health.version}`;
  return "online";
}

const TAB_ORDER: ScreenId[] = ["fleet", "run", "task", "metrics"];

export function buildTabSubs(input: {
  totalTasks: number;
  attentionCount: number;
  selectedRunId: string | null;
  selectedTaskId: string | null;
  firstRunLabel: string | null;
  firstTaskId: string | null;
  honestyPhase: HonestyState["phase"];
}): Record<ScreenId, string> {
  const { totalTasks, attentionCount } = input;
  const runLabel = input.selectedRunId
    ? input.selectedRunId.slice(0, 8)
    : (input.firstRunLabel ?? "no run");
  const taskLabel = input.selectedTaskId ?? input.firstTaskId ?? "no task";
  return {
    fleet: `${countNoun(totalTasks, "task")} · ${countNeedVerb(attentionCount, "action")}`,
    run: runLabel,
    task: taskLabel,
    metrics:
      input.honestyPhase === "live" || input.honestyPhase === "empty"
        ? "all hands"
        : input.honestyPhase,
  };
}

export const Header = forwardRef<HTMLButtonElement, HeaderProps>(function Header(
  {
    screen,
    onNavigate,
    health,
    honesty,
    snapshot,
    attentionCount,
    clock,
    tabSubs,
    onOpenSettings,
    settingsOpen = false,
  },
  settingsBtnRef,
) {
  const origin = formatOrigin();
  const detailFull = daemonDetailFull(health);
  const detailCompact = daemonDetailCompact(health);
  const stream = honestyValue(honesty);
  const liveDot =
    health.online && (honesty.phase === "live" || honesty.phase === "empty");
  const taskTitle =
    snapshot.ready
      ? `${countNoun(snapshot.totalTasks, "task")} · seq ${snapshot.seq}`
      : "awaiting first snapshot";

  return (
    <header className="pc-shell__header" data-testid="shell-header">
      <div className="pc-shell__brand-row">
        <div className="pc-shell__brand">
          <img
            className="pc-shell__mark"
            src="/assets/parleylogo.png"
            alt="Parley"
            width={22}
            height={22}
          />
          <div className="pc-shell__brand-text">
            <span className="pc-shell__brand-name">parley</span>
            <span className="pc-shell__brand-sub">console</span>
          </div>
        </div>

        <div className="pc-shell__divider" aria-hidden="true" />

        <nav
          id="shell-nav"
          className="pc-shell__nav"
          aria-label="Screens"
          data-testid="shell-nav"
          tabIndex={-1}
        >
          <div role="tablist" aria-label="Console screens" className="pc-shell__tablist">
            {TAB_ORDER.map((id) => {
              const selected = screen === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`pc-tab-${id}`}
                  aria-selected={selected}
                  aria-controls="main-content"
                  tabIndex={selected ? 0 : -1}
                  className={
                    selected ? "pc-shell__tab pc-shell__tab--active" : "pc-shell__tab"
                  }
                  onClick={() => onNavigate(id)}
                  data-testid={`nav-${id}`}
                  title={tabSubs[id]}
                >
                  <span className="pc-shell__tab-label">{SCREEN_LABELS[id]}</span>
                  <span className="pc-shell__tab-sub">{tabSubs[id]}</span>
                </button>
              );
            })}
          </div>
        </nav>
      </div>

      <div className="pc-shell__header-meta">
        <div
          className="pc-shell__status"
          data-testid="daemon-status"
          title={detailFull}
          data-online={health.online ? "true" : "false"}
        >
          <span
            className={
              liveDot
                ? "pc-shell__live-dot pc-shell__live-dot--on"
                : "pc-shell__live-dot pc-shell__live-dot--off"
            }
            aria-hidden="true"
          />
          <span className="pc-shell__status-label">daemon</span>
          <span className="pc-shell__status-value">{origin}</span>
          <span className="pc-shell__status-meta pc-shell__status-meta--full">{detailFull}</span>
          <span className="pc-shell__status-meta pc-shell__status-meta--compact">
            {detailCompact}
          </span>
        </div>

        <div className="pc-shell__divider pc-shell__divider--meta" aria-hidden="true" />

        <div
          className="pc-shell__attention"
          data-testid="needs-orch"
          title="Tasks and gates that need the orchestrator"
        >
          <span className="pc-shell__attention-label">needs orch</span>
          <span
            className="pc-shell__attention-count"
            data-count={attentionCount}
            aria-label={`${attentionCount} need the orchestrator`}
          >
            {attentionCount}
          </span>
        </div>

        <div className="pc-shell__divider pc-shell__divider--meta" aria-hidden="true" />

        <div
          className="pc-shell__live-status"
          data-testid="live-status"
          data-phase={honesty.phase}
          title={taskTitle}
        >
          <span className="pc-shell__live-status-label">stream</span>
          <span
            className={
              stream.live
                ? "pc-shell__live-status-value pc-shell__live-status-value--live"
                : "pc-shell__live-status-value"
            }
          >
            {stream.value}
          </span>
        </div>

        <div className="pc-shell__divider pc-shell__divider--meta" aria-hidden="true" />

        <time className="pc-shell__clock" dateTime={clock} aria-label="clock" data-testid="clock">
          {clock || formatClock()}
        </time>

        <button
          ref={settingsBtnRef}
          type="button"
          className="pc-shell__settings-btn"
          onClick={onOpenSettings}
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          data-testid="settings-open"
          title="Settings (,)"
        >
          Settings
        </button>
      </div>
    </header>
  );
});
