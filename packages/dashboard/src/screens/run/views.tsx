/**
 * Three run visualizations: pipeline, iteration grid, node table.
 * Run outputs live outside this module (always-visible home in RunScreen).
 */
import type { NodeProjection, RunDetailResponse } from "@useparley/core";
import { fanWidthLabel, formatDuration, nodeAddress } from "./format.js";
import { projectNodeDisplay, type StateToken } from "./state.js";

function tokenClass(token: StateToken): string {
  return `pc-run__ink--${token}`;
}
function bgClass(token: StateToken): string {
  return `pc-run__bg--${token}`;
}

function tasksLabel(n: NodeProjection): string {
  if (n.kind === "gate") return "no tasks";
  if (n.tasks_total === 0) return "no tasks";
  const fan = n.fanout?.width;
  if (fan && fan > 1) {
    return `${n.tasks_settled}/${n.tasks_total} ×${fan}`;
  }
  if (n.tasks_settled === n.tasks_total) {
    return `${n.tasks_total} task${n.tasks_total === 1 ? "" : "s"}`;
  }
  return `${n.tasks_settled}/${n.tasks_total}`;
}

function extraLine(n: NodeProjection): string {
  if (n.on_reject) return `on_reject → ${n.on_reject}`;
  if (n.fanout && n.fanout.width > 1) {
    const kind = n.fanout.kind === "slots" ? "slots" : "data";
    return `fan-out ${n.fanout.width} ${kind}`;
  }
  if (n.kind === "gate") return "gate";
  return "single task";
}

function slotColors(n: NodeProjection, disp: ReturnType<typeof projectNodeDisplay>): string[] {
  const width = n.fanout?.width ?? 1;
  const failed = new Set(n.fanout?.failed ?? []);
  return Array.from({ length: Math.max(1, Math.min(width, 12)) }, (_, i) => {
    if (disp.emphasis === "held") return "var(--state-awaiting)";
    if (disp.token === "failed" || failed.has(String(i))) return "var(--state-failed)";
    if (disp.token === "completed") return "var(--state-completed)";
    if (disp.token === "running") return "var(--state-running)";
    return "var(--border)";
  });
}

/** Shared run-outputs summary text. */
export function projectRunOutputs(detail: RunDetailResponse): string {
  if (detail.run.state === "completed") return "sealed";
  if (detail.run.state === "failed") {
    return detail.run.error ? `failed — ${detail.run.error}` : "failed — incomplete";
  }
  if (detail.block ?? detail.run.block) return "held — awaiting advance";
  return "in progress";
}

export function RunOutputsCard({ detail }: { detail: RunDetailResponse }) {
  return (
    <div className="pc-run__outputs-home" data-testid="run-outputs">
      <span className="pc-run__outputs-label">run outputs</span>
      <span className="pc-run__outputs-body">{projectRunOutputs(detail)}</span>
    </div>
  );
}

