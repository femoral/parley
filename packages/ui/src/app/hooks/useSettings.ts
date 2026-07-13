import { useCallback, useEffect, useState } from "react";

/**
 * The cockpit's persisted preferences (component-system spec contract 5:
 * "settings toggles from day one" — ornaments, kit band, live-log follow;
 * design-manifest §7's "Toggles ... all worth keeping as settings", #70).
 */
export interface Settings {
  /** Corner flourishes on the cartouche/premium plates (design-manifest §2.11). */
  ornaments: boolean;
  /** The bottom style-guide strip (design-manifest §3's "kit band ships behind
   * a dev toggle") — off by default; this is that toggle. */
  showKit: boolean;
  /** Whether the inspector's Logs tab keeps polling/tailing the selected
   * task's raw log, or sits paused on what it already has. */
  followLogs: boolean;
}

const DEFAULTS: Settings = { ornaments: true, showKit: false, followLogs: true };

/** One versioned key — a shape change bumps the suffix rather than migrating
 * old shapes, since these are cosmetic prefs a user can just re-toggle. */
const STORAGE_KEY = "parley-cove:settings:v1";

function isSettings(value: unknown): value is Partial<Settings> {
  return typeof value === "object" && value !== null;
}

/** Read persisted settings, tolerating anything from "never saved" to a
 * corrupt/foreign value under the same key — always falls back to defaults
 * per missing/invalid field rather than throwing. */
function readSettings(): Settings {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed: unknown = JSON.parse(raw);
    if (!isSettings(parsed)) return DEFAULTS;
    return {
      ornaments: typeof parsed.ornaments === "boolean" ? parsed.ornaments : DEFAULTS.ornaments,
      showKit: typeof parsed.showKit === "boolean" ? parsed.showKit : DEFAULTS.showKit,
      followLogs: typeof parsed.followLogs === "boolean" ? parsed.followLogs : DEFAULTS.followLogs,
    };
  } catch {
    // Private-mode storage access, a foreign non-JSON value, whatever — the
    // cockpit still works this session, it just starts from the defaults.
    return DEFAULTS;
  }
}

export interface SettingsView extends Settings {
  toggleOrnaments: () => void;
  toggleShowKit: () => void;
  toggleFollowLogs: () => void;
}

/**
 * Layer 4 (hooks) — the settings store: `useState` seeded from `localStorage`,
 * written back on every change. Plain booleans + toggle callbacks out, so
 * `Cockpit` and the hud composites it feeds (contract 2) never touch storage
 * themselves. Persistence failures (quota, private browsing) are swallowed —
 * a preference that doesn't survive a reload is a minor papercut, not a
 * reason to break the cockpit.
 */
export function useSettings(): SettingsView {
  const [settings, setSettings] = useState<Settings>(readSettings);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Nothing to do — see readSettings' comment.
    }
  }, [settings]);

  const toggleOrnaments = useCallback(
    () => setSettings((prev) => ({ ...prev, ornaments: !prev.ornaments })),
    [],
  );
  const toggleShowKit = useCallback(
    () => setSettings((prev) => ({ ...prev, showKit: !prev.showKit })),
    [],
  );
  const toggleFollowLogs = useCallback(
    () => setSettings((prev) => ({ ...prev, followLogs: !prev.followLogs })),
    [],
  );

  return { ...settings, toggleOrnaments, toggleShowKit, toggleFollowLogs };
}
