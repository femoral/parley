import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../args.js";
import { type CliContext, printJson } from "../context.js";
import { HelpRequested, UsageError } from "../errors.js";

/** Where the skill's repo-relative links point once installed off-repo. */
const REPO_URL = "https://github.com/femoral/parley";
const REPO_BRANCH = "main";

/** The single orchestrator-facing skill parley ships (bundled under skills/). */
const SKILL_NAME = "delegating-to-parley";

/** A known orchestrator skill-directory convention. */
interface Layout {
  /** Human label shown in prompts and output. */
  label: string;
  /** Global skills dir, `~`-relative. */
  global: string;
  /** Project skills dir, relative to the repo root. */
  projectRel: string;
}

/**
 * Known vendor layouts. Extend by adding an entry; the interactive picker and
 * `--layout <key>` both read this table. Any `--layout` value that is not a key
 * here is treated as a custom filesystem path (the escape hatch).
 */
const LAYOUTS: Record<string, Layout> = {
  claude: { label: "Claude Code", global: "~/.claude/skills", projectRel: ".claude/skills" },
  agents: { label: "AGENTS.md ecosystem", global: "~/.agents/skills", projectRel: ".agents/skills" },
};

type FileStatus = "created" | "updated" | "unchanged";
interface FileChange {
  file: string;
  status: FileStatus;
}

/** Absolute path to the bundled `skills/` dir, resolved from this module so it
 * works from a git clone (tsx runs `src/`) and from a published package alike
 * (both keep `skills/` at the same offset relative to `src/cli/commands/`). */
function skillsSourceDir(): string {
  return fileURLToPath(new URL("../../../skills", import.meta.url));
}

/** Expand a leading `~` to the user's home directory. */
function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** The repo root of the current working directory, or a usage error. */
function repoRoot(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
    }).trim();
  } catch {
    throw new UsageError("skills install: --scope project must run inside a git repository");
  }
}

/**
 * Rewrite the skill's repo-relative markdown links so they still resolve once
 * the folder lives outside the repo. Links that escape the skill folder
 * (`../…`) become absolute GitHub blob URLs; sibling links (e.g. `bug-report.md`)
 * and already-absolute/anchor links are left untouched — siblings travel with
 * the folder.
 */
export function rewriteSkillLinks(content: string): string {
  return content.replace(/\]\(([^)]+)\)/g, (whole, rawTarget: string) => {
    const target = rawTarget.trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) return whole;
    if (!target.startsWith("../")) return whole;
    const repoRel = path.posix.normalize(path.posix.join(`skills/${SKILL_NAME}`, target));
    return `](${REPO_URL}/blob/${REPO_BRANCH}/${repoRel})`;
  });
}

/** Collect file paths under `dir`, relative to it (recursively). */
function walkFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Copy the skill folder from `srcDir` to `destDir`, rewriting links in markdown
 * files. Idempotent: existing files are overwritten and each is reported as
 * created/updated/unchanged (the upgrade path).
 */
function copySkill(srcDir: string, destDir: string): FileChange[] {
  const changes: FileChange[] = [];
  for (const rel of walkFiles(srcDir).sort()) {
    const srcPath = path.join(srcDir, rel);
    let content = fs.readFileSync(srcPath, "utf8");
    if (rel.endsWith(".md")) content = rewriteSkillLinks(content);
    const destPath = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    let status: FileStatus;
    if (!fs.existsSync(destPath)) status = "created";
    else if (fs.readFileSync(destPath, "utf8") === content) status = "unchanged";
    else status = "updated";
    fs.writeFileSync(destPath, content);
    changes.push({ file: rel, status });
  }
  return changes;
}

/** Prompt for a single line on a TTY; returns the trimmed answer. */
async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function promptScope(): Promise<"global" | "project"> {
  for (;;) {
    const answer = (await ask("Scope — [g]lobal or [p]roject? ")).toLowerCase();
    if (answer === "g" || answer === "global") return "global";
    if (answer === "p" || answer === "project") return "project";
  }
}

