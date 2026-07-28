/**
 * Centre-stage run chart — a parchment sheet pinned to the sea (#253 / ADR-0021).
 *
 * One mark per (node, iteration); fan-out width written in a tally chip.
 * Gates are wax seals (held = whole + glow, actioned = cracked). Route
 * strokes are pen-weight only (Stroke-State Rule / #259). Cove never
 * actions a gate — the only control is Copy run id.
 */
import { useId, useMemo, type CSSProperties } from "react";
import { Button } from "../primitives/index.js";
import type { InspectorRun } from "../hud/types.js";
import { useCopyScaffold } from "../hud/useCopyScaffold.js";
import {
  projectChart,
  CHART_VB_W,
  type ChartMark,
  type ChartReadyModel,
} from "./projectChart.js";
import "./chart.css";

export interface RunChartProps {
  /** Same projection the inspector run view consumes — no parallel fetch. */
  run: InspectorRun;
}

function CopyRunId({ runId }: { runId: string }) {
  const { copied, canCopy, scaffoldRef, copy } = useCopyScaffold(runId);
  if (!canCopy) return null;
  return (
    <>
      <span ref={scaffoldRef} className="pc-chart-helm__id-scaffold" aria-hidden="true">
        {runId}
      </span>
      <Button
        type="button"
        variant="secondary"
        title={copied ? "Copied run id" : `Copy run id ${runId}`}
        aria-label={copied ? "Copied run id" : "Copy run id"}
        onClick={() => void copy()}
      >
        {copied ? "Copied" : "Copy run id"}
      </Button>
    </>
  );
}

function MarkNode({ mark, vbH }: { mark: ChartMark; vbH: number }) {
  const left = `${(mark.x / CHART_VB_W) * 100}%`;
  const top = `${(mark.y / vbH) * 100}%`;
  // ViewBox units → CSS cqw on the sheet (not % of the 0-wide mark pin).
  const labelStyle = {
    left,
    top,
    ["--pc-chart-label-vb"]: String(mark.labelWidth),
  } as CSSProperties;
  const sideClass = "pc-chart-mark--below";

  if (mark.seal) {
    return (
      <div
        className={`pc-chart-seal pc-chart-seal--${mark.seal} ${sideClass}`}
        style={labelStyle}
        data-chart-mark={mark.key}
        data-node={mark.node}
        data-kind="gate"
        data-seal={mark.seal}
        data-iteration={mark.iteration}
        data-label-side={mark.labelSide}
      >
        <div className="pc-chart-seal__wax" aria-hidden="true">
          {mark.seal === "held" ? "🗝" : "⚑"}
          {mark.seal === "broken" && <span className="pc-chart-seal__crack" />}
        </div>
        <div className="pc-chart-seal__labels">
          <div className="pc-chart-seal__name">{mark.name}</div>
          <div className="pc-chart-seal__meta">{mark.meta}</div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`pc-chart-mark ${mark.className} ${sideClass}`}
      style={labelStyle}
      data-chart-mark={mark.key}
      data-node={mark.node}
      data-kind="step"
      data-ink={mark.ink}
      data-iteration={mark.iteration}
      data-fanout={mark.fanoutWidth ?? undefined}
      data-label-side={mark.labelSide}
    >
      <div className="pc-chart-mark__ring" aria-hidden="true">
        <span className="pc-chart-mark__glyph">{mark.glyph}</span>
      </div>
      <div className="pc-chart-mark__labels">
        <div className="pc-chart-mark__name">{mark.name}</div>
        <div className="pc-chart-mark__meta">{mark.meta}</div>
        {mark.fanoutWidth != null && mark.fanoutWidth > 1 && (
          <div className="pc-chart-tally" data-tally={mark.fanoutWidth}>
            ×{mark.fanoutWidth}
          </div>
        )}
      </div>
    </div>
  );
}

function ChartKey() {
  return (
    <div className="pc-chart-key" aria-hidden="true">
      <div className="pc-chart-key__row pc-chart-key__row--done">
        <span className="pc-chart-key__swatch" />
        <span className="pc-chart-key__label">✓ sailed</span>
      </div>
      <div className="pc-chart-key__row pc-chart-key__row--live">
        <span className="pc-chart-key__swatch" />
        <span className="pc-chart-key__label">✦ under way</span>
      </div>
      <div className="pc-chart-key__row pc-chart-key__row--ghost">
        <span className="pc-chart-key__swatch" />
        <span className="pc-chart-key__label">? ahead</span>
      </div>
      <div className="pc-chart-key__row pc-chart-key__row--fail">
        <span className="pc-chart-key__swatch" />
        <span className="pc-chart-key__label">✕ blotted</span>
      </div>
    </div>
  );
}

