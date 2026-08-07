/**
 * Left rail content (#363): scope, state filter, token burn.
 * Coexists with the shell-owned find combobox above.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { OrchestratorSession, TaskEnvelope } from "@useparley/core";
import { Select } from "../components/index.js";
import {
  projectTokenBurn,
  useConsoleData,
  useHonesty,
  usePolling,
  type HonestyPhase,
  type TokenBurnView,
} from "../data/index.js";
import { formatTokens } from "./format.js";

export type StateFilterKey =
  | "all"
  | "awaiting_answer"
  | "stalled"
  | "failed"
  | "gate"
  | "running"
  | "queued";

const STATE_FILTERS: { key: StateFilterKey; label: string }[] = [
  { key: "all", label: "all" },
  { key: "awaiting_answer", label: "awaiting" },
  { key: "stalled", label: "stalled" },
  { key: "failed", label: "failed" },
  { key: "gate", label: "gate" },
  { key: "running", label: "running" },
  { key: "queued", label: "queued" },
];

export interface LeftRailProps {
  sessionId: string;
  onSessionChange: (id: string) => void;
  stateFilter: StateFilterKey;
  onStateFilterChange: (key: StateFilterKey) => void;
  /** Optional precomputed burn (tests). */
  tokenBurn?: TokenBurnView;
  nowMs?: number;
}

function quantizeNowMs(ms: number, quantumMs = 60_000): number {
  return Math.floor(ms / quantumMs) * quantumMs;
}

function burnPhaseFrom(
  global: HonestyPhase,
  totalsTasks: number,
): "loading" | "live" | "empty" | "offline" | "stale-reconnecting" {
  if (global === "loading" || global === "connecting") return "loading";
  if (global === "offline") return "offline";
  if (global === "stale-reconnecting") return "stale-reconnecting";
  if (totalsTasks === 0) return "empty";
  return "live";
}

function countByState(tasks: readonly TaskEnvelope[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of tasks) {
    out[t.state] = (out[t.state] ?? 0) + 1;
  }
  return out;
}

