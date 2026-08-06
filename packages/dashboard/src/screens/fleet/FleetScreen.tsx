import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ParleyClient } from "@useparley/core";
import {
  useHealth,
  useHonesty,
  useRunners,
  useRuns,
  useSnapshot,
} from "../../data/index.js";
import type { ScreenMountProps } from "../types.js";
import {
  advanceFirehose,
  emptyFirehoseCursor,
  type FirehoseCursor,
} from "./firehoseFeed.js";
import { FleetBoard } from "./FleetBoard.js";
import "./fleet.css";

function createClient(): ParleyClient {
  return new ParleyClient({ baseUrl: "" });
}

/**
 * Fleet board mount — #355.
 * Fetches its own data via the data-layer hooks; shell only passes selection.
 * All panels (KPIs, runs, tasks, burn, runners, firehose) render in the
 * center region — rails are shell-owned empty slots.
 */
export function FleetScreen(props: ScreenMountProps) {
  const client = useMemo(createClient, []);
  const snapshot = useSnapshot(client);
  const health = useHealth(client);
  const runs = useRuns(client, {
    selectedRunId: props.selectedRunId,
    enabled: true,
  });
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