export function PipelineView({ detail }: { detail: RunDetailResponse }) {
  const nodes = detail.nodes;
  const loopNote = buildLoopNote(detail);
  // Natural flex-wrap fills rows (≈3 cards at 1280, more at wider). No
  // flex-basis:100% breaker — that left every Nth card alone on a line.

  return (
    <div className="pc-run__pipeline" data-testid="run-pipeline">
      <div
        className="pc-run__pipeline-track"
        role="list"
        aria-label="Pipeline nodes"
        data-node-count={nodes.length}
      >
        {nodes.map((n, i) => {
          const disp = projectNodeDisplay(n);
          const cardMod =
            disp.emphasis === "held"
              ? "pc-run__node-card--held"
              : disp.emphasis === "failed"
                ? "pc-run__node-card--failed"
                : disp.emphasis === "pending" || disp.forkKind === "inherited"
                  ? "pc-run__node-card--pending"
                  : "";
          const forkMod = disp.forkKind === "inherited" ? " pc-run__node-card--inherited" : "";
          return (
            <div key={`${n.node}.${n.iteration}`} className="pc-run__pipe-item" role="listitem">
              {/* Always reserve leg width so every card is equal-width and
                  natural flex-wrap fills rows uniformly (MED N1). */}
              <div
                className={`pc-run__pipe-leg${disp.quiet ? " pc-run__pipe-leg--dim" : ""}`}
                aria-hidden="true"
              >
                {i > 0 ? <div className="pc-run__pipe-leg-line" /> : null}
              </div>
              <div
                className={`pc-run__node-card ${cardMod}${forkMod}`.trim()}
                data-node={n.node}
                data-state={n.state}
                data-fork={disp.forkKind ?? undefined}
              >
                <div className="pc-run__node-card-head">
                  <span className={`pc-run__node-kind ${tokenClass(disp.token)}`}>{n.kind}</span>
                  <span
                    className="pc-run__node-addr"
                    title={nodeAddress(n.node, n.iteration, { fan: n.fanout?.width })}
                  >
                    {n.iteration > 0 ? `${n.node}.${n.iteration}` : n.node}
                  </span>
                </div>
                <div className="pc-run__node-card-body">
                  <span
                    className={[
                      "pc-run__node-name",
                      disp.struck ? "pc-run__node-name--struck" : "",
                      disp.quiet ? "pc-run__node-name--quiet" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    title={n.node}
                  >
                    {n.node}
                  </span>
                  <div className="pc-run__state-row">
                    <span
                      className={`pc-run__dot ${bgClass(disp.token)}${disp.live ? " pc-run__dot--live" : ""}`}
                      aria-hidden="true"
                    />
                    {/* Fork: badge alone carries the vocabulary — omit cue/label double. */}
                    {disp.forkKind ? (
                      <span
                        className={`pc-run__fork-badge pc-run__fork-badge--${disp.forkKind}`}
                        title={
                          disp.forkKind === "inherited"
                            ? "Inherited from parent run"
                            : "Skipped on fork re-entry"
                        }
                      >
                        {disp.forkKind === "skipped" ? "skipped ⊘" : "inherited"}
                      </span>
                    ) : (
                      <>
                        <span className={`pc-run__state-label ${tokenClass(disp.token)}`}>
                          {disp.label}
                        </span>
                        {disp.cue ? <span className="pc-run__state-cue">{disp.cue}</span> : null}
                      </>
                    )}
                    <span className="pc-run__tasks-meta">{tasksLabel(n)}</span>
                  </div>
                  <div className="pc-run__slot-track" aria-hidden="true">
                    {slotColors(n, disp).map((c, si) => (
                      <span
                        key={si}
                        className="pc-run__slot-bar"
                        style={{ background: c }}
                      />
                    ))}
                  </div>
                  <span className="pc-run__gist" title={n.gist}>
                    {disp.forkKind
                      ? n.on_reject
                        ? `on_reject → ${n.on_reject}`
                        : "—"
                      : n.gist || "—"}
                    {!disp.forkKind && n.on_reject ? `  ·  on_reject → ${n.on_reject}` : ""}
                  </span>
                  <div className="pc-run__node-foot">
                    <span>{extraLine(n)}</span>
                    <span>
                      {formatDuration(
                        n.duration_ms,
                        n.state === "running" || n.state === "waiting",
                      )}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {nodes.length > 3 ? (
        <div className="pc-run__scroll-cue" data-testid="pipeline-scroll-cue">
          {nodes.length} nodes · wrapped
        </div>
      ) : null}
      {loopNote ? (
        <div className="pc-run__loop-note" data-testid="run-loop-note">
          <span className="pc-run__loop-label">loop</span>
          <span>{loopNote}</span>
        </div>
      ) : null}
    </div>
  );
}

function buildLoopNote(detail: RunDetailResponse): string | null {
  const block = detail.block ?? detail.run.block;
  if (block?.reason === "loop_exhausted") {
    return `budget exhausted · pass ${block.iteration ?? "?"} of ${block.max ?? "?"} · ${block.detail ?? ""}`.trim();
  }
  const maxIter = Math.max(0, ...detail.nodes.map((n) => n.iteration));
  if (maxIter <= 1 && detail.run.iteration <= 1) return null;
  return `iteration ${detail.run.iteration} · highest node pass ${maxIter}`;
}

/**
 * Iteration columns: include 0 when any node has iteration 0 (fork markers).
 * Live iterations remain 1..maxIter.
 */
export function iterationColumns(nodes: readonly NodeProjection[], runIteration: number): number[] {
  const maxIter = Math.max(1, runIteration, ...nodes.map((n) => n.iteration));
  const hasZero = nodes.some((n) => n.iteration === 0);
  const cols: number[] = [];
  if (hasZero) cols.push(0);
  for (let i = 1; i <= maxIter; i++) cols.push(i);
  return cols;
}

export function IterationGridView({ detail }: { detail: RunDetailResponse }) {
  const nodes = detail.nodes;
  const iters = iterationColumns(nodes, detail.run.iteration);
  const colCount = iters.length;

  const laneIds: string[] = [];
  const kindByNode = new Map<string, string>();
  const fanByNode = new Map<string, number>();
  for (const n of nodes) {
    if (!laneIds.includes(n.node)) laneIds.push(n.node);
    kindByNode.set(n.node, n.kind);
    if (n.fanout?.width) fanByNode.set(n.node, n.fanout.width);
  }

  return (
    <div className="pc-run__grid-wrap" data-testid="run-iteration-grid-wrap">
      <div
        className="pc-run__grid"
        data-testid="run-iteration-grid"
        style={{ ["--pc-run-iters" as string]: String(colCount) }}
        role="table"
        aria-label="Iteration grid"
      >
        <div className="pc-run__grid-row pc-run__grid-head" role="row">
          <div className="pc-run__grid-node pc-run__grid-node--head" role="columnheader">
            node
          </div>
          {iters.map((it) => (
            <div key={it} className="pc-run__grid-cell" role="columnheader">
              {it === 0 ? "fork · 0" : `iteration ${it}`}
            </div>
          ))}
        </div>
        {laneIds.map((nodeId) => {
          const fan = fanByNode.get(nodeId);
          const fanLabel = fanWidthLabel(fan);
          return (
            <div key={nodeId} className="pc-run__grid-row" role="row">
              <div className="pc-run__grid-node" role="rowheader">
                <span className="pc-run__grid-node-name" title={nodeId}>
                  {nodeId}
                </span>
                <span className="pc-run__grid-node-meta">
                  {kindByNode.get(nodeId) ?? "step"}
                  {fanLabel ? ` · fan-out ${fanLabel}` : ""}
                </span>
              </div>
              {iters.map((it) => {
                const n = nodes.find((x) => x.node === nodeId && x.iteration === it);
                if (!n) {
                  return (
                    <div
                      key={it}
                      className="pc-run__grid-cell pc-run__grid-cell--empty"
                      role="cell"
                    >
                      —
                    </div>
                  );
                }
                const disp = projectNodeDisplay(n);
                const cellMod =
                  disp.emphasis === "held"
                    ? "pc-run__grid-cell--held"
                    : disp.emphasis === "failed"
                      ? "pc-run__grid-cell--failed"
                      : disp.forkKind === "inherited"
                        ? "pc-run__grid-cell--inherited"
                        : "";
                return (
                  <div
                    key={it}
                    className={`pc-run__grid-cell ${cellMod}`.trim()}
                    role="cell"
                    data-state={n.state}
                    data-fork={disp.forkKind ?? undefined}
                  >
                    <div className="pc-run__state-row">
                      <span
                        className={`pc-run__dot ${bgClass(disp.token)}${disp.live ? " pc-run__dot--live" : ""}`}
                        aria-hidden="true"
                      />
                      {/* STATE names the wire state (INHERITED / SKIPPED); fork
                          shape stays on data-fork + cell class, not a second badge. */}
                      <span className={`pc-run__state-label ${tokenClass(disp.token)}`}>
                        {disp.label}
                        {disp.cue ?? ""}
                      </span>
                    </div>
                    {!disp.forkKind ? (
                      <span className="pc-run__gist" title={n.gist}>
                        {n.gist || "—"}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="pc-run__scroll-cue" data-testid="grid-scroll-cue" aria-hidden="true">
        scroll →
      </div>
    </div>
  );
}

export function NodeTableView({
  detail,
  selectedKey,
  onSelect,
}: {
  detail: RunDetailResponse;
  selectedKey: string | null;
  onSelect: (node: NodeProjection) => void;
}) {
  return (
    <div className="pc-run__table" data-testid="run-node-table" role="table" aria-label="Node table">
      <div className="pc-run__table-row pc-run__table-head" role="row">
        <div
          className="pc-run__table-cell pc-run__table-cell--dot"
          role="columnheader"
          aria-label="state"
        >
          <span className="pc-run__sr-only">state</span>
        </div>
        <div className="pc-run__table-cell" role="columnheader">
          node
        </div>
        <div className="pc-run__table-cell" role="columnheader">
          state
        </div>
        <div className="pc-run__table-cell" role="columnheader">
          tasks
        </div>
        <div className="pc-run__table-cell" role="columnheader">
          gist
        </div>
        <div className="pc-run__table-cell pc-run__table-cell--num" role="columnheader">
          duration
        </div>
      </div>
      {detail.nodes.map((n) => {
        const disp = projectNodeDisplay(n);
        const key = `${n.node}:${n.iteration}`;
        const selected = selectedKey === key;
        const fan = fanWidthLabel(n.fanout?.width);
        const addrSuffix = `${n.iteration > 0 ? `.${n.iteration}` : ""}${fan ? ` ${fan}` : ""}`;
        const tasksCell =
          n.kind === "gate"
            ? "—"
            : n.tasks_total === 0
              ? "—"
              : n.tasks_settled === n.tasks_total
                ? String(n.tasks_total)
                : `${n.tasks_settled}/${n.tasks_total}`;
        return (
          <div
            key={key}
            className={[
              "pc-run__table-row",
              "pc-run__table-row--interactive",
              disp.emphasis === "held" ? "pc-run__table-row--held" : "",
              selected ? "pc-run__table-row--selected" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            role="row"
            tabIndex={0}
            data-node={n.node}
            data-state={n.state}
            data-fork={disp.forkKind ?? undefined}
            data-selected={selected ? "true" : undefined}
            aria-selected={selected}
            onClick={() => onSelect(n)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(n);
              }
            }}
          >
            <div className="pc-run__table-cell pc-run__table-cell--dot" role="cell">
              <span
                className={`pc-run__dot ${bgClass(disp.token)}${disp.live ? " pc-run__dot--live" : ""}`}
                aria-hidden="true"
              />
            </div>
            <div className="pc-run__table-cell" role="cell">
              <span
                className={[
                  "pc-run__node-name",
                  disp.struck ? "pc-run__node-name--struck" : "",
                  disp.quiet ? "pc-run__node-name--quiet" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                title={n.node}
              >
                {n.node}
              </span>
              <span className="pc-run__tasks-meta"> {addrSuffix}</span>
              {disp.forkKind ? (
                <span
                  className={`pc-run__fork-badge pc-run__fork-badge--${disp.forkKind}`}
                  title={
                    disp.forkKind === "inherited"
                      ? "Inherited from parent run"
                      : "Skipped on fork re-entry"
                  }
                >
                  {disp.forkKind === "skipped" ? "skipped ⊘" : "inherited"}
                </span>
              ) : null}
            </div>
            <div className="pc-run__table-cell" role="cell">
              {/* STATE column always names the state (INHERITED / SKIPPED for
                  forks). Badge stays in the NODE column only. */}
              <span className={`pc-run__state-label ${tokenClass(disp.token)}`}>
                {disp.label}
                {disp.cue ?? ""}
              </span>
            </div>
            <div className="pc-run__table-cell" role="cell">
              {tasksCell}
            </div>
            <div className="pc-run__table-cell" role="cell" title={n.gist}>
              {disp.forkKind
                ? n.on_reject
                  ? `on_reject → ${n.on_reject}`
                  : "—"
                : n.gist || "—"}
              {!disp.forkKind && n.on_reject ? `  ·  on_reject → ${n.on_reject}` : ""}
            </div>
            <div className="pc-run__table-cell pc-run__table-cell--num" role="cell">
              {formatDuration(n.duration_ms, n.state === "running" || n.state === "waiting")}
            </div>
          </div>
        );
      })}
    </div>
  );
}
