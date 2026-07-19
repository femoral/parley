import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UsageError } from "../../errors.js";

/** Where the skill's repo-relative links point once installed off-repo. */
const REPO_URL = "https://github.com/femoral/parley";
const REPO_BRANCH = "main";

/** A known orchestrator skill-directory convention. */
export interface Layout {
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
export const LAYOUTS: Record<string, Layout> = {
  claude: { label: "Claude Code", global: "~/.claude/skills", projectRel: ".claude/skills" },
  agents: { label: "AGENTS.md ecosystem", global: "~/.agents/skills", projectRel: ".agents/skills" },
};

export type FileStatus = "created" | "updated" | "unchanged";
export interface FileChange {
  file: string;
  status: FileStatus;
}

/** One resolved install destination (skills land as `<base>/<skillName>/`). */
export interface InstallTarget {
  /** Absolute skills directory (parent of per-skill folders). */
  base: string;
  /** Human label for summaries (e.g. "Claude Code (global)"). */
  layoutLabel: string;
  /** Layout key, or the custom path string. */
  layout: string;
  /** Scope when a known layout was used; undefined for custom paths. */
  scope?: "global" | "project";
}

/** One skill installed into one target. */
export interface InstallRecord {
  skill: string;
  dest: string;
  layout: string;
  scope: "global" | "project" | undefined;
  changes: FileChange[];
}

/**
 * Absolute path to the bundled `skills/` dir. Resolves from this module so it
 * works from a git clone (tsx runs `src/`) and from a published package alike.
 * `PARLEY_SKILLS_SOURCE` overrides for tests (fixture multi-skill bundles).
 */
export function skillsSourceDir(): string {
  const override = process.env.PARLEY_SKILLS_SOURCE;
  if (override) return path.resolve(override);
  // skills/ lives at the package root; this file is under src/commands/skills/.
  return fileURLToPath(new URL("../../../skills", import.meta.url));
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** The repo root of the current working directory, or a usage error. */
export function repoRoot(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
    }).trim();
  } catch {
    throw new UsageError("--scope project must run inside a git repository");
  }
}

/** True when `cwd` is inside a git working tree. */
export function isGitRepo(cwd: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/** Enumerate bundled skill directory names (sorted). */
export function listBundledSkillNames(): string[] {
  const src = skillsSourceDir();
  if (!fs.existsSync(src)) return [];
  return fs
    .readdirSync(src, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * Read the `description:` field from a skill's SKILL.md YAML frontmatter.
 * Returns undefined when the file or field is missing.
 */
export function readSkillDescription(skillName: string): string | undefined {
  const skillMd = path.join(skillsSourceDir(), skillName, "SKILL.md");
  if (!fs.existsSync(skillMd)) return undefined;
  return parseSkillDescription(fs.readFileSync(skillMd, "utf8"));
}

/** Parse `description:` from SKILL.md frontmatter content. */
export function parseSkillDescription(content: string): string | undefined {
  if (!content.startsWith("---")) return undefined;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return undefined;
  const frontmatter = content.slice(3, end);
  const match = frontmatter.match(/^description:\s*(.*)$/m);
  if (!match) return undefined;
  let value = match[1]!.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value.length > 0 ? value : undefined;
}

/**
 * Rewrite the skill's repo-relative markdown links so they still resolve once
 * the folder lives outside the repo. Links that escape the skill folder
 * (`../…`) become absolute GitHub blob URLs; sibling links (e.g. `bug-report.md`)
 * and already-absolute/anchor links are left untouched — siblings travel with
 * the folder.
 */
export function rewriteSkillLinks(content: string, skillName: string): string {
  return content.replace(/\]\(([^)]+)\)/g, (whole, rawTarget: string) => {
    const target = rawTarget.trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) return whole;
    if (!target.startsWith("../")) return whole;
    const repoRel = path.posix.normalize(path.posix.join(`skills/${skillName}`, target));
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
export function copySkill(srcDir: string, destDir: string, skillName: string): FileChange[] {
  const changes: FileChange[] = [];
  for (const rel of walkFiles(srcDir).sort()) {
    const srcPath = path.join(srcDir, rel);
    let content = fs.readFileSync(srcPath, "utf8");
    if (rel.endsWith(".md")) content = rewriteSkillLinks(content, skillName);
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

/**
 * Install each skill into each target. Writes happen only when this is called —
 * callers should finish all prompting first.
 */
export function installSkills(skillNames: string[], targets: InstallTarget[]): InstallRecord[] {
  const records: InstallRecord[] = [];
  for (const target of targets) {
    for (const skill of skillNames) {
      const srcDir = path.join(skillsSourceDir(), skill);
      if (!fs.existsSync(srcDir)) {
        throw new UsageError(`skills install: bundled skill not found: ${skill}`);
      }
      const destDir = path.join(target.base, skill);
      const changes = copySkill(srcDir, destDir, skill);
      records.push({
        skill,
        dest: destDir,
        layout: target.layoutLabel,
        scope: target.scope,
        changes,
      });
    }
  }
  return records;
}

/** Count created/updated/unchanged from a change list. */
export function countChanges(changes: FileChange[]): {
  created: number;
  updated: number;
  unchanged: number;
} {
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  for (const c of changes) {
    if (c.status === "created") created++;
    else if (c.status === "updated") updated++;
    else unchanged++;
  }
  return { created, updated, unchanged };
}

/**
 * Compact tree: target → skill → n created / n updated / n unchanged.
 * Suitable for plain stdout or a clack `note`.
 */
export function formatInstallSummary(records: InstallRecord[]): string {
  // Group by parent skills dir, preserving first-seen order.
  const byTarget = new Map<string, InstallRecord[]>();
  for (const r of records) {
    const parent = path.dirname(r.dest);
    const groupKey = `${r.layout}\0${parent}`;
    const list = byTarget.get(groupKey) ?? [];
    list.push(r);
    byTarget.set(groupKey, list);
  }

  const lines: string[] = [];
  for (const [, group] of byTarget) {
    const first = group[0]!;
    const parent = path.dirname(first.dest);
    lines.push(`${first.layout}`);
    lines.push(`  ${parent}`);
    group.forEach((r, i) => {
      const { created, updated, unchanged } = countChanges(r.changes);
      const branch = i === group.length - 1 ? "└─" : "├─";
      lines.push(
        `  ${branch} ${r.skill}  ${created} created / ${updated} updated / ${unchanged} unchanged`,
      );
    });
  }
  return lines.join("\n");
}

/** Resolve a known layout key + scope into an InstallTarget. */
export function resolveKnownTarget(
  layoutKey: string,
  scope: "global" | "project",
  cwd: string,
): InstallTarget {
  const known = LAYOUTS[layoutKey];
  if (!known) {
    throw new UsageError(`skills install: unknown layout '${layoutKey}'`);
  }
  const base =
    scope === "global"
      ? expandHome(known.global)
      : path.join(repoRoot(cwd), known.projectRel);
  return {
    base,
    layoutLabel: `${known.label} (${scope})`,
    layout: layoutKey,
    scope,
  };
}

/** Resolve a custom filesystem path into an InstallTarget. */
export function resolveCustomTarget(layoutPath: string): InstallTarget {
  const base = path.resolve(expandHome(layoutPath));
  return {
    base,
    layoutLabel: "custom path",
    layout: layoutPath,
    scope: undefined,
  };
}
