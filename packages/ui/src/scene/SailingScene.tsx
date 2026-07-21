import { useLayoutEffect, useRef, useState } from "react";
import { shouldPaintShipEffects, shipEffectsOpacity } from "./island-death.js";
import { FLAGSHIP_CENTER, stationOffset, voyageFromFlagship } from "./layout.js";
import { GeometryCache, SceneLoopGate } from "./scene-performance.js";

/**
 * User-approved ship-lab calibration. These are deliberately literals rather
 * than clever derivations: issue #182's harness is the visual source of truth,
 * and changing one of them is an art-direction decision rather than refactoring.
 */
const SHIPS = {
  galleon: {
    width: 200,
    aspect: 414 / 507,
    draftFy: 0.43,
    baseHeel: 0.7,
    amp: 0.8,
    hullHalfW: 0.365,
    hullBotFy: 0.7,
    phase: 0,
  },
  sloop: {
    width: 90,
    aspect: 539 / 640,
    draftFy: 0.48,
    baseHeel: 0.5,
    amp: 1,
    hullHalfW: 0.44,
    hullBotFy: 0.435,
    phase: 2.1,
  },
} as const;

const FX = {
  foamAlpha: 0.14,
  blockBlur: 2,
  foamBlur: 1.5,
} as const;

const ORBIT = { gapPx: 60, squish: 0.4, speed: 0.22 } as const;
const SPAWN_RADIUS = 0.85 * SHIPS.galleon.width;
const ISLAND_WATERLINE_FY = 0.68; // image centre + 18% of image height
const ISLAND_ROOT_WIDTH = 156;
const FLIP_SECONDS = 0.5;

type ShipKind = keyof typeof SHIPS;
type SailingPose = "orbit" | "anchored" | "adrift" | "sailoff" | "flagship";

interface RuntimeShip {
  kind: ShipKind;
  pose: SailingPose;
  poseStartedAt: number;
  fromX: number;
  fromY: number;
  x: number;
  y: number;
  flip: number;
  flipFrom: number;
  flipTarget: number;
  flipStartedAt: number;
  arrivalSeconds: number;
  firstArrival: boolean;
}

interface PaintedShip {
  runtime: RuntimeShip;
  cx: number;
  cy: number;
  width: number;
  height: number;
  roll: number;
  /** Effective DOM opacity (0..1); foam / cover blocks scale with this (#187). */
  opacity: number;
  islandSprite?: HTMLImageElement;
  islandRect?: DOMRect;
  islandWaterY?: number;
}

interface RegionRuntime {
  zoom: number;
}

interface SeaTokens {
  shallow: string;
  mid: string;
  deep: string;
  abyss: string;
  foam: string;
  vignette: string;
  /** Room sea radial: centre + half-axes as fractions of the cockpit box. */
  gradCx: number;
  gradCy: number;
  gradRx: number;
  gradRy: number;
  /** Room vignette radial: same coordinate system as the DOM atmos overlay. */
  vignetteCx: number;
  vignetteCy: number;
  vignetteRx: number;
  vignetteRy: number;
  /** Transparent through this radius fraction; then ramps to vignette colour. */
  vignetteInner: number;
}

interface CachedIslandSprite {
  canvas: HTMLCanvasElement;
  pixelWidth: number;
  pixelHeight: number;
  source: string;
}

type IslandSpriteCache = WeakMap<HTMLImageElement, CachedIslandSprite>;

const ease = (value: number): number => {
  const u = Math.max(0, Math.min(1, value));
  return u * u * (3 - 2 * u);
};

function reducedMotionQuery(): MediaQueryList | null {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;
}

function cssToken(element: Element, name: string): string {
  return getComputedStyle(element).getPropertyValue(name).trim();
}

