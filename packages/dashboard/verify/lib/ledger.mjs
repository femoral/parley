/**
 * Proof-ledger writer.
 *
 * Per-ticket proofs land under `verify/ledger/<ticket-id>/`:
 *   entry.json   — measurements, a11y, metadata (committed when small)
 *   shots/       — PNGs (gitignored; bulky)
 *
 * Paths stored in entry.json are relative to the ticket ledger dir.
 */
import fs from "node:fs";
import path from "node:path";
import { LEDGER_ROOT, VERIFY_ROOT, relFromRepo } from "./paths.mjs";

/**
 * @param {string} ticketId e.g. "issue-353"
 * @returns {{ dir: string, shotsDir: string, entryPath: string }}
 */
export function ledgerDirs(ticketId) {
  const dir = path.join(LEDGER_ROOT, ticketId);
  const shotsDir = path.join(dir, "shots");
  fs.mkdirSync(shotsDir, { recursive: true });
  return {
    dir,
    shotsDir,
    entryPath: path.join(dir, "entry.json"),
  };
}

/**
 * Write or merge a named demo proof into the ticket ledger entry.
 * @param {string} ticketId
 * @param {string} demoId  e.g. "staged-daemon" | "intercept-error" | "reconnect"
 * @param {object} proof   serializable proof payload
 */
export function writeDemoProof(ticketId, demoId, proof) {
  const { dir, entryPath } = ledgerDirs(ticketId);
  /** @type {object} */
  let entry = {
    ticket: ticketId,
    package: "@useparley/dashboard",
    harness: relFromRepo(VERIFY_ROOT),
    demos: {},
  };
  if (fs.existsSync(entryPath)) {
    try {
      entry = JSON.parse(fs.readFileSync(entryPath, "utf8"));
    } catch {
      /* rewrite */
    }
  }
  entry.demos = entry.demos ?? {};
  entry.demos[demoId] = {
    ...proof,
    recordedAt: new Date().toISOString(),
  };
  entry.updatedAt = new Date().toISOString();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(entryPath, `${JSON.stringify(entry, null, 2)}\n`);
  return entryPath;
}

/**
 * Read a ticket ledger entry if present.
 * @param {string} ticketId
 */
export function readLedger(ticketId) {
  const { entryPath } = ledgerDirs(ticketId);
  if (!fs.existsSync(entryPath)) return null;
  return JSON.parse(fs.readFileSync(entryPath, "utf8"));
}

/**
 * Pretty-print a compact rect table for one demo's viewports to stdout.
 * @param {string} demoId
 * @param {Array<object>} viewports
 */
export function printRectSummary(demoId, viewports) {
  console.log(`\n=== ${demoId} — measured rects ===`);
  for (const vp of viewports) {
    console.log(`\nviewport ${vp.name} (${vp.width}×${vp.height})`);
    const rows = Object.entries(vp.elements ?? {}).map(([id, m]) => {
      if (!m.found || !m.box) return { id, box: "(missing)" };
      const b = m.box;
      return {
        id,
        x: b.x,
        y: b.y,
        w: b.width,
        h: b.height,
        bg: m.styles?.backgroundColor ?? "",
        color: m.styles?.color ?? "",
      };
    });
    const keys = ["id", "x", "y", "w", "h", "bg", "color"];
    const widths = keys.map((k) =>
      Math.max(k.length, ...rows.map((r) => String(r[k] ?? "").length)),
    );
    const line = (cells) =>
      cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
    console.log(line(keys));
    console.log(widths.map((w) => "-".repeat(w)).join("  "));
    for (const r of rows) console.log(line(keys.map((k) => r[k] ?? "")));
  }
}
