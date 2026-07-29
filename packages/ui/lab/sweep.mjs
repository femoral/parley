#!/usr/bin/env node
/**
 * Chart measurement sweep — renders the chart lab across a grid of viewports
 * and run shapes and reports what a probe measured in each cell.
 *
 * Why this exists: the unit suite runs under happy-dom, which performs no
 * layout. It passed green in both the defective and the fixed state of #267
 * and #268, so for anything about where ink lands it is not evidence. This is
 * the cheapest way to get a number instead of an argument.
 *
 *   node lab/sweep.mjs --probe overprint
 *   node lab/sweep.mjs --probe clipped --workflow averyverylongsingletoken
 *   node lab/sweep.mjs --probe geometry --viewports 320x800,390x844,1081x800
 *   node lab/sweep.mjs --probe belowFold --nodes 12,16,20 --json out.json
 *
 * Starts its own Vite dev server on an ephemeral port and shuts it down after,
 * so parallel runs never collide over a port.
 *
 * Requires a Chromium binary. Resolution order:
 *   1. $PARLEY_LAB_CHROMIUM
 *   2. a Playwright-managed Chromium under the local browsers cache
 *   3. a system chromium / chrome on PATH-ish well-known locations
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { helpersSource, PROBES } from "./probes.mjs";

const LAB_DIR = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.resolve(LAB_DIR, "..");

/** Desktop triptych widths, plus the stacked range below the breakpoint. */
const DEFAULT_VIEWPORTS = [
  "1920x1200",
  "1920x1080",
  "1920x942",
  "1600x1000",
  "1600x900",
  "1440x900",
  "1280x800",
  "1280x720",
  "1081x800",
  "1081x720",
];
const DEFAULT_NODES = [1, 2, 3, 5, 8, 12, 16, 20];

function parseArgs(argv) {
  const args = {
    probe: "geometry",
    viewports: DEFAULT_VIEWPORTS,
    nodes: DEFAULT_NODES,
    held: "both",
    workflow: "research",
    json: null,
    shots: null,
    extra: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--probe":
        args.probe = value;
        i += 1;
        break;
      case "--viewports":
        args.viewports = value.split(",").map((s) => s.trim());
        i += 1;
        break;
      case "--nodes":
        args.nodes = value.split(",").map((s) => Number(s.trim()));
        i += 1;
        break;
      case "--held":
        args.held = value; // "0" | "1" | "both"
        i += 1;
        break;
      case "--workflow":
        args.workflow = value;
        i += 1;
        break;
      case "--json":
        args.json = value;
        i += 1;
        break;
      case "--shots":
        args.shots = value;
        i += 1;
        break;
      // Extra query params for the fixture, appended verbatim. Exists so a
      // throwaway prototype can put its own knob behind a URL flag and be
      // swept with the same grid as the shipped behavior, side by side —
      // which is how #273's options were priced against each other.
      case "--extra":
        args.extra = value;
        i += 1;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "usage: node lab/sweep.mjs [options]",
            "",
            `  --probe <name>       ${Object.keys(PROBES).join(" | ")}   (default: geometry)`,
            "  --viewports  WxH,... (default: the desktop triptych grid)",
            "  --nodes      n,n,... (default: 1,2,3,5,8,12,16,20)",
            "  --held       0|1|both",
            "  --workflow   <name>  run/workflow name to render",
            "  --json       <path>  write full per-cell results",
            "  --shots      <dir>   also save a PNG per cell (a number you can look at)",
            "  --extra      <query> extra query params for the fixture, e.g. proto=both",
            "",
            "env: PARLEY_LAB_CHROMIUM=/path/to/chrome",
          ].join("\n"),
        );
        process.exit(0);
        break;
      default:
        if (flag.startsWith("-")) {
          console.error(`unknown flag: ${flag}`);
          process.exit(2);
        }
    }
  }
  return args;
}

/**
 * Find a Chromium. Playwright-core ships no browsers of its own, so this
 * reuses whatever the machine already has rather than downloading one.
 */
