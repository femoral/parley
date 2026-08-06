/**
 * Console settings — Cove-parity bar from the coverage audit:
 * follow logs, shortcuts opt-out. Persisted to localStorage.
 */

const STORAGE_KEY = "parley-console.settings.v1";

export interface ConsoleSettings {
  /** When true, log tails stick to bottom and follow new lines. */
  followLogs: boolean;
  /** When false, keyboard accelerators (except Esc / focus management) are off. */
  shortcutsEnabled: boolean;
}

export const DEFAULT_SETTINGS: ConsoleSettings = {
  followLogs: true,
  shortcutsEnabled: true,
};

export function loadSettings(): ConsoleSettings {
  if (typeof localStorage === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<ConsoleSettings>;
    return {
      followLogs:
        typeof parsed.followLogs === "boolean"
          ? parsed.followLogs
          : DEFAULT_SETTINGS.followLogs,
      shortcutsEnabled:
        typeof parsed.shortcutsEnabled === "boolean"
          ? parsed.shortcutsEnabled
          : DEFAULT_SETTINGS.shortcutsEnabled,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(next: ConsoleSettings): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* quota / private mode — settings stay in-memory only */
  }
}
