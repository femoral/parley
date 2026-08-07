import { useCallback } from "react";
import {
  useConsoleData,
  useHonesty,
  useRunners,
} from "../../data/index.js";
import type { ScreenMountProps } from "../types.js";
import { FleetBoard } from "./FleetBoard.js";
import "./fleet.css";

/**
 * Fleet board mount — #355 / #367 / #363.
 * Consumes the shell-owned client + snapshot/runs; only runners poll here.
 * Firehose lives on the right rail (shell); board center is tables + executors.
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

  const onSelectTask = useCallback(
    (id: string) => {
      props.setSelectedTaskId(id);
      props.navigate("task", id);
    },
    [props],
  );

  const onSelectRun = useCallback(
    (id: string) => {
      props.setSelectedRunId(id);
      props.navigate("run", id);
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
        selectedTaskId={props.selectedTaskId}
        selectedRunId={props.selectedRunId}
        onSelectTask={onSelectTask}
        onSelectRun={onSelectRun}
      />
    </div>
  );
}