function resolveChromium() {
  const explicit = process.env.PARLEY_LAB_CHROMIUM;
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new Error(`PARLEY_LAB_CHROMIUM is set but does not exist: ${explicit}`);
    }
    return explicit;
  }

  // Playwright's browsers cache: ~/.cache/ms-playwright/chromium-<rev>/...
  const cacheRoot =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    (process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Caches", "ms-playwright")
      : path.join(os.homedir(), ".cache", "ms-playwright"));
  if (fs.existsSync(cacheRoot)) {
    const dirs = fs
      .readdirSync(cacheRoot)
      .filter((d) => d.startsWith("chromium"))
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
      // Older layouts used chrome-linux/ rather than chrome-linux64/.
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
      "or point PARLEY_LAB_CHROMIUM at an existing binary.",
  );
}

function formatCell(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return String(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Print rows as a fixed-width table over whatever keys the probe returned. */
function printTable(rows) {
  if (rows.length === 0) {
    console.log("(no cells)");
    return;
  }
  const skip = new Set(["worst", "by"]);
  const keys = Object.keys(rows[0]).filter((k) => !skip.has(k));
  const widths = keys.map((k) =>
    Math.max(k.length, ...rows.map((r) => formatCell(r[k]).length)),
  );
  const line = (cells) =>
    cells.map((c, i) => String(c).padStart(widths[i])).join("  ");
  console.log(line(keys));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(line(keys.map((k) => formatCell(row[k]))));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const probe = PROBES[args.probe];
  if (!probe) {
    console.error(
      `unknown probe: ${args.probe}\navailable: ${Object.keys(PROBES).join(", ")}`,
    );
    process.exit(2);
  }
  const executablePath = resolveChromium();

  // Ephemeral port; `strictPort: false` lets Vite pick a free one.
  const server = await createServer({
    root: UI_ROOT,
    configFile: path.join(UI_ROOT, "vite.config.ts"),
    logLevel: "error",
    server: { port: 0, strictPort: false },
  });
  await server.listen();
  const base = server.resolvedUrls?.local?.[0];
  if (!base) throw new Error("vite did not report a local URL");

  const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
  const heldModes = args.held === "both" ? [false, true] : [args.held === "1"];
  const rows = [];

  try {
    for (const viewport of args.viewports) {
      const [width, height] = viewport.split("x").map(Number);
      const page = await browser.newPage({ viewport: { width, height } });
      await page.addInitScript({ content: helpersSource });
      for (const n of args.nodes) {
        for (const held of heldModes) {
          const url =
            `${base}lab/?n=${n}&held=${held ? 1 : 0}` +
            `&workflow=${encodeURIComponent(args.workflow)}` +
            (args.extra ? `&${args.extra}` : "");
          await page.goto(url, { waitUntil: "load" });
          // Fonts settle before any ink is measured — see the lab fixture.
          await page.waitForSelector("html[data-lab-ready]");
          await page.waitForSelector(".pc-chart__sheet");
          const result = await page.evaluate(probe);
          rows.push({ vp: viewport, n, held: held ? 1 : 0, ...result });
          if (args.shots) {
            fs.mkdirSync(args.shots, { recursive: true });
            const name = `${args.probe}__${viewport}__n${n}__held${held ? 1 : 0}.png`;
            await page.screenshot({ path: path.join(args.shots, name) });
          }
        }
      }
      await page.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }

  printTable(rows);

  // Probe-specific summaries — the number worth quoting in an issue.
  if (args.probe === "overprint") {
    const bad = rows.filter((r) => r.total > 0);
    const sum = bad.reduce((s, r) => s + r.total, 0);
    console.log(
      `\nink overprint: ${bad.length}/${rows.length} cells, ${sum.toFixed(1)} px² total`,
    );
    for (const r of bad.slice(0, 5)) {
      console.log(`  ${r.vp} n=${r.n} held=${r.held}: ${r.total} px² ${JSON.stringify(r.by)}`);
    }
  }
  if (args.probe === "clipped") {
    const bad = rows.filter((r) => r.clippedPx2 > 0);
    console.log(
      `\nclipped title ink: ${bad.length}/${rows.length} cells` +
        (bad.length ? `, worst ${Math.max(...bad.map((r) => r.clippedPx2))} px²` : ""),
    );
  }
  if (args.probe === "geometry") {
    const scales = rows.map((r) => r.scale).filter((s) => s !== null);
    if (scales.length) {
      console.log(
        `\nsheet scale spans ${Math.min(...scales)}–${Math.max(...scales)} px per viewBox unit` +
          " — a claim measured at one scale says nothing about the others.",
      );
    }
  }

  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify(rows, null, 2));
    console.log(`\nwrote ${rows.length} cells to ${args.json}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