function cssNumber(element: Element, name: string, fallback: number): number {
  const raw = cssToken(element, name);
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

function readSeaTokens(scene: HTMLElement): SeaTokens {
  return {
    shallow: cssToken(scene, "--sea-shallow"),
    mid: cssToken(scene, "--sea-mid"),
    deep: cssToken(scene, "--sea-deep"),
    abyss: cssToken(scene, "--sea-abyss"),
    foam: cssToken(scene, "--sea-foam"),
    vignette: cssToken(scene, "--sea-vignette"),
    gradCx: cssNumber(scene, "--sea-grad-cx", 0.5),
    gradCy: cssNumber(scene, "--sea-grad-cy", -0.06),
    gradRx: cssNumber(scene, "--sea-grad-rx", 0.65),
    gradRy: cssNumber(scene, "--sea-grad-ry", 0.5),
    vignetteCx: cssNumber(scene, "--sea-vignette-cx", 0.5),
    vignetteCy: cssNumber(scene, "--sea-vignette-cy", 0.46),
    vignetteRx: cssNumber(scene, "--sea-vignette-rx", 0.78),
    vignetteRy: cssNumber(scene, "--sea-vignette-ry", 0.72),
    vignetteInner: cssNumber(scene, "--sea-vignette-inner", 0.38),
  };
}

/**
 * Fill an elliptical radial gradient defined in room coordinates, covering the
 * room box. Caller must have translated so room origin maps to canvas origin
 * (translate(-sceneOffsetX, -sceneOffsetY) after setTransform to CSS pixels).
 */
function fillRoomRadial(
  ctx: CanvasRenderingContext2D,
  roomW: number,
  roomH: number,
  cxFrac: number,
  cyFrac: number,
  rxFrac: number,
  ryFrac: number,
  stops: ReadonlyArray<readonly [number, string]>,
): void {
  const cx = roomW * cxFrac;
  const cy = roomH * cyFrac;
  // Guard degenerate axes (collapsed cockpit during tests / first layout).
  const rx = Math.max(roomW * rxFrac, 1);
  const ry = Math.max(roomH * ryFrac, 1);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(rx, ry);
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  for (const [offset, color] of stops) {
    gradient.addColorStop(offset, color);
  }
  ctx.fillStyle = gradient;
  const left = (0 - cx) / rx;
  const top = (0 - cy) / ry;
  ctx.fillRect(left, top, roomW / rx, roomH / ry);
  ctx.restore();
}

function canvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext("2d");
  } catch {
    // happy-dom/jsdom intentionally do not implement canvas painting. Motion
    // and lifecycle still run there; pixels are covered by browser validation.
    return null;
  }
}

function sizeCanvas(canvas: HTMLCanvasElement, width: number, height: number, dpr: number): boolean {
  const pixelWidth = Math.max(1, Math.round(width * dpr));
  const pixelHeight = Math.max(1, Math.round(height * dpr));
  const changed = canvas.width !== pixelWidth || canvas.height !== pixelHeight;
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  return changed;
}

function featheredIslandSprite(
  image: HTMLImageElement,
  width: number,
  height: number,
  dpr: number,
  cache: IslandSpriteCache,
): CanvasImageSource {
  // One cache entry per mounted island image; rebuild only when its rendered
  // size (zoom/resize) or source changes, never on steady-state frames.
  const pixelWidth = Math.max(1, Math.round(width * dpr));
  const pixelHeight = Math.max(1, Math.round(height * dpr));
  const source = image.currentSrc || image.src;
  const cached = cache.get(image);
  if (
    cached &&
    cached.pixelWidth === pixelWidth &&
    cached.pixelHeight === pixelHeight &&
    cached.source === source
  ) {
    return cached.canvas;
  }

  const canvas = document.createElement("canvas");
  canvas.width = pixelWidth;
  canvas.height = pixelHeight;
  const ctx = canvasContext(canvas);
  if (!ctx) return image;

  ctx.drawImage(image, 0, 0, pixelWidth, pixelHeight);
  ctx.save();
  ctx.globalCompositeOperation = "destination-in";
  ctx.translate(pixelWidth * 0.5, pixelHeight * 0.6);
  ctx.scale(pixelWidth * 1.2, pixelHeight * 0.92);
  const feather = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  feather.addColorStop(0.42, "rgba(0, 0, 0, 1)");
  feather.addColorStop(0.62, "rgba(0, 0, 0, 0.55)");
  feather.addColorStop(0.92, "rgba(0, 0, 0, 0)");
  feather.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = feather;
  ctx.fillRect(-2, -2, 4, 4);
  ctx.restore();

  cache.set(image, { canvas, pixelWidth, pixelHeight, source });
  return canvas;
}

function drawIslandSprite(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  rect: DOMRect,
  sceneRect: DOMRect,
  dpr: number,
  cache: IslandSpriteCache,
): void {
  const sprite = featheredIslandSprite(image, rect.width, rect.height, dpr, cache);
  ctx.drawImage(
    sprite,
    rect.left - sceneRect.left,
    rect.top - sceneRect.top,
    rect.width,
    rect.height,
  );
}

