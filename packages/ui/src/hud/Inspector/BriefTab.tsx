import { Mark } from "../../primitives/index.js";
import { MARK_SCROLL } from "../../tokens/chrome-glyphs.js";
import type { BriefView } from "../types.js";

export interface BriefTabProps {
  brief: BriefView;
  /** Terminal failure cause when the task is `failed` and carries an `error`;
   * null otherwise. Rendered as a coral-bordered well above the grid so the
   * wreck's cause is visible without spelunking raw logs. */
  error?: string | null;
}

/**
 * Layer 2 — the Brief tab (design-manifest §4.17 "Brief"): branch/worktree +
 * model/effort + elapsed·usage key-value grid, the scroll-marked GOAL well (the task's
 * prompt), the sandbox/network posture as constraint bullets, and the
 * standing footnote. When a failed task carries an `error`, a coral-bordered
 * "WHY IT FAILED" well leads so the cause is recognition, not recall. Plain
 * props only (contract 2).
 */
export function BriefTab({ brief, error = null }: BriefTabProps) {
  const elapsed = [brief.duration, brief.usage].filter(Boolean).join(" · ");
  return (
    <div className="pc-brief">
      {error !== null && (
        <div className="pc-brief__well pc-brief__well--failed">
          <span className="pc-brief__well-label pc-brief__well-label--failed">
            WHY IT FAILED
          </span>
          <p className="pc-brief__error">{error}</p>
        </div>
      )}
      <div className="pc-brief__grid">
        <span className="pc-brief__label">Branch</span>
        <span className="pc-brief__value pc-brief__value--mono-green">{brief.branch ?? "—"}</span>
        <span className="pc-brief__label">Worktree</span>
        <span className="pc-brief__value pc-brief__value--mono-green">{brief.worktree ?? "—"}</span>
        <span className="pc-brief__label">Model</span>
        <span className="pc-brief__value">
          {brief.model ?? "—"}
          {brief.effort ? ` · ${brief.effort}` : ""}
        </span>
        <span className="pc-brief__label">Elapsed</span>
        <span className="pc-brief__value">{elapsed || "—"}</span>
      </div>
      <div className="pc-brief__well">
        <span className="pc-brief__well-label" aria-hidden="true">
          <Mark mark={MARK_SCROLL} size={10} /> GOAL
        </span>
        <p className="pc-brief__goal">
          {brief.goal ?? "No brief filed — the orders never reached this ship."}
        </p>
      </div>
      {(brief.sandbox !== null || brief.network !== null) && (
        <ul className="pc-brief__constraints">
          {brief.sandbox !== null && <li>Sandbox: {brief.sandbox}</li>}
          {brief.network !== null && <li>Network: {brief.network ? "enabled" : "disabled"}</li>}
        </ul>
      )}
      <p className="pc-brief__footnote">
        Parley never merges on its own — the branch waits for your orchestrator to say the word.
      </p>
    </div>
  );
}