function RouteSvg({ model, markerId }: { model: ChartReadyModel; markerId: string }) {
  return (
    <svg
      className="pc-chart__svg pc-chart__svg--route"
      viewBox={`0 0 ${CHART_VB_W} ${model.vbH}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <marker
          id={markerId}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0,1 L9,5 L0,9 z" fill="var(--ink-chart-soft)" />
        </marker>
      </defs>

      {/* Route legs — pen weight only (Stroke-State Rule). */}
      {model.legs.map((leg, i) => (
        <path
          key={`leg-${i}`}
          d={leg.d}
          fill="none"
          strokeLinecap="round"
          strokeDasharray="1.5 9"
          strokeWidth={leg.pen === "soft" ? 3.5 : 4.5}
          stroke={leg.pen === "soft" ? "var(--ink-chart-soft)" : "var(--ink-chart)"}
          data-chart-leg={leg.pen}
        />
      ))}

      {/* Loop-backs — longer dash, arc over the route, arrowhead clear of mark. */}
      {model.loopBacks.map((lb) => (
        <path
          key={`loop-${lb.fromKey}-${lb.toKey}`}
          d={lb.d}
          fill="none"
          stroke="var(--ink-chart-soft)"
          strokeWidth="2.5"
          strokeDasharray="12 9"
          markerEnd={`url(#${markerId})`}
          opacity="0.85"
          data-chart-loop={`${lb.fromKey}->${lb.toKey}`}
          data-loop-end-x={lb.end.x.toFixed(1)}
          data-loop-end-y={lb.end.y.toFixed(1)}
          data-loop-target-x={lb.targetCentre.x.toFixed(1)}
          data-loop-target-y={lb.targetCentre.y.toFixed(1)}
        />
      ))}
    </svg>
  );
}

