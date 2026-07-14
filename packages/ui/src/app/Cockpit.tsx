import { lazy, Suspense } from "react";
import {
  Cartouche,
  DayChip,
  HealthPanel,
  InboxPanel,
  Inspector,
  RosterPanel,
  SettingsBar,
} from "../hud/index.js";
import { Scene } from "../scene/index.js";
import { useCockpit } from "./hooks/index.js";
import { CompassRose } from "./CompassRose.js";
import "./cockpit.css";

const DevKitBand = import.meta.env.DEV
  ? lazy(() => import("../hud/KitBand.js").then(({ KitBand }) => ({ default: KitBand })))
  : null;

/**
 * Layer 4 — the cockpit shell. Pure presentation: it reads one hook
 * ({@link useCockpit}) and lays the regions out; it never imports the core SDK.
 * This is #65's demoable slice — the chrome, the layout, and a live health panel
 * — with the living scene reserved for its own ticket.
 */
export function Cockpit() {
  const { health, snapshot, roster, clock, day, inspector, settings } = useCockpit();

  return (
    <div className="pc-cockpit">
      <div className="pc-atmos pc-atmos--sea" />
      <CompassRose />
      <div className="pc-atmos pc-atmos--vignette" />

      <div className="pc-cockpit__layout">
        <div className="pc-cockpit__main">
          <section className="pc-region--roster" aria-label="Fleet roster">
            <RosterPanel
              groups={snapshot.groups}
              sessions={snapshot.sessions}
              selectedSessionId={roster.selectedSessionId}
              onSelectSession={roster.selectSession}
              searchSessions={roster.searchSessions}
              selectedTaskId={roster.selectedTaskId}
              onSelectTask={roster.selectTask}
              totalTasks={snapshot.totalTasks}
              activeTasks={snapshot.activeTasks}
            />
          </section>

          <section className="pc-region--center" aria-label="The cove">
            <div className="pc-center__head">
              <Cartouche ornaments={settings.ornaments} />
              <DayChip day={day} clock={clock} />
            </div>
            {/* Sea is the room's backdrop (#75) — no Plate card chrome. */}
            <div className="pc-scene">
              <Scene
                sessions={snapshot.scene.sessions}
                activeSessionId={roster.selectedSessionId}
                onSelectTask={roster.selectTask}
              />
            </div>
          </section>

          <aside className="pc-region--right" aria-label="Status stack">
            <HealthPanel health={health} />
            <InboxPanel tasks={snapshot.inbox} />
            <Inspector task={inspector} ornaments={settings.ornaments} />
          </aside>
        </div>

        <SettingsBar
          ornaments={settings.ornaments}
          showKit={settings.showKit}
          followLogs={settings.followLogs}
          onToggleOrnaments={settings.toggleOrnaments}
          onToggleShowKit={settings.toggleShowKit}
          onToggleFollowLogs={settings.toggleFollowLogs}
        />
        {DevKitBand && settings.showKit && (
          <Suspense fallback={null}>
            <DevKitBand />
          </Suspense>
        )}
      </div>
    </div>
  );
}
