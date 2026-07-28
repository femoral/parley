/**
 * Inspector run view — one line per (node, iteration), matching
 * `parley run status <run>` plus a state-carrying spine (#254 / ADR-0021).
 *
 * #255 adds fork STATE vocabulary (inherited quiet / skipped loud) and the
 * kind-aware deliverable stack under the table.
 *
 * Deliberately close to docs/arch/222-query-surface-prototype/02-run-summary.txt;
 * that closeness is a feature. No gate verbs — Cove surfaces a held gate, it
 * never actions one.
 */
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type UIEvent,
} from "react";
import { Mark } from "../../primitives/index.js";
import { STATE_META, stateMetaFor } from "../../tokens/state-meta.js";
import { useCopyScaffold } from "../useCopyScaffold.js";
import type { InspectorRun, InspectorRunNode, InspectorRunReady } from "../types.js";
import { DeliverableView } from "./DeliverableView.js";

function shortRef(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function RunIdCopy({ runId }: { runId: string }) {
  const { copied, canCopy, scaffoldRef, copy } = useCopyScaffold(runId);
  if (!canCopy) return null;
  return (
    <>
      <span ref={scaffoldRef} className="pc-inspector__id-scaffold" aria-hidden="true">
        {runId}
      </span>
      <button
        type="button"
        className="pc-inspector__id-copy"
        title={copied ? "Copied run id" : `Copy run id ${runId}`}
        aria-label={copied ? "Copied run id" : "Copy run id"}
        onClick={() => void copy()}
      >
        {copied ? "copied ✓" : "copy"}
      </button>
    </>
  );
}

function SpineCell({ node }: { node: InspectorRunNode }) {
  const meta = stateMetaFor(node.spineState);
  const style = {
    "--spine-color": meta.colorVar,
  } as CSSProperties;
  const fan = node.fanoutWidth != null && node.fanoutWidth > 1;
  return (
    <td className="pc-runview__rail">
      <span
        className={`pc-runview__spine${fan ? " pc-runview__spine--fan" : ""}${
          node.live ? " pc-runview__spine--live" : ""
        }`}
        style={style}
        aria-hidden="true"
      >
        <span className="pc-runview__spine-knot" />
      </span>
    </td>
  );
}

/**
 * STATE column — fork vocabulary is asymmetric (#255 / F7):
 * - `inherited` quiet: strike-through + archive ink + cancelled mark
 * - `skipped` loud: coral + failed mark + "!" cue (non-colour carrier)
 * Colour is never the only difference between the two.
 */
function StateCell({ node }: { node: InspectorRunNode }) {
  if (node.state === "inherited") {
    return (
      <td>
        <span
          className="pc-runview__st pc-runview__st--inherited"
          data-fork="inherited"
          title="inherited — value copied at iteration 0"
        >
          <span className="pc-runview__st-mark" aria-hidden="true">
            <Mark mark={STATE_META.cancelled.mark} size={10} />
          </span>
          <span className="pc-runview__st-label">{node.stateLabel}</span>
        </span>
      </td>
    );
  }
  if (node.state === "skipped") {
    return (
      <td>
        <span
          className="pc-runview__st pc-runview__st--skipped"
          data-fork="skipped"
          title="skipped — a human approval was discarded by this fork"
        >
          <span className="pc-runview__st-mark" aria-hidden="true">
            <Mark mark={STATE_META.failed.mark} size={10} />
          </span>
          <span className="pc-runview__st-label">{node.stateLabel}</span>
          <span className="pc-runview__st-cue" aria-hidden="true">
            !
          </span>
        </span>
      </td>
    );
  }

  const meta = stateMetaFor(node.spineState);
  const style = { "--st-color": meta.colorVar } as CSSProperties;
  return (
    <td>
      <span className="pc-runview__st" style={style} title={node.stateLabel}>
        <span className="pc-runview__st-mark" aria-hidden="true">
          <Mark mark={meta.mark} size={10} />
        </span>
        {node.stateLabel}
      </span>
    </td>
  );
}

function NodeRow({ node }: { node: InspectorRunNode }) {
  const rowClass = [
    node.live ? "pc-runview__row--live" : "",
    node.state === "inherited" ? "pc-runview__row--inherited" : "",
    node.state === "skipped" ? "pc-runview__row--skipped" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <tr className={rowClass || undefined}>
      <SpineCell node={node} />
      <td className="pc-runview__node">
        {node.node}
        {node.fanoutWidth != null && node.fanoutWidth > 1 && (
          <span className="pc-runview__fan"> ×{node.fanoutWidth}</span>
        )}
        {node.iteration > 1 && (
          <span className="pc-runview__iter"> .{node.iteration}</span>
        )}
      </td>
      <StateCell node={node} />
      <td className="pc-runview__tasks">{node.tasksLabel}</td>
      <td className="pc-runview__gist">
        {node.gist}
        {node.onReject && (
          <span className="pc-runview__reject"> on_reject → {node.onReject}</span>
        )}
        {node.state === "skipped" && node.kind === "gate" && (
          <span className="pc-runview__skip-note">
            {" "}
            a human approval was discarded by this fork
          </span>
        )}
      </td>
      <td className="pc-runview__age">{node.age ?? "—"}</td>
    </tr>
  );
}

function tableCanScrollMore(el: HTMLElement): boolean {
  // Integer scroll metrics can land 1px short of max; treat near-end as end.
  return el.scrollLeft < el.scrollWidth - el.clientWidth - 1;
}

function ReadyRunView({ run }: { run: InspectorRunReady }) {
  const short = shortRef(run.id);
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const [fadeVisible, setFadeVisible] = useState(false);

  const syncFade = useCallback(() => {
    const el = tableWrapRef.current;
    if (!el) {
      setFadeVisible(false);
      return;
    }
    setFadeVisible(tableCanScrollMore(el));
  }, []);

  useLayoutEffect(() => {
    syncFade();
  }, [syncFade, run.nodes]);

  useLayoutEffect(() => {
    const el = tableWrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => syncFade());
    ro.observe(el);
    return () => ro.disconnect();
  }, [syncFade, run.nodes.length]);

  const onTableScroll = useCallback(
    (_event: UIEvent<HTMLDivElement>) => {
      syncFade();
    },
    [syncFade],
  );

  return (
    <div className="pc-runview">
      <header className="pc-runview__head">
        <div className="pc-runview__titles">
          <h2 className="pc-runview__title">
            {run.workflow}
            <span className="pc-runview__run-id"> · run {short}</span>
          </h2>
          <p className="pc-runview__sub">
            {run.tasksTotal === 1 ? "1 task" : `${run.tasksTotal} tasks`}
            {run.nodes.length > 0 && (
              <>
                {" · "}
                {run.nodes.length === 1
                  ? "1 line"
                  : `${run.nodes.length} lines`}
              </>
            )}
            {run.branch && (
              <>
                {" · "}
                <span className="pc-runview__branch" title={run.branch}>
                  {run.branch}
                </span>
              </>
            )}
          </p>
        </div>
        <div className="pc-runview__aside">
          <span className="pc-runview__state">{run.stateLabel}</span>
          {run.duration && <span className="pc-runview__dur">{run.duration}</span>}
          <RunIdCopy runId={run.id} />
        </div>
      </header>

      {run.heldGate && (
        <div className="pc-runview__helm" role="status">
          <span className="pc-runview__helm-mark" aria-hidden="true">
            ⎈
          </span>
          <p className="pc-runview__helm-text">
            <strong>Held — awaiting the orchestrator.</strong> Cove shows the
            gate; approve, reject, redirect, and finish belong to the agent
            driving the session.
          </p>
        </div>
      )}

      {run.block && !run.heldGate && run.block.detail && (
        <p className="pc-runview__block" role="status">
          {run.block.detail}
        </p>
      )}

      {run.nodes.length === 0 ? (
        <p className="pc-runview__empty">No nodes entered yet.</p>
      ) : (
        <div className="pc-runview__table-scroller">
          <div
            ref={tableWrapRef}
            className="pc-runview__table-wrap"
            role="region"
            aria-label="Run node table"
            tabIndex={0}
            onScroll={onTableScroll}
          >
            <table className="pc-runview__table">
              <thead>
                <tr>
                  <th className="pc-runview__rail" scope="col">
                    <span className="pc-visually-hidden">Sequence</span>
                  </th>
                  <th scope="col">Node</th>
                  <th scope="col">State</th>
                  <th scope="col">Tasks</th>
                  <th scope="col">Gist</th>
                  <th scope="col">Age</th>
                </tr>
              </thead>
              <tbody>
                {run.nodes.map((node) => (
                  <NodeRow key={node.key} node={node} />
                ))}
              </tbody>
            </table>
          </div>
          <div
            className="pc-runview__table-fade"
            aria-hidden="true"
            hidden={!fadeVisible}
          />
        </div>
      )}

      <DeliverableView deliverables={run.deliverables} />
    </div>
  );
}

export function RunView({ run }: { run: InspectorRun }) {
  if (run.status === "pending") {
    const short = shortRef(run.id);
    return (
      <div className="pc-runview">
        <header className="pc-runview__head">
          <div className="pc-runview__titles">
            <h2 className="pc-runview__title">
              <span className="pc-runview__run-id">run {short}</span>
            </h2>
          </div>
          <div className="pc-runview__aside">
            <RunIdCopy runId={run.id} />
          </div>
        </header>
        <p className="pc-runview__empty">Hailing the run…</p>
      </div>
    );
  }

  return <ReadyRunView run={run} />;
}
