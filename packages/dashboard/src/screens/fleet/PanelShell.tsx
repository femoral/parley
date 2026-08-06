import type { ReactNode } from "react";
import type { PanelPhase } from "./panelHonesty.js";
import { panelMessage } from "./panelHonesty.js";

export function PanelShell({
  title,
  meta,
  phase,
  kind,
  children,
  testId,
  className = "",
  emptyAction,
}: {
  title: string;
  meta?: ReactNode;
  phase: PanelPhase;
  kind: string;
  children: ReactNode;
  testId: string;
  className?: string;
  emptyAction?: ReactNode;
}) {
  const showBody = phase === "live" || phase === "stale-reconnecting";
  const msg = panelMessage(phase, kind);

  return (
    <section
      className={`pc-fleet-panel ${className}`.trim()}
      data-testid={testId}
      data-phase={phase}
    >
      <header className="pc-fleet-panel__head">
        <span className="pc-fleet-panel__title">{title}</span>
        {meta != null ? <span className="pc-fleet-panel__meta">{meta}</span> : null}
      </header>
      {showBody ? (
        <div className="pc-fleet-panel__body">{children}</div>
      ) : (
        <div className="pc-fleet-panel__honesty" data-testid={`${testId}-honesty`}>
          <p className="pc-fleet-panel__honesty-msg">{msg}</p>
          {phase === "empty" && emptyAction ? emptyAction : null}
        </div>
      )}
      {phase === "stale-reconnecting" ? (
        <div className="pc-fleet-panel__stale" role="status">
          Reconnecting — showing last known data
        </div>
      ) : null}
    </section>
  );
}
