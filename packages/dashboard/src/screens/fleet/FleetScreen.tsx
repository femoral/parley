import { useCallback } from "react";
import {
  useConsoleData,
  useHonesty,
  useRunners,
} from "../../data/index.js";
import type { ScreenMountProps } from "../types.js";
import { FleetBoard } from "./FleetBoard.js";
import { useFleetPage } from "../../data/useFleetPage.js";
import { PageControls } from "../../components/PageControls.js";
import "./fleet.css";

/**
 * Fleet board mount — #355 / #367 / #363.
 * Consumes the shell-owned client + snapshot/runs; only runners poll here.
 * Firehose lives on the right rail (shell); board center is tables + executors.
 */
export function FleetScreen(props: ScreenMountProps) {
  const { client, snapshot, health, fleet } = useConsoleData();
  const options = { session: fleet?.session ?? "all", state: fleet?.state ?? "all" };
  const tasks = useFleetPage(client, "tasks", options);
  const runs = useFleetPage(client, "runs", options);
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
        tasks={tasks.items}
        runs={runs.items}
        paginated
        summary={fleet?.summary}
        taskControls={<PageControls label="tasks" page={tasks} />}
        runControls={<PageControls label="runs" page={runs} />}
        tasksLoading={tasks.loading && tasks.total === null}
        tasksError={tasks.error}
        runners={runners.runners}
        runnersStatus={runners.status}
        runsStatus={runs.loading && runs.total === null ? "connecting" : "online"}
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
