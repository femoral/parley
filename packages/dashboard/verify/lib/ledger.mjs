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
 * Read PNG IHDR width (big-endian uint32 at byte offset 16).
 * @param {string} filePath
 * @returns {number}
 */
export function readPngWidth(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(24);
    const n = fs.readSync(fd, buf, 0, 24, 0);
    if (n < 24) throw new Error(`PNG too short: ${filePath}`);
    // 89 50 4E 47 0D 0A 1A 0A
    if (
      buf[0] !== 0x89 ||
      buf[1] !== 0x50 ||
      buf[2] !== 0x4e ||
      buf[3] !== 0x47
    ) {
      throw new Error(`not a PNG: ${filePath}`);
    }
    // IHDR chunk type at offset 12
    const type = buf.toString("ascii", 12, 16);
    if (type !== "IHDR") throw new Error(`missing IHDR: ${filePath}`);
    return buf.readUInt32BE(16);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Filename viewport suffix: `*-1460.png` → 1460.
 * @param {string} fileName
 * @returns {number | null}
 */
export function viewportWidthFromShotName(fileName) {
  const m = fileName.match(/-(\d{3,5})\.png$/i);
  if (!m) return null;
  return Number(m[1]);
}

/**
 * Assert every PNG under a shots dir whose name encodes a viewport width
 * actually has that pixel width. Fails any mislabeled ledger shot (#364).
 * @param {string} shotsDir absolute path
 * @returns {{ checked: number, files: Array<{ file: string, expected: number, actual: number }> }}
 */
export function assertLedgerShotWidths(shotsDir) {
  if (!fs.existsSync(shotsDir)) {
    return { checked: 0, files: [] };
  }
  const names = fs.readdirSync(shotsDir).filter((n) => /\.png$/i.test(n));
  /** @type {Array<{ file: string, expected: number, actual: number }>} */
  const checked = [];
  /** @type {string[]} */
  const mismatches = [];
  for (const name of names) {
    const expected = viewportWidthFromShotName(name);
    if (expected == null) continue;
    const abs = path.join(shotsDir, name);
    const actual = readPngWidth(abs);
    checked.push({ file: name, expected, actual });
    if (actual !== expected) {
      mismatches.push(`${name}: filename claims ${expected}px, IHDR is ${actual}px`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `ledger shot width mismatch (${mismatches.length}): ${mismatches.join("; ")}`,
    );
  }
  return { checked: checked.length, files: checked };
}

/**
 * Walk all ticket shot dirs and assert filename width ≡ PNG width.
 * Skips missing shot dirs (shots are gitignored; only asserts when present).
 * @returns {{ tickets: number, files: number }}
 */
export function assertAllLedgerShotWidths() {
  if (!fs.existsSync(LEDGER_ROOT)) return { tickets: 0, files: 0 };
  let tickets = 0;
  let files = 0;
  for (const ent of fs.readdirSync(LEDGER_ROOT, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const shotsDir = path.join(LEDGER_ROOT, ent.name, "shots");
    if (!fs.existsSync(shotsDir)) continue;
    const r = assertLedgerShotWidths(shotsDir);
    if (r.checked > 0) {
      tickets += 1;
      files += r.checked;
    }
  }
  return { tickets, files };
}

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
