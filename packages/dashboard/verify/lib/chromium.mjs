/**
 * Resolve a Chromium binary for playwright-core.
 * Same order as packages/ui/lab/sweep.mjs (no browser download).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * @returns {string} absolute path to a Chromium/Chrome executable
 */
export function resolveChromium() {
  const explicit = process.env.PARLEY_VERIFY_CHROMIUM || process.env.PARLEY_LAB_CHROMIUM;
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new Error(
        `PARLEY_VERIFY_CHROMIUM / PARLEY_LAB_CHROMIUM is set but does not exist: ${explicit}`,
      );
    }
    return explicit;
  }

  const cacheRoot =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    (process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Caches", "ms-playwright")
      : path.join(os.homedir(), ".cache", "ms-playwright"));

  if (fs.existsSync(cacheRoot)) {
    const dirs = fs
      .readdirSync(cacheRoot)
      .filter((d) => d.startsWith("chromium") && !d.includes("headless_shell"))
      .sort()
      .reverse();
    const relative =
      process.platform === "darwin"
        ? ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"]
        : process.platform === "win32"
          ? ["chrome-win", "chrome.exe"]
          : ["chrome-linux64", "chrome"];
    for (const dir of dirs) {
      const candidate = path.join(cacheRoot, dir, ...relative);
      if (fs.existsSync(candidate)) return candidate;
      const legacy = path.join(cacheRoot, dir, "chrome-linux", "chrome");
      if (fs.existsSync(legacy)) return legacy;
    }
  }

  const system = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const candidate of system) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(
    "no Chromium found. Install one with `npx playwright install chromium`, " +
      "or point PARLEY_VERIFY_CHROMIUM at an existing binary.",
  );
}
