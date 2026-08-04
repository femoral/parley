/**
 * #330 — browser export condition: node-free barrel invariant.
 *
 * The browser entry must stay a strict subset of the main barrel and must
 * never pull Node builtins (directly or transitively).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as browser from "../src/browser.js";
import * as main from "../src/index.js";

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

/** Resolve a relative `./foo.js` import from a file under `src/`. */
function resolveImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(base)) return base;
  if (fs.existsSync(base.replace(/\.js$/, ".ts"))) return base.replace(/\.js$/, ".ts");
  if (fs.existsSync(`${base}.ts`)) return `${base}.ts`;
  return null;
}

/**
 * Collect local *value* ESM import/export targets from a TypeScript source file.
 * Type-only edges (`import type`, `export type`, `import { type X }`) are erased
 * at emit and must not pull host modules into the browser runtime graph.
 */
function localValueSpecs(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  const specs: string[] = [];
  // Value import/export-from: skip pure type forms.
  const fromRe =
    /\b(?:import|export)\s+(?!type\b)(?:[^'"\n;]*?\s+from\s+)["'](\.[^"']+)["']/g;
  for (const m of text.matchAll(fromRe)) {
    const full = m[0];
    const spec = m[1];
    if (!spec) continue;
    // `import { type Foo }` / `export { type Foo }` — only types, no runtime edge.
    if (/\b(?:import|export)\s*\{[^}]*\btype\b[^}]*\}\s*from\b/.test(full)) {
      const stripped = full
        .replace(/\{([^}]*)\}/, (_, inner: string) => {
          const valueNames = inner
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s !== "" && !/^type\b/.test(s));
          return `{${valueNames.join(",")}}`;
        });
      if (/\{\s*\}/.test(stripped)) continue;
    }
    specs.push(spec);
  }
  // Side-effect imports: import "./x.js"
  const side = /\bimport\s+["'](\.[^"']+)["']/g;
  for (const m of text.matchAll(side)) {
    const spec = m[1];
    if (spec) specs.push(spec);
  }
  return specs;
}

/** Walk the browser entry's local import graph; return every visited file. */
function walkBrowserGraph(): string[] {
  const entry = path.join(SRC_ROOT, "browser.ts");
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of localValueSpecs(file)) {
      const next = resolveImport(file, spec);
      if (next) queue.push(next);
    }
  }
  return [...seen];
}

describe("browser barrel (#330)", () => {
  it("exports the UI-facing surface the main barrel also has", () => {
    expect(browser.ParleyClient).toBe(main.ParleyClient);
    expect(browser.formatStepAddress).toBe(main.formatStepAddress);
    expect(browser.attentionRank).toBe(main.attentionRank);
    expect(browser.isMetricsGroupBy).toBe(main.isMetricsGroupBy);
    expect(browser.bootstrapTaskStream).toBe(main.bootstrapTaskStream);
    expect(browser.ATTENTION_ORDER).toEqual(main.ATTENTION_ORDER);
    expect(browser.TASK_SIZES).toEqual(main.TASK_SIZES);
    expect(browser.TASK_DIFFICULTIES).toEqual(main.TASK_DIFFICULTIES);
  });

  it("omits host-only symbols that pull Node builtins", () => {
    const b = browser as Record<string, unknown>;
    const m = main as Record<string, unknown>;
    for (const name of [
      "resolveHome",
      "homePaths",
      "readConfig",
      "loadCatalog",
      "sessionStatePath",
      "discoverWorkflows",
      "formatTmpDirRel",
      "tmpHandoffPaths",
      "collapseOperatorHomeInText",
    ] as const) {
      expect(m[name], `${name} should exist on main barrel`).toBeTypeOf("function");
      expect(b[name], `${name} must not be on browser barrel`).toBeUndefined();
    }
  });

  it("formatStepAddress is pure string formatting", () => {
    expect(browser.formatStepAddress({ node: "implement", iteration: 1 })).toBe("implement.1");
    expect(
      browser.formatStepAddress({
        node: "review",
        iteration: 2,
        slot: "correctness",
        retry: 1,
      }),
    ).toBe("review.2.correctness-r1");
  });

  it("browser import graph never mentions node: builtins", () => {
    const files = walkBrowserGraph();
    expect(files.some((f) => f.endsWith(`${path.sep}browser.ts`))).toBe(true);
    // Must not reach host-only modules.
    for (const bad of [
      "home.ts",
      "config.ts",
      "models.ts",
      "vendor-home.ts",
      "session-state.ts",
      "project-lint.ts",
      "address.ts",
      "discovery.ts",
      "definition.ts",
      "lint.ts",
    ]) {
      expect(
        files.some((f) => f.endsWith(`${path.sep}${bad}`)),
        `browser graph must not include ${bad}`,
      ).toBe(false);
    }
    const nodeImport = /from\s+["']node:|import\s+["']node:|require\(["']node:/;
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      expect(text, `${path.relative(SRC_ROOT, file)} imports a node: builtin`).not.toMatch(
        nodeImport,
      );
    }
  });
});