function paintBackdrop(
  scene: HTMLElement,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  dpr: number,
  tokens: SeaTokens,
  sceneRect: DOMRect,
  islandCache: IslandSpriteCache,
  geometry: GeometryCache,
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  // One continuous sea (#189): sample the room gradient + room vignette at this
  // canvas's position inside .pc-cockpit so edge tones match the DOM backdrop
  // and hull cover blocks (which copy these pixels) stay invisible.
  const room = scene.closest<HTMLElement>(".pc-cockpit");
  const roomRect = room ? geometry.rect(room) : sceneRect;
  const roomW = Math.max(room?.clientWidth || roomRect.width, 1);
  const roomH = Math.max(room?.clientHeight || roomRect.height, 1);
  const originX = sceneRect.left - roomRect.left;
  const originY = sceneRect.top - roomRect.top;

  ctx.save();
  ctx.translate(-originX, -originY);
  fillRoomRadial(ctx, roomW, roomH, tokens.gradCx, tokens.gradCy, tokens.gradRx, tokens.gradRy, [
    [0, tokens.shallow],
    [0.3, tokens.mid],
    [0.6, tokens.deep],
    [1, tokens.abyss],
  ]);
  ctx.restore();

  for (const image of scene.querySelectorAll<HTMLImageElement>(".pc-island__sprite")) {
    if (!image.complete || image.naturalWidth === 0) continue;
    const rect = geometry.rect(image);
    const rise = image.closest(".pc-island__rise");
    const opacity = rise ? Number.parseFloat(getComputedStyle(rise).opacity || "1") : 1;
    if (opacity <= 0 || rect.width <= 0 || rect.height <= 0) continue;
    ctx.globalAlpha = Number.isFinite(opacity) ? opacity : 1;
    drawIslandSprite(ctx, image, rect, sceneRect, dpr, islandCache);
  }
  ctx.globalAlpha = 1;

  // Bake the room-scoped vignette (same ellipse as .pc-atmos--vignette) so
  // cover blocks copy already-dimmed water. A DOM vignette above the FX canvas
  // would leave every copied block a visibly brighter rectangle. The scene-
  // local vignette that created the centre box is gone.
  ctx.save();
  ctx.translate(-originX, -originY);
  fillRoomRadial(
    ctx,
    roomW,
    roomH,
    tokens.vignetteCx,
    tokens.vignetteCy,
    tokens.vignetteRx,
    tokens.vignetteRy,
    [
      [0, "rgba(0, 0, 0, 0)"],
      [tokens.vignetteInner, "rgba(0, 0, 0, 0)"],
      [1, tokens.vignette],
    ],
  );
  ctx.restore();
}

function regionZoom(
  region: HTMLElement,
  dt: number,
  reduced: boolean,
  states: WeakMap<Element, RegionRuntime>,
): boolean {
  const count = Number.parseInt(region.dataset.islandCount ?? "0", 10);
  const target = count > 0 ? Math.min(1, Math.sqrt(5 / count)) : 1;
  let runtime = states.get(region);
  if (!runtime) {
    runtime = { zoom: reduced ? target : 1 };
    states.set(region, runtime);
  }
  const previous = runtime.zoom;
  runtime.zoom = reduced ? target : runtime.zoom + (target - runtime.zoom) * Math.min(1, dt * 3);
  region.style.setProperty("--region-zoom", String(runtime.zoom));
  return Math.abs(runtime.zoom - target) > 0.0005 || Math.abs(runtime.zoom - previous) > 0.0005;
}

function localIslandGeometry(element: HTMLElement, geometry: GeometryCache): {
  root: HTMLElement;
  sprite: HTMLImageElement;
  rect: DOMRect;
  rootRect: DOMRect;
  cx: number;
  cy: number;
  radius: number;
  scale: number;
} | null {
  const root = element.closest<HTMLElement>(".pc-island");
  const sprite = root?.querySelector<HTMLImageElement>(".pc-island__sprite");
  if (!root || !sprite) return null;
  const rootRect = geometry.rect(root);
  const rect = geometry.rect(sprite);
  const scale = rootRect.width > 0 ? rootRect.width / ISLAND_ROOT_WIDTH : 1;
  return {
    root,
    sprite,
    rect,
    rootRect,
    cx: (rect.left + rect.width / 2 - rootRect.left) / scale,
    cy: (rect.top + rect.height * ISLAND_WATERLINE_FY - rootRect.top) / scale,
    radius: ORBIT.gapPx + rect.width / (2 * scale),
    scale,
  };
}

