import { Cartouche, DayChip, HealthPanel, InboxPanel, Inspector, RosterPanel } from "../hud/index.js";
import { Plate } from "../primitives/index.js";
import { Scene } from "../scene/index.js";
import { useCockpit } from "./hooks/index.js";
import { CompassRose } from "./CompassRose.js";
import "./cockpit.css";

/**
 * Layer 4 — the cockpit shell. Pure presentation: it reads one hook
 * ({@link useCockpit}) and lays the regions out; it never imports the core SDK.
 * This is #65's demoable slice — the chrome, the layout, and a live health panel
 * — with the living scene reserved for its own ticket.
 */
export function Cockpit() {
  const { health, snapshot, roster, clock, day, answerTask, inspector } = useCockpit();

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
              selectedTaskId={roster.selectedTaskId}
              onSelectTask={roster.selectTask}
              totalTasks={snapshot.totalTasks}
              activeTasks={snapshot.activeTasks}
            />
          </section>

          <section className="pc-region--center" aria-label="The cove">
            <div className="pc-center__head">
              <Cartouche />
              <DayChip day={day} clock={clock} />
            </div>
            <Plate variant="premium" ornaments className="pc-scene" padded={false}>
              <Scene sessions={snapshot.scene.sessions} activeSessionId={roster.selectedSessionId} />
            </Plate>
          </section>

          <aside className="pc-region--right" aria-label="Status stack">
            <HealthPanel health={health} />
            <InboxPanel tasks={snapshot.inbox} onAnswer={answerTask} />
            <Inspector task={inspector} />
          </aside>
        </div>
      </div>
    </div>
  );
}
