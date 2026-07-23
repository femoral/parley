import { lazy, Suspense, useRef } from "react";
import {
  Cartouche,
  ChartKey,
  DayChip,
  HealthPanel,
  InboxPanel,
  Inspector,
  RosterPanel,
  SettingsBar,
  SoundingsPanel,
  type RosterSearchHandle,
} from "../hud/index.js";
import { Mark } from "../primitives/index.js";
import { STATE_META } from "../tokens/state-meta.js";
import { Scene } from "../scene/index.js";
import { useCockpit, useCockpitKeys } from "./hooks/index.js";
import { CompassRose } from "./CompassRose.js";
import "./cockpit.css";

const DevKitBand = import.meta.env.DEV
  ? lazy(() => import("../hud/KitBand.js").then(({ KitBand }) => ({ default: KitBand })))
  : null;

/**
 * Layer 4 — the cockpit shell. Pure presentation: it reads one hook
 * ({@link useCockpit}) and lays the regions out; it never imports the core SDK.
 * Centre column switches Cove (living scene) ↔ Soundings (metrics, #119).
 */
export function Cockpit() {
  const {
    health,
    snapshot,
    roster,
    clock,
    day,
    inspector,
    settings,
    chartStale,
    mode,
    setMode,
    toggleSoundings,
    soundings,
    setGroupBy,
    setSoundingsFilters,
    clearSoundingsFilters,
    setSoundingsViewTab,
  } = useCockpit();
  const rosterSearchRef = useRef<RosterSearchHandle | null>(null);
  useCockpitKeys({
    rosterRef: rosterSearchRef,
    inbox: snapshot.inbox,
    selectedTaskId: roster.selectedTaskId,
    selectTask: roster.selectTask,
    clearTask: roster.clearTask,
    toggleSoundings,
    enabled: settings.shortcuts,
  });

  return (
    <div className={`pc-cockpit${chartStale ? " pc-cockpit--stale" : ""}`} data-stale={chartStale ? "true" : undefined}>
      {/* Keyboard users land here first; the cockpit has no nav to skip past
          except the atmosphere layers, so the target is the main region.
          A second skip jumps past the roster + scene island wall into the
          right rail (Inbox / Inspector) without 12 island tab stops. */}
      <a className="pc-skip-link" href="#pc-main">
        Skip to cockpit
      </a>
      <a className="pc-skip-link" href="#pc-status-stack">
        Skip to status stack
      </a>
      <div className="pc-atmos pc-atmos--sea" />
      <div className="pc-atmos pc-atmos--vignette" />

      <div className="pc-cockpit__layout">
        <main id="pc-main" className="pc-cockpit__main">
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
              connecting={!snapshot.ready}
              searchRef={rosterSearchRef}
            />
          </section>

          <section className="pc-region--center" aria-label={mode === "soundings" ? "Soundings" : "The cove"}>
            <div className="pc-center__head">
              <div className="pc-center__title-stack">
                <Cartouche ornaments={settings.ornaments} />
                <nav className="pc-view-nav pc-view-nav--cartouche" aria-label="Cockpit views">
                  {/* Toggle pair (not page links): aria-pressed, not aria-current="page". */}
                  <button
                    type="button"
                    className={`pc-view-nav__tab${mode === "cove" ? " pc-view-nav__tab--active" : ""}`}
                    aria-pressed={mode === "cove"}
                    onClick={() => setMode("cove")}
                  >
                    Cove
                  </button>
                  <button
                    type="button"
                    className={`pc-view-nav__tab${mode === "soundings" ? " pc-view-nav__tab--active" : ""}`}
                    aria-pressed={mode === "soundings"}
                    onClick={() => setMode("soundings")}
                  >
                    Soundings
                  </button>
                </nav>
              </div>
              <DayChip day={day} clock={clock} />
            </div>
            {mode === "soundings" ? (
              <div className="pc-soundings-stage">
                <SoundingsPanel
                  soundings={soundings}
                  onGroupBy={setGroupBy}
                  onFiltersChange={setSoundingsFilters}
                  onFiltersClear={clearSoundingsFilters}
                  onViewTab={setSoundingsViewTab}
                />
              </div>
            ) : (
              <div className="pc-scene">
                {/* Icon-scale rose: top-left of the scene stage, under the head.
                    Ornaments-off stills this ambient chrome with the rest. */}
                <CompassRose ornaments={settings.ornaments} />
                {/* Sea is the room's backdrop (#75) — no Plate card chrome. */}
                {chartStale && (
                  <div className="pc-stale-band" role="status" aria-live="polite">
                    <span className="pc-stale-band__glyph" aria-hidden="true">
                      <Mark mark={STATE_META.stalled.mark} size={14} />
                    </span>
                    <span className="pc-stale-band__copy">Chart may be stale — reconnecting…</span>
                  </div>
                )}
                <Scene
                  sessions={snapshot.scene.sessions}
                  activeSessionId={roster.selectedSessionId}
                  onSelectTask={roster.selectTask}
                  onSelectSession={roster.selectSession}
                  frameIntent={roster.sceneFrameIntent}
                  connecting={!snapshot.ready}
                />
              </div>
            )}
          </section>

          <aside id="pc-status-stack" className="pc-region--right" aria-label="Status stack" tabIndex={-1}>
            <HealthPanel health={health} />
            <InboxPanel
              tasks={snapshot.inbox}
              onSelectTask={roster.selectInboxTask}
              sessionFilterActive={roster.selectedSessionId !== null}
            />
            <Inspector
              task={inspector}
              initialTab={roster.inspectorIntent.tab}
              openSeq={roster.inspectorIntent.seq}
            />
          </aside>
        </main>

        <footer className="pc-settings-row" aria-label="Chart key and settings">
          <ChartKey />
          <SettingsBar
            ornaments={settings.ornaments}
            showKit={settings.showKit}
            followLogs={settings.followLogs}
            shortcuts={settings.shortcuts}
            onToggleOrnaments={settings.toggleOrnaments}
            onToggleShowKit={settings.toggleShowKit}
            onToggleFollowLogs={settings.toggleFollowLogs}
            onToggleShortcuts={settings.toggleShortcuts}
          />
        </footer>
        {DevKitBand && settings.showKit && (
          <Suspense fallback={null}>
            <DevKitBand />
          </Suspense>
        )}
      </div>
    </div>
  );
}
