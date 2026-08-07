import { useCallback, useEffect, useRef, useState } from "react";
import {
  useConsoleData,
  useHonesty,
  useRunners,
} from "../../data/index.js";
import type { ScreenMountProps } from "../types.js";
import {
  advanceFirehose,
  emptyFirehoseCursor,
  type FirehoseCursor,
} from "./firehoseFeed.js";
import { FleetBoard } from "./FleetBoard.js";
import "./fleet.css";

/**
 * Fleet board mount — #355 / #367.
 * Consumes the shell-owned client + snapshot/runs; only runners poll here.
 */
export function FleetScreen(props: ScreenMountProps) {
  const { client, snapshot, health, runs } = useConsoleData();
  const runners = useRunners(client);
  const honesty = useHonesty({
    ready: snapshot.ready,
    streamConnected: snapshot.connected,
    healthOnline: health.online,
    streamLostSince: snapshot.streamLostSince,
    taskCount: snapshot.totalTasks,
  });

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

  const onSelectTask = useCallback(
    (id: string) => {
      props.setSelectedTaskId(id);
      props.navigate("task");
    },
    [props],
  );

  const onSelectRun = useCallback(
    (id: string) => {
      props.setSelectedRunId(id);
      props.navigate("run");
    },
    [props],
  );

  return (
    <div data-testid="screen-fleet" data-screen="fleet" className="pc-fleet-root">
      <FleetBoard
        tasks={snapshot.tasks}
        runs={runs.summaries}
        runners={runners.runners}
        runnersStatus={runners.status}
        runsStatus={runs.status}
        runsError={runs.error}
        honestyPhase={honesty.phase}
        firehose={firehose}
        selectedTaskId={props.selectedTaskId}
        selectedRunId={props.selectedRunId}
        onSelectTask={onSelectTask}
        onSelectRun={onSelectRun}
      />
    </div>
  );
}
