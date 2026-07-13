import type { BriefView } from "../types.js";

export interface BriefTabProps {
  brief: BriefView;
}

/**
 * Layer 2 — the Brief tab (design-manifest §4.17 "Brief"): branch/worktree +
 * model/effort + elapsed·usage key-value grid, the "📜 GOAL" well (the task's
 * prompt), the sandbox/network posture as constraint bullets, and the
 * standing footnote. Plain props only (contract 2).
 */
export function BriefTab({ brief }: BriefTabProps) {
  const elapsed = [brief.duration, brief.usage].filter(Boolean).join(" · ");
  return (
    <div className="pc-brief">
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
          📜 GOAL
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
      <p className="pc-brief__footnote">parley never merges — the branch waits for yer review.</p>
    </div>
  );
}
