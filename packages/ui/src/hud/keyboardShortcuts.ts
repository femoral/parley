/**
 * Power-user accelerators shown in the empty LOGBOOK rest state and the Chart
 * key "Keys" section. Single source of truth so the two surfaces cannot drift
 * (wired in `useCockpitKeys`).
 */
export const KEYBOARD_SHORTCUTS: readonly { key: string; hint: string }[] = [
  { key: "/", hint: "find session" },
  { key: "n", hint: "next flag that needs you" },
  { key: "m", hint: "toggle Soundings" },
  { key: "Esc", hint: "clear task selection" },
];
