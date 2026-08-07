/**
 * Shared Panel — header strip (uppercase label + faint meta) + content.
 * DESIGN.md panel shape; single implementation for all four screens (#367).
 */
import type { ReactNode } from "react";

export type PanelHonestyPhase =
  | "loading"
  | "live"
  | "empty"
  | "offline"
  | "stale-reconnecting"
  | "error";

export interface PanelProps {
  title: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
  className?: string;
  headClassName?: string;
  bodyClassName?: string;
  testId?: string;
  /** id on the title element (aria-labelledby targets). */
  titleId?: string;
  titleTag?: "span" | "h2";
  "aria-label"?: string;
  "aria-labelledby"?: string;
  /**
   * When set (and not live/stale-reconnecting), body is replaced by an honesty
   * message. Screens that manage honesty themselves leave this unset.
   */
  phase?: PanelHonestyPhase;
  /** Noun for honesty copy ("runs", "tasks", …). Required when phase is set. */
  honestyKind?: string;
  honestyMessage?: string;
  emptyAction?: ReactNode;
}

export function panelHonestyMessage(phase: PanelHonestyPhase, kind: string): string {
  switch (phase) {
    case "loading":
      return `Hailing the ${kind}…`;
    case "offline":
      return `Daemon offline — ${kind} unavailable`;
    case "stale-reconnecting":
      return `Reconnecting — last known ${kind}`;
    case "error":
      return `Could not load ${kind}`;
    case "empty":
      if (kind === "fleet") {
        return "No tasks yet. Copy a scaffold to start work.";
      }
      if (kind === "events") return "No events since connect";
      return `No ${kind}`;
    default:
      return "";
  }
}

export function Panel({
  title,
  meta,
  children,
  className = "",
  headClassName = "",
  bodyClassName = "",
  testId,
  titleId,
  titleTag = "span",
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  phase,
  honestyKind,
  honestyMessage,
  emptyAction,
}: PanelProps) {
  const TitleTag = titleTag;
  const managed = phase != null;
  const showBody = !managed || phase === "live" || phase === "stale-reconnecting";
  const msg =
    honestyMessage ??
    (managed && honestyKind ? panelHonestyMessage(phase, honestyKind) : "");

  return (
    <section
      className={`pc-panel ${className}`.trim()}
      data-testid={testId}
      data-phase={phase}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
    >
      <header className={`pc-panel__head ${headClassName}`.trim()}>
        <TitleTag id={titleId} className="pc-panel__title">
          {title}
        </TitleTag>
        {meta != null ? <span className="pc-panel__meta">{meta}</span> : null}
      </header>
      {showBody ? (
        <div className={`pc-panel__body ${bodyClassName}`.trim()}>{children}</div>
      ) : (
        <div
          className="pc-panel__honesty"
          data-testid={testId ? `${testId}-honesty` : undefined}
        >
          <p className="pc-panel__honesty-msg">{msg}</p>
          {phase === "empty" && emptyAction ? emptyAction : null}
        </div>
      )}
      {phase === "stale-reconnecting" ? (
        <div className="pc-panel__stale" role="status">
          Reconnecting — showing last known data
        </div>
      ) : null}
    </section>
  );
}
