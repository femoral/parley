/**
 * Layer 3 — scene barrel. The living view (component-system spec §Layers): a
 * continuous sea of session regions, islands per task, faction sloops, and
 * state-driven effects. State-driven and compositor-animated; it takes plain
 * data props and never fetches (contracts 2 & 3). Importing this pulls the scene
 * stylesheet.
 */
import "./scene.css";

export { Scene } from "./Scene.js";
export type { SceneProps } from "./Scene.js";
export { Camera } from "./Camera.js";
export { Sea } from "./Sea.js";
export { Sky } from "./Sky.js";
export { Horizon } from "./Horizon.js";
export { Mist } from "./Mist.js";
export { SessionRegion } from "./SessionRegion.js";
export type { SessionRegionData, SessionRegionProps } from "./SessionRegion.js";
export { EdgeAlerts, EDGE_ALERT_STACK_CAP } from "./EdgeAlerts.js";
export type { EdgeAlertItem, EdgeAlertSide, EdgeAlertsProps } from "./EdgeAlerts.js";
export { Flagship } from "./Flagship.js";
export { Island } from "./Island.js";
export type { IslandTask } from "./Island.js";
export { Ship } from "./Ship.js";
export type { ShipProps } from "./Ship.js";
