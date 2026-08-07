/**
 * Right rail content (#363): attention queue + event firehose.
 * Owns firehose cursor (moved out of the fleet center board).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AttentionCard,
  Panel,
  type AttentionCardVariant,
} from "../components/index.js";
import {
  advanceFirehose,
  emptyFirehoseCursor,
  firehoseTone,
  useConsoleData,
  useHonesty,
  usePolling,
  type FirehoseCursor,
  type HonestyPhase,
} from "../data/index.js";
import { projectAttentionItems } from "./attentionItems.js";
import { formatAge, formatTimeOfDay } from "./format.js";
import type { StateFilterKey } from "./LeftRail.js";

export interface RightRailProps {
  sessionId: string;
  stateFilter: StateFilterKey;
  selectedTaskId: string | null;
  selectedRunId: string | null;
  onSelectTask: (id: string) => void;
  onSelectRun: (id: string) => void;
  nowMs?: number;
}

function hosePhaseFrom(
  global: HonestyPhase,
  lineCount: number,
): "loading" | "live" | "empty" | "offline" | "stale-reconnecting" | "error" {
  if (global === "loading" || global === "connecting") return "loading";
  if (global === "offline") return "offline";
  if (global === "stale-reconnecting") return "stale-reconnecting";
  if (global === "panel-error") return "error";
  if (lineCount === 0) return "empty";
  return "live";
}

function queuePhaseFrom(
  global: HonestyPhase,
  count: number,
): "loading" | "live" | "empty" | "offline" | "stale-reconnecting" | "error" {
  if (global === "loading" || global === "connecting") return "loading";
  if (global === "offline") return "offline";
  if (global === "stale-reconnecting") return "stale-reconnecting";
  if (global === "panel-error") return "error";
  if (count === 0) return "empty";
  return "live";
}

export function RightRail({
  sessionId,
  stateFilter,
  selectedTaskId,
  selectedRunId,
  onSelectTask,
  onSelectRun,
  nowMs: nowMsProp,
}: RightRailProps) {
  const { snapshot, health, runs } = useConsoleData();
  const honesty = useHonesty({
    ready: snapshot.ready,
    streamConnected: snapshot.connected,
    healthOnline: health.online,
    streamLostSince: snapshot.streamLostSince,
    taskCount: snapshot.totalTasks,
  });

  const [minuteTick, setMinuteTick] = useState(() =>
    Math.floor(Date.now() / 60_000) * 60_000,
  );
  usePolling(
    useCallback(() => {
      setMinuteTick(Math.floor(Date.now() / 60_000) * 60_000);
    }, []),
    { intervalMs: 60_000, enabled: nowMsProp == null, immediate: false },
  );
  const nowMs = nowMsProp != null ? nowMsProp : minuteTick;

  const [density, setDensity] = useState<AttentionCardVariant>("card");

  const hoseRef = useRef<FirehoseCursor>(emptyFirehoseCursor());
  const [firehose, setFirehose] = useState(hoseRef.current.lines);
  const seeded = useRef(false);

  useEffect(() => {
    const seed = !seeded.current;
    const next = advanceFirehose(
      hoseRef.current,
      snapshot.tasks,
      runs.summaries,
      { seed },
    );
    hoseRef.current = next;
    if (seed) seeded.current = true;
    setFirehose(next.lines);
  }, [snapshot.tasks, runs.summaries]);

  const items = useMemo(
    () =>
      projectAttentionItems(snapshot.tasks, runs.summaries, {
        nowMs,
        sessionId,
        stateFilter,
      }),
    [snapshot.tasks, runs.summaries, nowMs, sessionId, stateFilter],
  );

  const queuePhase = queuePhaseFrom(honesty.phase, items.length);
  const hosePhase = hosePhaseFrom(honesty.phase, firehose.length);

  const queueHonesty =
    queuePhase === "empty"
      ? sessionId !== "all" || stateFilter !== "all"
        ? "No attention items in this scope"
        : "Nothing needs the orchestrator"
      : undefined;

  return (
    <div className="pc-rail-right" data-testid="rail-right-content">
      <Panel
        title="attention"
        meta={
          <span className="pc-rail-attention-meta">
            <span>
              {items.length} · rank · age
            </span>
            <span
              className="pc-rail-density"
              role="group"
              aria-label="Attention density"
            >
              <button
                type="button"
                className={`pc-rail-density__btn${density === "card" ? " pc-rail-density__btn--on" : ""}`}
                aria-pressed={density === "card"}
                data-testid="rail-density-cards"
                onClick={() => setDensity("card")}
              >
                cards
              </button>
              <button
                type="button"
                className={`pc-rail-density__btn${density === "rows" ? " pc-rail-density__btn--on" : ""}`}
                aria-pressed={density === "rows"}
                data-testid="rail-density-rows"
                onClick={() => setDensity("rows")}
              >
                rows
              </button>
            </span>
          </span>
        }
        phase={queuePhase}
        honestyKind="attention items"
        honestyMessage={queueHonesty}
        testId="rail-attention"
        className="pc-rail-attention"
        titleId="rail-attention-title"
        titleTag="h2"
      >
        <div
          className="pc-rail-queue"
          data-testid="rail-attention-list"
          role="list"
          aria-label="Attention queue"
        >
          {items.map((item) => {
            const selected =
              item.kind === "task"
                ? selectedTaskId === item.id
                : selectedRunId === item.id;
            return (
              <div key={`${item.kind}-${item.id}`} role="listitem">
                <AttentionCard
                  state={item.state}
                  age={formatAge(item.ageAt, nowMs)}
                  title={item.title}
                  reason={item.reason}
                  meta={item.meta}
                  variant={density}
                  selected={selected}
                  badgeLabel={item.badgeLabel}
                  testId={`attn-${item.kind}-${item.id}`}
                  onSelect={() => {
                    if (item.kind === "task") onSelectTask(item.id);
                    else onSelectRun(item.id);
                  }}
                />
              </div>
            );
          })}
        </div>
      </Panel>

      <Panel
        title="firehose"
        meta="watch — follow"
        phase={hosePhase}
        honestyKind="events"
        testId="rail-firehose"
        className="pc-rail-firehose"
        titleId="rail-firehose-title"
        titleTag="h2"
      >
        <div className="pc-rail-hose" data-testid="rail-hose-lines">
          {firehose.map((line) => {
            const tone = firehoseTone(line);
            return (
              <div
                key={`${line.seq}-${line.event}-${line.taskId ?? line.runId ?? ""}`}
                className="pc-rail-hose__line"
                data-testid="rail-hose-line"
              >
                <span className="pc-rail-hose__time">
                  {formatTimeOfDay(line.at)}
                </span>
                <span
                  className={`pc-rail-hose__text pc-rail-hose__text--${tone}`}
                  title={line.text}
                >
                  {line.text}
                </span>
              </div>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}