function initialRuntime(element: HTMLElement, kind: ShipKind, pose: SailingPose, t: number): RuntimeShip {
  if (kind === "galleon") {
    return {
      kind,
      pose,
      poseStartedAt: t,
      fromX: 0,
      fromY: 0,
      x: 0,
      y: 0,
      flip: 1,
      flipFrom: 1,
      flipTarget: 1,
      flipStartedAt: t,
      arrivalSeconds: 0,
      firstArrival: false,
    };
  }
  const island = {
    x: Number.parseFloat(element.dataset.islandX ?? "0"),
    y: Number.parseFloat(element.dataset.islandY ?? "150"),
  };
  const from = voyageFromFlagship(island);
  const length = Math.hypot(from.x, from.y) || 1;
  // Spawn on the galleon→island bearing but one prudent galleon radius clear
  // of the flagship, so the 1.2s translucent arrival is never submerged by
  // the flagship's mask/cover block.
  const spawn = {
    x: from.x - (from.x / length) * SPAWN_RADIUS,
    y: from.y - (from.y / length) * SPAWN_RADIUS,
  };
  return {
    kind,
    pose,
    poseStartedAt: t,
    fromX: spawn.x,
    fromY: spawn.y,
    x: spawn.x,
    y: spawn.y,
    flip: island.x < FLAGSHIP_CENTER.x ? -1 : 1,
    flipFrom: island.x < FLAGSHIP_CENTER.x ? -1 : 1,
    flipTarget: island.x < FLAGSHIP_CENTER.x ? -1 : 1,
    flipStartedAt: t,
    arrivalSeconds: 3.2,
    firstArrival: pose !== "sailoff",
  };
}

function pointOnShip(ship: PaintedShip, fx: number, fy: number): { x: number; y: number } {
  // Mirror before rotation, then rotate around the same 50%/80% origin as the
  // DOM transform. Keeping this expanded form beside the canvas work avoids
  // the subtle foam drift that results from rotating around the box centre.
  const px = ship.width * (0.5 + fx * ship.runtime.flip);
  const py = ship.height * (0.5 + fy);
  const originX = ship.width * 0.5;
  const originY = ship.height * 0.8;
  const dx = px - originX;
  const dy = py - originY;
  const angle = (ship.roll * Math.PI) / 180;
  return {
    x: ship.cx + (originX - ship.width * 0.5) + dx * Math.cos(angle) - dy * Math.sin(angle),
    y: ship.cy + (originY - ship.height * 0.5) + dx * Math.sin(angle) + dy * Math.cos(angle),
  };
}

