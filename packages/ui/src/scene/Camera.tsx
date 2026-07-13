import type { ReactNode } from "react";

export interface CameraProps {
  /** World coordinates (px) of the region to centre in the viewport. */
  offsetX: number;
  offsetY: number;
  children: ReactNode;
}

/**
 * Layer 3 — the camera (research doc's "camera is a transform on the world").
 * The oversized world plane is translated so the active region sits at viewport
 * centre; changing the offset animates via a CSS `transform` transition — a
 * finite "sail-over", zero JS per frame. The global reduced-motion rule zeroes
 * that transition, so the camera cuts instantly instead of gliding.
 */
export function Camera({ offsetX, offsetY, children }: CameraProps) {
  return (
    <div className="pc-world" style={{ transform: `translate(${-offsetX}px, ${-offsetY}px)` }}>
      {children}
    </div>
  );
}