export function LeftRail({
  sessionId,
  onSessionChange,
  stateFilter,
  onStateFilterChange,
  tokenBurn,
  nowMs: nowMsProp,
}: LeftRailProps) {
  const { client, snapshot, health } = useConsoleData();
  const honesty = useHonesty({
    ready: snapshot.ready,
    streamConnected: snapshot.connected,
    healthOnline: health.online,
    streamLostSince: snapshot.streamLostSince,
    taskCount: snapshot.totalTasks,
  });

  const [sessions, setSessions] = useState<OrchestratorSession[]>([]);
  const [sessionsStatus, setSessionsStatus] = useState<
    "loading" | "live" | "error"
  >("loading");

  const [minuteTick, setMinuteTick] = useState(() => quantizeNowMs(Date.now()));
  usePolling(
    useCallback(() => {
      setMinuteTick(quantizeNowMs(Date.now()));
    }, []),
    { intervalMs: 60_000, enabled: nowMsProp == null, immediate: false },
  );
  const nowMs = nowMsProp != null ? nowMsProp : minuteTick;

  useEffect(() => {
    let cancelled = false;
    setSessionsStatus("loading");
    void client
      .listSessions()
      .then((res) => {
        if (cancelled) return;
        setSessions(res.sessions ?? []);
        setSessionsStatus("live");
      })
      .catch(() => {
        if (cancelled) return;
        setSessions([]);
        setSessionsStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [client, snapshot.seq]);

  const burn = useMemo(
    () => tokenBurn ?? projectTokenBurn(snapshot.tasks, { nowMs }),
    [tokenBurn, snapshot.tasks, nowMs],
  );

  const maxBurn = useMemo(() => {
    let m = 0;
    for (const b of burn.buckets) {
      const t = b.input + b.output;
      if (t > m) m = t;
    }
    return m;
  }, [burn.buckets]);

  const phase = burnPhaseFrom(honesty.phase, burn.totals.tasks);
  const stateCounts = useMemo(
    () => countByState(snapshot.tasks),
    [snapshot.tasks],
  );

  const retentionNote =
    burn.retentionSource === "default-assumed"
      ? `last 24h · sees tasks within retention (${burn.retentionDays}d assumed)`
      : `last 24h · sees tasks within retention (${burn.retentionDays}d)`;

  return (
    <div className="pc-rail-left" data-testid="rail-left-content">
      <section
        className="pc-rail-section"
        data-testid="rail-scope"
        aria-labelledby="rail-scope-title"
      >
        <header className="pc-rail-section__head">
          <h2 id="rail-scope-title" className="pc-rail-section__title">
            scope
          </h2>
          <span className="pc-rail-section__meta">orchestrator session</span>
        </header>
        {sessionsStatus === "error" ? (
          <p className="pc-rail-honesty" data-testid="rail-scope-error">
            Could not load sessions
          </p>
        ) : (
          <Select
            label="session"
            value={sessionId}
            onChange={onSessionChange}
            testId="rail-scope-select"
            aria-label="Orchestrator session scope"
          >
            <option value="all">All sessions</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id.length > 18 ? `${s.id.slice(0, 18)}…` : s.id}
                {s.task_count > 0 ? ` · ${s.task_count}` : ""}
              </option>
            ))}
          </Select>
        )}
        {sessionsStatus === "loading" ? (
          <p className="pc-rail-honesty pc-rail-honesty--quiet">
            Loading sessions…
          </p>
        ) : null}
      </section>

      <section
        className="pc-rail-section"
        data-testid="rail-state-filter"
        aria-labelledby="rail-state-title"
      >
        <header className="pc-rail-section__head">
          <h2 id="rail-state-title" className="pc-rail-section__title">
            state filter
          </h2>
          <span className="pc-rail-section__meta">
            {snapshot.totalTasks} tasks
          </span>
        </header>
        <div
          className="pc-rail-chips"
          role="group"
          aria-label="Filter by state"
        >
          {STATE_FILTERS.map(({ key, label }) => {
            const count =
              key === "all"
                ? snapshot.totalTasks
                : key === "gate"
                  ? undefined
                  : (stateCounts[key] ?? 0);
            const pressed = stateFilter === key;
            return (
              <button
                key={key}
                type="button"
                className={`pc-rail-chip${pressed ? " pc-rail-chip--on" : ""}`}
                aria-pressed={pressed}
                data-testid={`rail-state-${key}`}
                onClick={() => onStateFilterChange(key)}
              >
                <span className="pc-rail-chip__label">{label}</span>
                {count != null ? (
                  <span className="pc-rail-chip__count">{count}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      </section>

      <section
        className="pc-rail-section pc-rail-burn"
        data-testid="rail-token-burn"
        data-phase={phase}
        aria-labelledby="rail-burn-title"
      >
        <header className="pc-rail-section__head">
          <h2 id="rail-burn-title" className="pc-rail-section__title">
            token burn · 24h
          </h2>
        </header>
        <span className="pc-rail-burn__bound" data-testid="rail-burn-bound">
          {retentionNote}
        </span>
        {phase === "live" || phase === "stale-reconnecting" ? (
          <>
            <div className="pc-rail-burn__chart">
              {maxBurn > 0 ? (
                <div className="pc-rail-burn__axis" aria-hidden="true">
                  <span>{formatTokens(maxBurn)}</span>
                  <span>0</span>
                </div>
              ) : (
                <div className="pc-rail-burn__axis" aria-hidden="true" />
              )}
              <div
                className="pc-rail-burn__bars"
                role="img"
                aria-label={`Token burn histogram, max ${formatTokens(maxBurn)} tokens per hour`}
              >
                {burn.buckets.map((b, i) => {
                  const total = b.input + b.output;
                  const pct =
                    maxBurn > 0
                      ? Math.max(total > 0 ? 4 : 0, (total / maxBurn) * 100)
                      : 0;
                  const recent = i >= burn.buckets.length - 3;
                  return (
                    <div
                      key={b.hourStartMs}
                      className={`pc-rail-burn__bar${recent && total > 0 ? " pc-rail-burn__bar--hot" : ""}`}
                      style={{ height: `${pct}%` }}
                      title={`${new Date(b.hourStartMs).toISOString().slice(11, 16)} · in ${b.input} out ${b.output}`}
                    />
                  );
                })}
              </div>
            </div>
            <div className="pc-rail-burn__totals">
              <span>in {formatTokens(burn.totals.input)}</span>
              <span>out {formatTokens(burn.totals.output)}</span>
              <span>cached {formatTokens(burn.totals.cached)}</span>
            </div>
          </>
        ) : (
          <p className="pc-rail-honesty" data-testid="rail-burn-honesty">
            {phase === "empty"
              ? "No token activity in the last 24h (within retention)."
              : phase === "loading"
                ? "Loading token burn…"
                : "Token burn unavailable"}
          </p>
        )}
      </section>
    </div>
  );
}