function paintShipEffects(
  backdrop: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  ships: PaintedShip[],
  width: number,
  height: number,
  dpr: number,
  t: number,
  foam: string,
  sceneRect: DOMRect,
  islandCache: IslandSpriteCache,
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  for (const ship of ships) {
    // Effects track the ship's effective opacity, not mere DOM presence —
    // a fully faded sailoff sloop must not leave an immortal foam patch (#187).
    if (ship.opacity <= 0.02) continue;

    const calibration = SHIPS[ship.runtime.kind];
    const topY = pointOnShip(ship, 0, calibration.draftFy).y;
    const bottomY = pointOnShip(ship, 0, calibration.hullBotFy).y;
    const edgeA = pointOnShip(ship, -calibration.hullHalfW, calibration.draftFy).x;
    const edgeB = pointOnShip(ship, calibration.hullHalfW, calibration.draftFy).x;
    const left = Math.min(edgeA, edgeB) - 6;
    const right = Math.max(edgeA, edgeB) + 6;
    const effectAlpha = ship.opacity;

    // The sloop's approved hull bottom sits above its draft line, producing a
    // negative rectangle. Keep the harness guard: its steep mask does the work.
    const blockWidth = right - left;
    const blockHeight = bottomY - topY + 3;
    if (blockWidth > 0 && blockHeight > 0) {
      const sourceX = Math.max(0, left);
      const sourceY = Math.max(0, topY - 3);
      const sourceRight = Math.min(width, right);
      const sourceBottom = Math.min(height, topY - 3 + blockHeight);
      const copyWidth = sourceRight - sourceX;
      const copyHeight = sourceBottom - sourceY;
      if (copyWidth > 0 && copyHeight > 0) {
        ctx.save();
        ctx.globalAlpha = effectAlpha;
        ctx.filter = `blur(${FX.blockBlur}px)`;
        ctx.drawImage(
          backdrop,
          sourceX * dpr,
          sourceY * dpr,
          copyWidth * dpr,
          copyHeight * dpr,
          sourceX,
          sourceY,
          copyWidth,
          copyHeight,
        );
        ctx.restore();
      }
    }

    ctx.save();
    ctx.filter = `blur(${FX.foamBlur}px)`;
    ctx.strokeStyle = foam;
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    for (let x = left; x < right - 12; x += 12) {
      const u = (x - left) / (right - left);
      ctx.globalAlpha = FX.foamAlpha * effectAlpha * Math.pow(Math.sin(Math.PI * u), 0.7);
      ctx.beginPath();
      ctx.moveTo(x, topY + Math.sin(x * 0.08 + t * 3) * 1.6);
      ctx.lineTo(x + 12, topY + Math.sin((x + 12) * 0.08 + t * 3) * 1.6);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Far orbit leg: the ship's hull waterline moves above the island waterline,
  // so repaint the same island sprite over the sloop to restore depth ordering.
  for (const ship of ships) {
    if (
      ship.runtime.kind !== "sloop" ||
      ship.runtime.pose !== "orbit" ||
      !ship.islandSprite ||
      !ship.islandRect ||
      ship.islandWaterY === undefined
    ) continue;
    const hullWaterY = pointOnShip(ship, 0, SHIPS.sloop.draftFy).y;
    if (hullWaterY >= ship.islandWaterY) continue;
    const rect = ship.islandRect;
    if (!ship.islandSprite.complete || ship.islandSprite.naturalWidth === 0) continue;
    drawIslandSprite(ctx, ship.islandSprite, rect, sceneRect, dpr, islandCache);
  }
}

function islandsAnimating(scene: HTMLElement): boolean {
  for (const rise of scene.querySelectorAll<HTMLElement>(".pc-island__rise")) {
    if (typeof rise.getAnimations !== "function") continue;
    if (rise.getAnimations().some((animation) => animation.playState === "running")) return true;
  }
  return false;
}

/**
 * One scene-level rAF owner for every mounted region. The component owns only
 * animation state: React remains the source of ships, poses, islands, factions,
 * and camera selection; each frame reads those prop-derived facts from the DOM.
 */
export function SailingScene() {
  const layerRef = useRef<HTMLSpanElement>(null);
  const seaRef = useRef<HTMLCanvasElement>(null);
  const fxRef = useRef<HTMLCanvasElement>(null);
  const [reduced, setReduced] = useState(() => reducedMotionQuery()?.matches ?? false);
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;

  useLayoutEffect(() => {
    const query = reducedMotionQuery();
    if (!query) return;
    const update = () => setReduced(query.matches);
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  useLayoutEffect(() => {
    const layer = layerRef.current;
    const backdrop = seaRef.current;
    const overlay = fxRef.current;
    const scene = layer?.closest<HTMLElement>(".pc-scene-view");
    if (!layer || !backdrop || !overlay || !scene) return;

    const backdropCtx = canvasContext(backdrop);
    const overlayCtx = canvasContext(overlay);
    const runtimes = new Map<HTMLElement, RuntimeShip>();
    const regionStates = new WeakMap<Element, RegionRuntime>();
    const islandCache: IslandSpriteCache = new WeakMap();
    const geometryCache = new GeometryCache();
    const loopGate = new SceneLoopGate();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let tokens = readSeaTokens(scene);
    let backdropDirty = true;
    let lastCameraLeft = Number.NaN;
    let lastCameraTop = Number.NaN;
    let frameId = 0;
    let lastNow = performance.now();
    let simTime = 0;
    let idleTimer = 0;
    let cameraTravelActive = false;
    let fxDirty = true;

    const scheduleFrame = () => {
      if (frameId || idleTimer) return;
      frameId = window.requestAnimationFrame(frame);
    };

    const wake = () => {
      loopGate.wake();
      fxDirty = true;
      if (idleTimer) {
        window.clearTimeout(idleTimer);
        idleTimer = 0;
      }
      scheduleFrame();
    };

    const invalidateGeometry = () => {
      geometryCache.invalidate();
      backdropDirty = true;
      wake();
    };

    const refreshSea = () => {
      tokens = readSeaTokens(scene);
      invalidateGeometry();
    };
    const sceneAttributeObserver = new MutationObserver(refreshSea);
    sceneAttributeObserver.observe(scene, { attributes: true });
    const sceneTreeObserver = new MutationObserver(invalidateGeometry);
    sceneTreeObserver.observe(scene, {
      attributes: true,
      attributeFilter: ["data-sailing-pose", "data-island-count", "data-motion", "class", "src"],
      childList: true,
      subtree: true,
    });
    window.addEventListener("resize", refreshSea);
    const cameraTransition = (event: Event) => {
      const transition = event as TransitionEvent;
      if (transition.propertyName && transition.propertyName !== "transform") return;
      cameraTravelActive = event.type === "transitionrun" || event.type === "transitionstart";
      invalidateGeometry();
    };
    scene.addEventListener("transitionrun", cameraTransition);
    scene.addEventListener("transitionstart", cameraTransition);
    scene.addEventListener("transitionend", cameraTransition);
    scene.addEventListener("transitioncancel", cameraTransition);

    const frame = (now: number) => {
      frameId = 0;
      idleTimer = 0;
      loopGate.consume();
      let loopMode = loopGate.mode;
      try {
        const motionReduced = reducedRef.current;
        const dt = Math.min(Math.max(0, (now - lastNow) / 1000), 0.1);
        lastNow = now;
        if (!motionReduced) simTime += dt;

        if (cameraTravelActive) geometryCache.invalidate();
        const sceneRect = geometryCache.rect(scene);
        const width = scene.clientWidth || sceneRect.width;
        const height = scene.clientHeight || sceneRect.height;
        const backdropResized = sizeCanvas(backdrop, width, height, dpr);
        sizeCanvas(overlay, width, height, dpr);

        let zoomActive = false;
        for (const region of scene.querySelectorAll<HTMLElement>(".pc-region")) {
          zoomActive = regionZoom(region, dt, motionReduced, regionStates) || zoomActive;
        }
        const islandMotionActive = islandsAnimating(scene);
        if (zoomActive || islandMotionActive) geometryCache.invalidate();

        const camera = scene.querySelector<HTMLElement>(".pc-world");
        const cameraRect = camera ? geometryCache.rect(camera) : undefined;
        const cameraMoving = cameraRect
          ? !Number.isFinite(lastCameraLeft) ||
            Math.abs(cameraRect.left - lastCameraLeft) > 0.01 ||
            Math.abs(cameraRect.top - lastCameraTop) > 0.01
          : false;
        if (cameraRect) {
          lastCameraLeft = cameraRect.left;
          lastCameraTop = cameraRect.top;
        }
        const repaintBackdrop =
          backdropDirty || backdropResized || zoomActive || cameraMoving || islandMotionActive;
        if (backdropCtx && repaintBackdrop) {
          paintBackdrop(
            scene,
            backdropCtx,
            width,
            height,
            dpr,
            tokens,
            sceneRect,
            islandCache,
            geometryCache,
          );
          backdropDirty = false;
        }

        const live = new Set<HTMLElement>();
        const painted: PaintedShip[] = [];
        let choreographyActive =
          zoomActive || cameraMoving || cameraTravelActive || islandMotionActive;
        for (const element of scene.querySelectorAll<HTMLElement>("[data-sailing-ship]")) {
          live.add(element);
          const kind = element.dataset.sailingShip as ShipKind;
          const pose = (element.dataset.sailingPose ?? "flagship") as SailingPose;
          const calibration = SHIPS[kind];
          if (!calibration) continue;
          let runtime = runtimes.get(element);
          if (!runtime) {
            runtime = initialRuntime(element, kind, pose, simTime);
            runtimes.set(element, runtime);
            choreographyActive = true;
          } else if (runtime.pose !== pose) {
            runtime.pose = pose;
            runtime.poseStartedAt = simTime;
            runtime.fromX = runtime.x;
            runtime.fromY = runtime.y;
            runtime.arrivalSeconds = 1.6;
            runtime.firstArrival = false;
            choreographyActive = true;
          }

          const region = element.closest<HTMLElement>(".pc-region");
          const zoom = Number.parseFloat(region?.style.getPropertyValue("--region-zoom") || "1");
          const shipWidth = calibration.width * zoom;
          const shipHeight = shipWidth * calibration.aspect;
          const t = simTime;
          const poseElapsed = motionReduced ? Number.POSITIVE_INFINITY : t - runtime.poseStartedAt;
          choreographyActive =
            choreographyActive ||
            pose === "orbit" ||
            pose === "adrift" ||
            (pose === "sailoff" && poseElapsed < 2.4) ||
            runtime.firstArrival ||
            Math.abs(runtime.flip - runtime.flipTarget) > 0.001;
          const motion = pose === "anchored" ? 0.45 : pose === "adrift" ? 0.75 : 1;
          const m = motion * calibration.amp;
          const bob = (Math.sin(t * 0.85 + calibration.phase) * 7 + Math.sin(t * 0.5 + 1.2 + calibration.phase) * 4) * m;
          const sway = Math.sin(t * 0.37 + calibration.phase) * 8 * m;
          const rockMultiplier = pose === "adrift" ? 1.6 : 1;
          const rock = (Math.sin(t * 0.62 + 0.4 + calibration.phase) * 1.7 + Math.sin(t * 0.21 + calibration.phase) * 1.1) * m * rockMultiplier;
          const roll = calibration.baseHeel + rock;
          const squash = 1 + Math.sin(t * 0.77 + 2 + calibration.phase) * 0.006 * m;

          let cx = 0;
          let cy = 0;
          let geometry: ReturnType<typeof localIslandGeometry> = null;
          if (kind === "galleon") {
            const host = element.closest<HTMLElement>(".pc-region__flagship");
            const hostRect = host ? geometryCache.rect(host) : undefined;
            cx = (hostRect?.left ?? sceneRect.left) - sceneRect.left + sway;
            cy = (hostRect?.top ?? sceneRect.top) - sceneRect.top + bob;
            element.style.transform = `translate(-50%, -50%) translate(${sway / zoom}px, ${bob / zoom}px) rotate(${roll}deg) scaleY(${squash})`;
          } else {
            geometry = localIslandGeometry(element, geometryCache);
            if (!geometry) continue;
            const elapsed = poseElapsed;
            let targetX = geometry.cx;
            let targetY = geometry.cy;
            let heading = runtime.flipTarget;

            if (pose === "orbit") {
              const angle = t * ORBIT.speed;
              targetX = geometry.cx + Math.cos(angle) * geometry.radius;
              targetY = geometry.cy + Math.sin(angle) * geometry.radius * ORBIT.squish - calibration.width * calibration.aspect * calibration.draftFy;
              // Hold the voyage bearing through arrival; once on orbit, mirror
              // at the side extrema from the ellipse's horizontal derivative.
              if (motionReduced || elapsed >= runtime.arrivalSeconds) {
                heading = Math.sin(angle) > 0 ? -1 : 1;
              }
            } else if (pose === "anchored" || pose === "adrift") {
              const island = {
                x: Number.parseFloat(element.dataset.islandX ?? "0"),
                y: Number.parseFloat(element.dataset.islandY ?? "150"),
              };
              const station = stationOffset(island, pose === "anchored" ? 58 : 96);
              targetX = geometry.cx + station.x;
              // stationOffset locates the hull's waterline on the near-side
              // bearing; compensate the DOM wrapper by the approved draft so
              // the sprite itself sits in (rather than on top of) that water.
              targetY = geometry.cy + station.y - calibration.width * calibration.aspect * calibration.draftFy;
              heading = 1;
              if (pose === "adrift") targetX += Math.sin(t * 0.13) * 22;
              element.style.opacity = "";
            } else {
              targetX = runtime.fromX + ease(elapsed / 2.4) * 210;
              targetY = runtime.fromY - ease(elapsed / 2.4) * 30;
              element.style.opacity = String(1 - ease(elapsed / 2.4));
            }

            if (motionReduced) {
              // A frozen clock cannot advance a 0.5s turn, so seat the ship at
              // the target heading immediately in its static on-station pose.
              runtime.flip = heading;
              runtime.flipFrom = heading;
              runtime.flipTarget = heading;
              runtime.flipStartedAt = t;
            } else if (heading !== runtime.flipTarget) {
              runtime.flipFrom = runtime.flip;
              runtime.flipTarget = heading;
              runtime.flipStartedAt = t;
            }
            if (!motionReduced) {
              runtime.flip = runtime.flipFrom + (runtime.flipTarget - runtime.flipFrom) * ease((t - runtime.flipStartedAt) / FLIP_SECONDS);
            }

            const arrival = motionReduced ? 1 : ease(elapsed / runtime.arrivalSeconds);
            if (pose !== "sailoff") {
              runtime.x = runtime.fromX + (targetX - runtime.fromX) * arrival;
              runtime.y = runtime.fromY + (targetY - runtime.fromY) * arrival;
            } else {
              runtime.x = targetX;
              runtime.y = targetY;
            }
            if (runtime.firstArrival && !motionReduced) {
              element.style.opacity = String(Math.min(1, elapsed / 1.2));
              if (elapsed >= runtime.arrivalSeconds) runtime.firstArrival = false;
            } else if (pose !== "sailoff") {
              element.style.opacity = "";
            }
            element.style.setProperty("--sailing-heading", String(runtime.flip));
            // Region scale already applies zoom to station/orbit coordinates.
            // Swell remains screen-pixel motion, matching the validated harness.
            const localSway = sway / zoom;
            const localBob = bob / zoom;
            element.style.transform = `translate(${runtime.x + localSway}px, ${runtime.y + localBob}px) translate(-50%, -50%) rotate(${roll}deg) scaleY(${squash})`;

            cx = geometry.rootRect.left - sceneRect.left + runtime.x * geometry.scale + sway;
            cy = geometry.rootRect.top - sceneRect.top + runtime.y * geometry.scale + bob;
          }

          // Inline style is what the driver writes for arrival/sailoff fades;
          // empty string means full opacity (CSS default).
          const opacity = shipEffectsOpacity(element.style.opacity);
          if (!shouldPaintShipEffects(element.style.opacity) && pose === "sailoff") {
            // Still drive transforms above, but omit fully-faded sailoff hulls
            // from the painted list so foam cannot outlive the ship (#187).
            continue;
          }

          painted.push({
            runtime,
            cx,
            cy,
            width: shipWidth,
            height: shipHeight,
            roll,
            opacity,
            islandSprite: geometry?.sprite,
            islandRect: geometry?.rect,
            islandWaterY: geometry
              ? geometry.rect.top - sceneRect.top + geometry.rect.height * ISLAND_WATERLINE_FY
              : undefined,
          });
        }

        for (const element of runtimes.keys()) {
          if (!live.has(element)) runtimes.delete(element);
        }
        loopMode = loopGate.settle({ active: choreographyActive, reducedMotion: motionReduced });
        if (overlayCtx && backdropCtx && (fxDirty || loopMode !== "idle")) {
          paintShipEffects(
            backdrop,
            overlayCtx,
            painted,
            width,
            height,
            dpr,
            simTime,
            tokens.foam,
            sceneRect,
            islandCache,
          );
          fxDirty = false;
        }
        layer.removeAttribute("data-error");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        layer.dataset.error = message;
        if (import.meta.env.DEV) console.error("Parley Cove sailing frame failed", error);
      } finally {
        if (loopMode === "active") {
          scheduleFrame();
        } else if (loopMode === "ambient") {
          // Settled ships retain the calibrated JS swell, but at a fraction of
          // active-frame cost. State/resize/transition observers bypass this
          // delay and wake the scene immediately.
          idleTimer = window.setTimeout(() => {
            idleTimer = 0;
            scheduleFrame();
          }, 100);
        }
      }
    };

    scheduleFrame();
    return () => {
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(idleTimer);
      window.removeEventListener("resize", refreshSea);
      scene.removeEventListener("transitionrun", cameraTransition);
      scene.removeEventListener("transitionstart", cameraTransition);
      scene.removeEventListener("transitionend", cameraTransition);
      scene.removeEventListener("transitioncancel", cameraTransition);
      sceneAttributeObserver.disconnect();
      sceneTreeObserver.disconnect();
    };
  }, []);

  return (
    <span ref={layerRef} className="pc-sailing-layer" data-motion={reduced ? "reduced" : "active"} aria-hidden="true">
      <canvas ref={seaRef} className="pc-sailing-sea" />
      <canvas ref={fxRef} className="pc-sailing-fx" />
    </span>
  );
}
