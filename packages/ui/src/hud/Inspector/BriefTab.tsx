import { useCallback, useEffect, useRef, useState } from "react";
import { Mark } from "../../primitives/index.js";
import { MARK_SCROLL } from "../../tokens/chrome-glyphs.js";
import { AttemptLineage } from "../AttemptLineage.js";
import type { AttemptLineageItem, BriefView } from "../types.js";

export interface BriefTabProps {
  brief: BriefView;
  /** Task id for the `parley fix` copy scaffold on failed tasks. */
  taskId: string;
  /** Terminal failure cause when the task is `failed` and carries an `error`;
   * null otherwise. Rendered as a coral-bordered well above the grid so the
   * wreck's cause is visible without spelunking raw logs. */
  error?: string | null;
  /** Full attempt chain (root → latest) for the lineage timeline (#166). */
  attempts?: AttemptLineageItem[];
}

/** Scaffold the orchestrator pastes into their session to re-brief a failed task. */
export function fixScaffold(taskId: string): string {
  return `parley fix ${taskId} "..."`;
}

function clipboardAvailable(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function";
}

/**
 * Layer 2 — the Brief tab (design-manifest §4.17 "Brief"): branch/worktree +
 * model/effort + elapsed·usage key-value grid, the scroll-marked GOAL well (the task's
 * prompt), the sandbox/network posture as constraint bullets, attempt lineage
 * (#166), and the standing footnote. When a failed task carries an `error`, a
 * coral-bordered "WHY IT FAILED" well leads so the cause is recognition, not
 * recall — with a read-only `parley fix` copy scaffold (mirrors InboxCard's
 * `parley answer` affordance). Plain props only (contract 2).
 */
export function BriefTab({ brief, taskId, error = null, attempts = [] }: BriefTabProps) {
  const elapsed = [brief.duration, brief.usage].filter(Boolean).join(" · ");
  const [copied, setCopied] = useState(false);
  const [canCopy, setCanCopy] = useState(true);
  const revertTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scaffoldRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    setCanCopy(clipboardAvailable());
    return () => {
      if (revertTimer.current) clearTimeout(revertTimer.current);
    };
  }, []);

  const markCopied = useCallback(() => {
    setCopied(true);
    if (revertTimer.current) clearTimeout(revertTimer.current);
    revertTimer.current = setTimeout(() => setCopied(false), 1500);
  }, []);

  const handleCopy = useCallback(async () => {
    const text = fixScaffold(taskId);
    if (clipboardAvailable()) {
      try {
        await navigator.clipboard.writeText(text);
        markCopied();
        return;
      } catch {
        // Fall through to select-on-click fallback.
      }
    }
    const el = scaffoldRef.current;
    if (el) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      markCopied();
    } else {
      setCanCopy(false);
    }
  }, [taskId, markCopied]);

  return (
    <div className="pc-brief">
      {error !== null && (
        <div className="pc-brief__well pc-brief__well--failed">
          <span className="pc-brief__well-label pc-brief__well-label--failed">
            WHY IT FAILED
          </span>
          <p className="pc-brief__error">{error}</p>
          <div className="pc-brief__fix-footer">
            <span className="pc-brief__fix-hint">
              Re-brief from your orchestrator — the cove stays watch-only.
            </span>
            {/* Hidden scaffold text for select-on-click fallback when clipboard fails. */}
            <span ref={scaffoldRef} className="pc-brief__fix-scaffold" aria-hidden="true">
              {fixScaffold(taskId)}
            </span>
            {canCopy && (
              <button
                type="button"
                className="pc-brief__fix-copy"
                onClick={handleCopy}
                aria-label={copied ? "Copied fix command" : "Copy fix command"}
              >
                {copied ? "copied ✓" : "copy"}
              </button>
            )}
          </div>
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
        <span className="pc-brief__well-head">
          <span className="pc-brief__well-label">
            <Mark mark={MARK_SCROLL} size={10} /> GOAL
          </span>
        </span>
        <p className="pc-brief__goal pc-brief__goal--excerpt">
          {brief.goal ?? "No brief filed — the orders never reached this ship."}
        </p>
        <button type="button" className="pc-brief__orders-open" popoverTarget="pc-brief-orders">
          Read full orders
        </button>
        <div id="pc-brief-orders" popover="auto" className="pc-brief__orders">
          <div className="pc-brief__orders-head">
            <span className="pc-brief__orders-title">
              <Mark mark={MARK_SCROLL} size={12} /> Standing Orders
            </span>
            <button
              type="button"
              className="pc-brief__orders-close"
              popoverTarget="pc-brief-orders"
              popoverTargetAction="hide"
              aria-label="Close full orders"
            >
              ✕
            </button>
          </div>
          <p className="pc-brief__orders-body">
            {brief.goal ?? "No brief filed — the orders never reached this ship."}
          </p>
        </div>
      </div>
      {(brief.sandbox !== null || brief.network !== null) && (
        <ul className="pc-brief__constraints">
          {brief.sandbox !== null && <li>Sandbox: {brief.sandbox}</li>}
          {brief.network !== null && <li>Network: {brief.network ? "enabled" : "disabled"}</li>}
        </ul>
      )}
      <AttemptLineage attempts={attempts} />
      <p className="pc-brief__footnote">
        Parley never merges on its own — the branch waits for your orchestrator to say the word.
      </p>
    </div>
  );
}