/** Compass rose — own box so the sheet aspect never shears it (N2). */
function CompassRose({ sparse }: { sparse: boolean }) {
  return (
    <div
      className={`pc-chart-compass${sparse ? " pc-chart-compass--sparse" : ""}`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
        <g
          transform="translate(50,50)"
          stroke="var(--ink-chart)"
          fill="none"
          opacity="0.8"
        >
          <circle r="40" strokeWidth="1.2" opacity="0.7" />
          <circle r="28" strokeWidth="0.7" opacity="0.45" />
          <path
            d="M0,-40 L8,-8 L40,0 L8,8 L0,40 L-8,8 L-40,0 L-8,-8 Z"
            fill="var(--ink-chart)"
            opacity="0.78"
            stroke="none"
          />
          <path
            d="M0,-28 L3.5,-3.5 L28,0 L3.5,3.5 L0,28 L-3.5,3.5 L-28,0 L-3.5,-3.5 Z"
            fill="var(--parchment-bg)"
            opacity="0.5"
            stroke="none"
          />
        </g>
      </svg>
    </div>
  );
}

function ReadyChart({ model }: { model: ChartReadyModel }) {
  const markerId = useId().replace(/:/g, "");
  const markCount = model.marks.length;

  // Empty ready run: single title + honesty copy — no second run-id overlay (N7).
  if (markCount === 0) {
    return (
      <div
        className="pc-chart__sheet pc-chart__sheet--sparse"
        data-chart-status="ready"
        data-mark-count="0"
        data-decorations="sparse"
      >
        <header className="pc-chart__legend">
          <h2 className="pc-chart__title">
            {model.workflow}
            <span className="pc-chart__run-id"> · run {model.shortId}</span>
          </h2>
          {model.metaLine && <p className="pc-chart__meta-line">{model.metaLine}</p>}
          {model.flavor && <p className="pc-chart__flavor">{model.flavor}</p>}
        </header>
        <div className="pc-chart__empty pc-chart__empty--inline">
          <p className="pc-chart__empty-copy">No nodes entered yet.</p>
          <div className="pc-chart__empty-actions">
            <CopyRunId runId={model.id} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`pc-chart__sheet${model.decorations === "sparse" ? " pc-chart__sheet--sparse" : ""}${model.heldGate ? " pc-chart__sheet--held" : ""}`}
      data-chart-status="ready"
      data-mark-count={markCount}
      data-decorations={model.decorations}
      data-held-gate={model.heldGate ? "true" : undefined}
      style={{ aspectRatio: `${CHART_VB_W} / ${model.vbH}` }}
    >
      <RouteSvg model={model} markerId={`pc-chart-tip-${markerId}`} />
      <CompassRose sparse={model.decorations === "sparse"} />

      {model.decorations === "full" && (
        <svg
          className="pc-chart__svg pc-chart__svg--decor"
          viewBox={`0 0 ${CHART_VB_W} ${model.vbH}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <g stroke="var(--ink-chart-ghost)" strokeWidth="0.7" opacity="0.35">
            <path d="M880,96 L660,20" />
            <path d="M880,96 L1000,24" />
            <path d="M880,96 L640,260" />
            <path d="M880,96 L1000,270" />
            <path d="M880,96 L780,150" />
          </g>
          <g
            className="pc-chart__decor-serpent"
            transform="translate(140,130)"
            stroke="var(--ink-chart-soft)"
            fill="none"
            strokeWidth="2"
            opacity="0.4"
            strokeLinecap="round"
          >
            <path d="M0,40 q22,-26 44,0 t44,0 t44,0" />
            <path d="M132,40 q14,-18 26,-6 q-10,4 -12,12" />
            <circle cx="150" cy="30" r="1.8" fill="var(--ink-chart-soft)" />
          </g>
        </svg>
      )}

      <header className="pc-chart__legend">
        <h2 className="pc-chart__title">
          {model.workflow}
          <span className="pc-chart__run-id"> · run {model.shortId}</span>
        </h2>
        {model.metaLine && <p className="pc-chart__meta-line">{model.metaLine}</p>}
        {model.flavor && <p className="pc-chart__flavor">{model.flavor}</p>}
      </header>

      {model.marks.map((mark) => (
        <MarkNode key={mark.key} mark={mark} vbH={model.vbH} />
      ))}

      <div
        className="pc-chart-spot"
        style={{
          left: `${(model.destination.x / CHART_VB_W) * 100}%`,
          top: `${(model.destination.y / model.vbH) * 100}%`,
        }}
        data-chart-destination=""
      >
        <div className="pc-chart-spot__x" aria-hidden="true">
          ✕
        </div>
        <div className="pc-chart-spot__label">the run ends here</div>
      </div>

      {model.decorations === "full" && (
        <>
          <div
            className="pc-chart-marginalia pc-chart-marginalia--tilt"
            style={{ left: "58%", top: "14%" }}
          >
            &ldquo;if the reviewers dissent, sail it back&rdquo;
          </div>
          <div className="pc-chart-marginalia" style={{ left: "18%", top: "22%" }}>
            here be regressions
          </div>
        </>
      )}

      <ChartKey />

      {model.heldGate && (
        <div className="pc-chart-helm" role="status">
          <span className="pc-chart-helm__mark" aria-hidden="true">
            ⎈
          </span>
          <div className="pc-chart-helm__body">
            <p className="pc-chart-helm__label">Held — awaiting the orchestrator</p>
            <p className="pc-chart-helm__note">
              Cove shows the gate; approve, reject, redirect, and finish belong
              to the agent driving the session.
            </p>
          </div>
          <div className="pc-chart-helm__actions">
            <CopyRunId runId={model.id} />
          </div>
        </div>
      )}
    </div>
  );
}

function PendingChart({ id, shortId }: { id: string; shortId: string }) {
  return (
    <div className="pc-chart__sheet pc-chart__sheet--sparse" data-chart-status="pending">
      <div className="pc-chart__empty">
        <p className="pc-chart__empty-title">
          <span className="pc-chart__run-id">run {shortId}</span>
        </p>
        <p className="pc-chart__empty-copy">Hailing the run…</p>
        <div className="pc-chart__empty-actions">
          <CopyRunId runId={id} />
        </div>
      </div>
    </div>
  );
}

/**
 * Parchment chart for a selected run. Replaces the sailing scene in the
 * centre stage; shares no layout key with the island scatter.
 */
export function RunChart({ run }: RunChartProps) {
  const model = useMemo(() => projectChart(run), [run]);

  return (
    <div className="pc-chart" data-testid="run-chart">
      <div
        className="pc-chart__scroll"
        role="region"
        aria-label="Run chart"
        tabIndex={0}
      >
        {model.status === "pending" ? (
          <PendingChart id={model.id} shortId={model.shortId} />
        ) : (
          <ReadyChart model={model} />
        )}
      </div>
    </div>
  );
}
