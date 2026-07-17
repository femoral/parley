import fs from "node:fs";
import path from "node:path";
import {
  formatLintFinding,
  lintProjectSurfaces,
  PROJECT_CLASSIFICATION_REL,
  PROJECT_CONFIG_REL,
  PROJECT_RUBRICS_DIR_REL,
  type ProjectLintInput,
} from "@useparley/core";
import { parseArgs } from "../args.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";

/**
 * Read a JSON file when present. Returns `{ missing: true }` on ENOENT,
 * `{ jsonError }` on parse failure, or `{ value }` on success.
 */
function readOptionalJson(
  filePath: string,
):
  | { missing: true }
  | { jsonError: string }
  | { value: unknown } {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { missing: true };
    return { jsonError: err instanceof Error ? err.message : String(err) };
  }
  try {
    return { value: JSON.parse(text) as unknown };
  } catch (err) {
    return { jsonError: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Load project surfaces from disk into the pure lint input shape. Shared with
 * the daemon only through `@useparley/core` parse/validate helpers — this I/O
 * layer is CLI-only.
 */
export function loadProjectLintInput(projectRoot: string): ProjectLintInput {
  const input: ProjectLintInput = {};

  const configPath = path.join(projectRoot, PROJECT_CONFIG_REL);
  const config = readOptionalJson(configPath);
  if ("jsonError" in config) input.configJsonError = config.jsonError;
  else if ("value" in config) input.config = config.value;

  const classPath = path.join(projectRoot, PROJECT_CLASSIFICATION_REL);
  const classification = readOptionalJson(classPath);
  if ("jsonError" in classification) {
    input.classificationJsonError = classification.jsonError;
  } else if ("value" in classification) {
    input.classification = classification.value;
  }

  const rubricsDir = path.join(projectRoot, PROJECT_RUBRICS_DIR_REL);
  const rubrics: Record<string, unknown> = {};
  const rubricJsonErrors: Record<string, string> = {};
  let names: string[] = [];
  try {
    names = fs.readdirSync(rubricsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Unreadable rubrics dir is a file-level error on the directory itself.
      input.rubricJsonErrors = {
        _: err instanceof Error ? err.message : String(err),
      };
      return input;
    }
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (id === "") continue;
    const file = readOptionalJson(path.join(rubricsDir, name));
    if ("jsonError" in file) rubricJsonErrors[id] = file.jsonError;
    else if ("value" in file) rubrics[id] = file.value;
  }
  if (Object.keys(rubrics).length > 0) input.rubrics = rubrics;
  if (Object.keys(rubricJsonErrors).length > 0) input.rubricJsonErrors = rubricJsonErrors;
  return input;
}

/**
 * `parley lint [dir]` — validate project `.parley` surfaces (config,
 * classification, rubrics). CI-friendly: exit 1 on any error, exit 0 when
 * clean (warnings still print). Uses the same validation as the daemon's
 * hot-read (#161).
 */
export async function runLint(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--json": {},
  });
  if (positionals.length > 1) {
    throw new UsageError(`lint: unexpected argument: ${positionals[1]}`);
  }
  const projectRoot =
    positionals[0] !== undefined ? path.resolve(positionals[0]) : process.cwd();

  let st: fs.Stats;
  try {
    st = fs.statSync(projectRoot);
  } catch {
    throw new UsageError(`lint: no such directory: ${projectRoot}`);
  }
  if (!st.isDirectory()) {
    throw new UsageError(`lint: not a directory: ${projectRoot}`);
  }

  const input = loadProjectLintInput(projectRoot);
  // The pure core function is the single validation implementation.
  const result = lintProjectSurfaces(input);

  if (flags["--json"] === true) {
    printJson(ctx, {
      ok: result.ok,
      findings: result.findings,
    });
  } else if (result.findings.length === 0) {
    ctx.stdout("ok: .parley surfaces are valid\n");
  } else {
    for (const f of result.findings) {
      const line = formatLintFinding(f);
      if (f.severity === "error") ctx.stderr(`${line}\n`);
      else ctx.stdout(`${line}\n`);
    }
    if (result.ok) {
      ctx.stdout(`ok: ${result.findings.length} warning(s), no errors\n`);
    }
  }

  return result.ok ? 0 : 1;
}
