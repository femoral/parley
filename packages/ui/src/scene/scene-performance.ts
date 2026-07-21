export type SceneLoopMode = "active" | "ambient" | "idle";

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
