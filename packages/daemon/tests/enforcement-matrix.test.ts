/**
 * Sandbox posture enforcement matrix (#279).
 *
 * - Every registered adapter must declare `enforcement`.
 * - README table between HTML markers must match declarations.
 * - Prepare-time diagnostics fire for approximate/none postures.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ENFORCEMENT_DIMENSIONS,
  formatEnforcementCell,
  formatPostureGapDiagnostics,
  type AdapterEnforcement,
  type EnforcementLevel,
} from "@useparley/core";
import { createAdapterRegistrySync } from "../src/adapters/index.js";
import { createKimiAdapter } from "../src/adapters/kimi.js";
import { createOpenhandsAdapter } from "../src/adapters/openhands.js";
import type { HubInfo, TaskSpec } from "../src/adapters/types.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const README_PATH = path.join(REPO_ROOT, "README.md");

const LEVELS: readonly EnforcementLevel[] = [
  "enforced",
  "approximate",
  "none",
  "refused",
];

const HUB: HubInfo = {
  url: "http://127.0.0.1:9/mcp",
  headers: { "x-parley-task": "t279" },
};

function task(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "t279",
    name: null,
    prompt: "p",
    vendor: "x",
    model: null,
    effort: null,
    cwd: "/tmp",
    sandbox: "workspace",
    network: true,
    answerTimeoutMs: 60_000,
    extraArgs: [],
    ...overrides,
  };
}

function parseReadmeMatrix(readme: string): Map<string, Record<string, string>> {
  const start = readme.indexOf("<!-- enforcement-matrix:start -->");
  const end = readme.indexOf("<!-- enforcement-matrix:end -->");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const block = readme.slice(start, end);
  const rows = new Map<string, Record<string, string>>();
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    if (trimmed.includes("---")) continue;
    if (trimmed.toLowerCase().includes("| vendor |")) continue;
    const cells = trimmed
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (cells.length < 5) continue;
    const id = cells[0]!.replace(/^`|`$/g, "");
    if (id === "Vendor") continue;
    rows.set(id, {
      "read-only": cells[1]!,
      workspace: cells[2]!,
      full: cells[3]!,
      "network:false": cells[4]!,
    });
  }
  return rows;
}

describe("adapter enforcement declarations (#279)", () => {
  it("every registered adapter declares a complete enforcement matrix", () => {
    const registry = createAdapterRegistrySync({ PARLEY_FAKE_VENDOR_BIN: "fake" });
    expect(registry.size).toBeGreaterThan(5);
    for (const [id, adapter] of registry) {
      expect(adapter.enforcement, `${id} missing enforcement`).toBeDefined();
      for (const dim of ENFORCEMENT_DIMENSIONS) {
        const cell = adapter.enforcement[dim];
        expect(cell, `${id}.${dim}`).toBeDefined();
        expect(LEVELS, `${id}.${dim}.level`).toContain(cell.level);
        if (cell.via !== undefined) {
          expect(typeof cell.via, `${id}.${dim}.via`).toBe("string");
        }
      }
    }
  });

  it("fails the suite contract if an adapter's declaration is deleted (neuter a)", () => {
    // Neuter proof (a): deleting `enforcement` from VendorAdapter / an adapter
    // object fails typecheck; at runtime the registry assertion above fails
    // because every adapter must have the field. Pin that kimi/openhands are present.
    const registry = createAdapterRegistrySync({});
    expect(registry.get("kimi")?.enforcement["network:false"].level).toBe("none");
    expect(registry.get("openhands")?.enforcement["read-only"].level).toBe("none");
    expect(registry.get("grok")?.enforcement.workspace.level).toBe("enforced");
    expect(registry.get("codex")?.enforcement["read-only"].level).toBe("enforced");
  });
});

describe("README enforcement matrix sync (#279)", () => {
  it("matches adapter declarations between HTML markers (neuter b)", () => {
    const readme = fs.readFileSync(README_PATH, "utf8");
    const table = parseReadmeMatrix(readme);
    const registry = createAdapterRegistrySync({ PARLEY_FAKE_VENDOR_BIN: "fake" });

    const declared = [...registry.entries()]
      .filter(([id]) => id !== "fake")
      .sort(([a], [b]) => a.localeCompare(b));

    expect([...table.keys()].sort()).toEqual(declared.map(([id]) => id));

    for (const [id, adapter] of declared) {
      const row = table.get(id);
      expect(row, `README missing row for ${id}`).toBeDefined();
      for (const dim of ENFORCEMENT_DIMENSIONS) {
        const expected = formatEnforcementCell(adapter.enforcement[dim]);
        expect(row![dim], `${id} ${dim}`).toBe(expected);
      }
    }
  });
});

describe("prepare-time posture diagnostics (#279)", () => {
  it("emits PARLEY-DIAG for approximate/none and stays quiet for enforced (neuter c)", async () => {
    const kimi = createKimiAdapter({});
    const weak = await kimi.prepare(task({ vendor: "kimi", sandbox: "workspace", network: false }), HUB);
    const diags = weak.diagnostics ?? [];
    expect(diags.some((d) => d.startsWith("PARLEY-DIAG posture: kimi sandbox=workspace"))).toBe(
      true,
    );
    expect(diags.some((d) => d.startsWith("PARLEY-DIAG posture: kimi network=false"))).toBe(true);

    const openhands = createOpenhandsAdapter({});
    const oh = await openhands.prepare(
      task({ vendor: "openhands", sandbox: "read-only", network: true }),
      HUB,
    );
    expect(oh.diagnostics?.some((d) => d.includes("sandbox=read-only") && d.includes("none"))).toBe(
      true,
    );

    // Pure helper: enforced cells produce no diagnostic (neuter c target).
    const enforced: AdapterEnforcement = {
      "read-only": { level: "enforced" },
      workspace: { level: "enforced" },
      full: { level: "enforced" },
      "network:false": { level: "enforced" },
    };
    expect(
      formatPostureGapDiagnostics("codex", enforced, { sandbox: "workspace", network: true }),
    ).toEqual([]);
    expect(
      formatPostureGapDiagnostics("codex", enforced, { sandbox: "workspace", network: false }),
    ).toEqual([]);

    // refused is not a prepare diagnostic (prepare throws instead).
    const refused: AdapterEnforcement = {
      "read-only": { level: "approximate" },
      workspace: { level: "none" },
      full: { level: "none" },
      "network:false": { level: "refused", via: "prepare refuses" },
    };
    expect(
      formatPostureGapDiagnostics("pi", refused, { sandbox: "workspace", network: false }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^PARLEY-DIAG posture: pi sandbox=workspace → none/),
      ]),
    );
    // network refused → no network diagnostic line
    expect(
      formatPostureGapDiagnostics("pi", refused, { sandbox: "workspace", network: false }).some(
        (d) => d.includes("network=false"),
      ),
    ).toBe(false);
  });
});
