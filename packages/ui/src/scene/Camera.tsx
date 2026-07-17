import type { ReactNode, TransitionEvent } from "react";

export interface CameraProps {
  /** World coordinates (px) of the region to centre in the viewport. */
  offsetX: number;
  offsetY: number;
  children: ReactNode;
  /**
   * Fires when the world's travel transform finishes (or is cancelled). The
   * Scene uses this as the sole signal to unmount the outgoing region — so
   * duration/easing stay owned by CSS (`.pc-world`), not duplicated in JS.
   */
  onTravelEnd?: () => void;
}

/**
 * Layer 3 — the camera (research doc's "camera is a transform on the world").
 * The oversized world plane is translated so the active region sits at viewport
 * centre; changing the offset animates via a CSS `transform` transition — a
 * finite "sail-over", zero JS per frame. The global reduced-motion rule zeroes
 * that transition, so the camera cuts instantly instead of gliding.
 */
export function Camera({ offsetX, offsetY, children, onTravelEnd }: CameraProps) {
  const handleTransitionEnd = (e: TransitionEvent<HTMLDivElement>) => {
    // Children can bubble their own transitions; only the world's transform
    // marks the end of a camera sail.
    if (e.target !== e.currentTarget) return;
    if (e.propertyName !== "transform") return;
    onTravelEnd?.();
  };

  return (
    <div
      className="pc-world"
      style={{ transform: `translate(${-offsetX}px, ${-offsetY}px)` }}
      onTransitionEnd={handleTransitionEnd}
    >
      {children}
    </div>
  );
}
