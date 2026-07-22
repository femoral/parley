export type SceneLoopMode = "active" | "ambient" | "idle";

/**
 * Opacity for a canvas island sprite under `.pc-island__rise`.
 *
 * The CSS rise/sink keyframes drive opacity; the backdrop painter must match
 * that value so feathered sprites fade with the DOM. Reading
 * `getComputedStyle` every frame forces a style flush per island — expensive
 * during camera travel when every island is repainted but almost none are
 * mid-animation.
 *
 * Strategy (read-path only; visual continuity with CSS):
 * - Settled cancelled islands (`data-death="settled"`) are statically opacity 0.
 * - Only sample computed style while this rise node has a *running* (or paused)
 *   animation — the intermediate frames of rise/sink.
 * - A finished sink (fill forwards, before React flips to settled) is 0.
 * - Finished rise (`both` fill) and non-animating islands are 1.
 */
export function islandRiseOpacity(rise: Element | null): number {
  if (!rise) return 1;
  const island = rise.closest(".pc-island");
  if (island?.getAttribute("data-death") === "settled") return 0;

  const el = rise as HTMLElement;
  if (typeof el.getAnimations === "function") {
    let finishedSink = false;
    for (const animation of el.getAnimations()) {
      if (animation.playState === "running" || animation.playState === "paused") {
        return readComputedOpacity(el);
      }
      if (animation.playState === "finished" && isSinkAnimation(animation)) {
        finishedSink = true;
      }
    }
    if (finishedSink) return 0;
    return 1;
  }

  // No WAAPI (older engines / some test DOMs) — fall back to computed style.
  return readComputedOpacity(el);
}

function isSinkAnimation(animation: Animation): boolean {
  // CSSAnimation.animationName is the CSS identifier (e.g. pc-island-sink).
  const name =
    "animationName" in animation && typeof (animation as { animationName?: unknown }).animationName === "string"
      ? (animation as { animationName: string }).animationName
      : "";
  return name.includes("sink");
}

function readComputedOpacity(element: Element): number {
  const opacity = Number.parseFloat(getComputedStyle(element).opacity || "1");
  return Number.isFinite(opacity) ? opacity : 1;
}

/** Pure scheduling policy, split out so wake/idle behaviour is deterministic in tests. */
export class SceneLoopGate {
  private requested = true;
  mode: SceneLoopMode = "active";

  wake(): boolean {
    const wasSleeping = !this.requested;
    this.requested = true;
    return wasSleeping;
  }

  consume(): void {
    this.requested = false;
  }

  settle(input: { active: boolean; reducedMotion: boolean }): SceneLoopMode {
    this.mode = input.active ? "active" : input.reducedMotion ? "idle" : "ambient";
    return this.mode;
  }

  get sleeping(): boolean {
    return !this.requested && this.mode === "idle";
  }
}

/** Layout measurements survive frames and are dropped together on observed layout changes. */
export class GeometryCache {
  private readonly rects = new Map<Element, DOMRect>();
  reads = 0;

  rect(element: Element): DOMRect {
    const cached = this.rects.get(element);
    if (cached) return cached;
    const rect = element.getBoundingClientRect();
    this.rects.set(element, rect);
    this.reads += 1;
    return rect;
  }

  invalidate(): void {
    this.rects.clear();
  }
}