async function promptLayout(): Promise<string> {
  const keys = Object.keys(LAYOUTS);
  let menu = "Vendor layout:\n";
  keys.forEach((k, i) => (menu += `  ${i + 1}) ${LAYOUTS[k]!.label} (${k})\n`));
  menu += `  ${keys.length + 1}) custom path\n`;
  for (;;) {
    const answer = await ask(`${menu}Choose [1-${keys.length + 1}]: `);
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= keys.length) return keys[n - 1]!;
    if (Number.isInteger(n) && n === keys.length + 1) {
      const custom = await ask("Custom skills directory path: ");
      if (custom) return custom;
    }
  }
}

/**
 * `parley skills install` — copy the bundled orchestrator skill into a chosen
 * skill directory. Interactive by default; `--scope`/`--layout` make it
 * scriptable. Re-running overwrites the installed copy (upgrade path).
 */
async function runSkillsInstall(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--scope": { value: true },
    "--layout": { value: true },
    "--json": {},
  });
  if (positionals.length > 0) {
    throw new UsageError(`skills install: unexpected argument: ${positionals[0]}`);
  }
  const json = flags["--json"] === true;
  const interactive = Boolean(process.stdin.isTTY) && !json;

  let layout = flags["--layout"] as string | undefined;
  let scope = flags["--scope"] as string | undefined;

  if (layout === undefined) {
    if (!interactive) {
      throw new UsageError(
        "skills install: --layout <claude|agents|path> is required (non-interactive)",
      );
    }
    layout = await promptLayout();
  }

  const known = LAYOUTS[layout];
  let base: string;
  let layoutLabel: string;
  if (known) {
    if (scope === undefined) {
      if (!interactive) {
        throw new UsageError(
          "skills install: --scope <global|project> is required (non-interactive)",
        );
      }
      scope = await promptScope();
    }
    if (scope !== "global" && scope !== "project") {
      throw new UsageError(`skills install: --scope must be 'global' or 'project', got '${scope}'`);
    }
    base =
      scope === "global"
        ? expandHome(known.global)
        : path.join(repoRoot(process.cwd()), known.projectRel);
    layoutLabel = `${known.label} (${scope})`;
  } else {
    // Custom path escape hatch — scope is irrelevant to an explicit directory.
    base = path.resolve(expandHome(layout));
    layoutLabel = "custom path";
    scope = undefined;
  }

  const srcDir = path.join(skillsSourceDir(), SKILL_NAME);
  if (!fs.existsSync(srcDir)) {
    throw new UsageError(`skills install: bundled skill not found at ${srcDir}`);
  }
  const destDir = path.join(base, SKILL_NAME);
  const changes = copySkill(srcDir, destDir);

  if (json) {
    printJson(ctx, { skill: SKILL_NAME, dest: destDir, layout: layoutLabel, scope, changes });
    return 0;
  }
  ctx.stdout(`Installed skill '${SKILL_NAME}' → ${destDir}\n`);
  ctx.stdout(`  layout: ${layoutLabel}\n`);
  for (const c of changes) ctx.stdout(`  ${c.status.padEnd(9)} ${c.file}\n`);
  return 0;
}

/** `parley skills list` — the skills bundled with parley, available to install. */
function runSkillsList(ctx: CliContext, args: string[]): number {
  const { positionals, flags } = parseArgs(args, { "--json": {} });
  if (positionals.length > 0) {
    throw new UsageError(`skills list: unexpected argument: ${positionals[0]}`);
  }
  const src = skillsSourceDir();
  const names = fs.existsSync(src)
    ? fs
        .readdirSync(src, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    : [];
  if (flags["--json"] === true) {
    printJson(ctx, { skills: names });
    return 0;
  }
  if (names.length === 0) ctx.stdout("No bundled skills.\n");
  else {
    ctx.stdout("Bundled skills (install with `parley skills install`):\n");
    for (const name of names) ctx.stdout(`  ${name}\n`);
  }
  return 0;
}

/**
 * `parley skills <install|list>` — manage the orchestrator skills parley ships.
 */
export async function runSkills(ctx: CliContext, args: string[]): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case "install":
      return runSkillsInstall(ctx, args.slice(1));
    case "list":
      return runSkillsList(ctx, args.slice(1));
    case "-h":
    case "--help":
      throw new HelpRequested(sub);
    default:
      throw new UsageError(
        sub === undefined ? "usage: parley skills install|list" : `skills: unknown subcommand: ${sub}`,
      );
  }
}
