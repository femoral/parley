import { parseArgs } from "../../args.js";
import { type CliContext, printJson } from "../../context.js";
import { UsageError } from "../../errors.js";
import {
  LAYOUTS,
  type InstallRecord,
  type InstallTarget,
  formatInstallSummary,
  installSkills,
  isGitRepo,
  listBundledSkillNames,
  resolveCustomTarget,
  resolveKnownTarget,
} from "./copy.js";
import {
  CANCEL_EXIT,
  PromptCancelled,
  nextStepsMessage,
  promptInstallPlan,
  promptMissingScope,
  withInstallSpinner,
} from "./prompts.js";

/** Parsed skill-install flags shared by `skills install` and `init`. */
export interface SkillInstallFlags {
  layout?: string;
  scope?: string;
  /** Explicit `--skill` values; undefined means all bundled. */
  requestedSkills?: string[];
  yes: boolean;
  json: boolean;
  cwd: string;
}

/**
 * How to fill missing layout/scope when not prompting.
 * - `skills-install`: require flags non-interactively (legacy).
 * - `init`: layout defaults to `agents`; scope to project-if-git else global.
 */
export type SkillInstallMode = "skills-install" | "init";

export interface InstallSkillsFromOptionsInput extends SkillInstallFlags {
  /** Allow TTY prompts when install choices are omitted. */
  interactive: boolean;
  mode: SkillInstallMode;
}

export interface InstallSkillsFromOptionsResult {
  skillNames: string[];
  records: InstallRecord[];
  /** True when clack already printed the human summary (interactive spinner). */
  interactivePrinted: boolean;
}

/** Parse common `--scope` / `--layout` / `--skill` / `--yes` / `--json` flags. */
export function parseSkillInstallArgs(
  args: string[],
  label: string,
): SkillInstallFlags & { positionals: string[] } {
  const { positionals, flags } = parseArgs(args, {
    "--scope": { value: true },
    "--layout": { value: true },
    "--skill": { value: true, multi: true },
    "--yes": {},
    "--json": {},
  });
  if (positionals.length > 0) {
    throw new UsageError(`${label}: unexpected argument: ${positionals[0]}`);
  }
  const skillFlag = flags["--skill"];
  const requestedSkills = Array.isArray(skillFlag)
    ? skillFlag
    : typeof skillFlag === "string"
      ? [skillFlag]
      : undefined;
  return {
    positionals,
    layout: typeof flags["--layout"] === "string" ? flags["--layout"] : undefined,
    scope: typeof flags["--scope"] === "string" ? flags["--scope"] : undefined,
    requestedSkills,
    yes: flags["--yes"] === true,
    json: flags["--json"] === true,
    cwd: process.cwd(),
  };
}

/** Resolve which bundled skills to install (validates names). */
export function resolveSkillNames(
  requestedSkills: string[] | undefined,
  label: string,
): string[] {
  const bundled = listBundledSkillNames();
  let skillNames: string[];
  if (requestedSkills !== undefined) {
    for (const name of requestedSkills) {
      if (!bundled.includes(name)) {
        throw new UsageError(
          `${label}: unknown skill '${name}' (bundled: ${bundled.join(", ") || "none"})`,
        );
      }
    }
    skillNames = requestedSkills;
  } else {
    skillNames = bundled;
  }
  if (skillNames.length === 0) {
    throw new UsageError(`${label}: no bundled skills to install`);
  }
  return skillNames;
}

/** Default scope for `parley init`: project inside a git repo, else global. */
export function defaultInitScope(cwd: string): "global" | "project" {
  return isGitRepo(cwd) ? "project" : "global";
}

/**
 * Shared skill install used by `parley skills install` and `parley init`.
 * Resolves skills + targets, copies bundled folders, optionally shows a spinner.
 */
export async function installSkillsFromOptions(
  opts: InstallSkillsFromOptionsInput,
): Promise<InstallSkillsFromOptionsResult | { cancelled: true }> {
  const label = opts.mode === "init" ? "init" : "skills install";
  let skillNames = resolveSkillNames(opts.requestedSkills, label);
  let targets: InstallTarget[];

  const layoutFlag = opts.layout;
  let scopeFlag = opts.scope;

  if (layoutFlag === undefined) {
    if (!opts.interactive && opts.mode === "init") {
      // Non-interactive init: agents layout + auto scope.
      const scope = scopeFlag ?? defaultInitScope(opts.cwd);
      if (scope !== "global" && scope !== "project") {
        throw new UsageError(`init: --scope must be 'global' or 'project', got '${scope}'`);
      }
      targets = [resolveKnownTarget("agents", scope, opts.cwd)];
    } else if (!opts.interactive) {
      throw new UsageError(
        "skills install: --layout <claude|agents|path> is required (non-interactive)",
      );
    } else {
      try {
        const plan = await promptInstallPlan({
          initialSkills: skillNames,
          yes: opts.yes,
          cwd: opts.cwd,
        });
        skillNames = plan.skills;
        targets = plan.targets;
      } catch (err) {
        if (err instanceof PromptCancelled) return { cancelled: true };
        throw err;
      }
    }
  } else {
    const known = LAYOUTS[layoutFlag];
    if (known) {
      if (scopeFlag === undefined) {
        if (!opts.interactive && opts.mode === "init") {
          scopeFlag = defaultInitScope(opts.cwd);
        } else if (!opts.interactive) {
          throw new UsageError(
            "skills install: --scope <global|project> is required (non-interactive)",
          );
        } else if (opts.yes) {
          scopeFlag = "global";
        } else {
          try {
            scopeFlag = await promptMissingScope();
          } catch (err) {
            if (err instanceof PromptCancelled) return { cancelled: true };
            throw err;
          }
        }
      }
      if (scopeFlag !== "global" && scopeFlag !== "project") {
        throw new UsageError(
          `${label}: --scope must be 'global' or 'project', got '${scopeFlag}'`,
        );
      }
      targets = [resolveKnownTarget(layoutFlag, scopeFlag, opts.cwd)];
    } else {
      // Custom path escape hatch — scope is irrelevant to an explicit directory.
      targets = [resolveCustomTarget(layoutFlag)];
    }
  }

  const runCopy = (): InstallRecord[] => installSkills(skillNames, targets);

  let records: InstallRecord[];
  let interactivePrinted = false;
  if (opts.interactive) {
    try {
      records = await withInstallSpinner("Installing skills…", runCopy, (r) => ({
        summary: formatInstallSummary(r),
        nextSteps: nextStepsMessage(skillNames),
      }));
      interactivePrinted = true;
    } catch (err) {
      if (err instanceof PromptCancelled) return { cancelled: true };
      throw err;
    }
  } else {
    records = runCopy();
  }

  return { skillNames, records, interactivePrinted };
}

/**
 * `parley skills install` — copy bundled orchestrator skill(s) into chosen
 * skill directories. Interactive (TTY) by default with a clack multi-select
 * flow; `--layout`/`--scope`/`--skill`/`--yes` make it scriptable for CI.
 *
 * Deprecated in favor of `parley init` (still installs skills only).
 */
export async function runSkillsInstall(ctx: CliContext, args: string[]): Promise<number> {
  ctx.stderr(
    "warning: `parley skills install` is deprecated; use `parley init` for one-shot setup (skills, config, harnesses, models).\n",
  );

  const parsed = parseSkillInstallArgs(args, "skills install");
  const json = parsed.json;
  const interactive = Boolean(process.stdin.isTTY) && !json;

  const result = await installSkillsFromOptions({
    ...parsed,
    interactive,
    mode: "skills-install",
  });
  if ("cancelled" in result) return CANCEL_EXIT;

  if (json) {
    printJson(ctx, {
      installs: result.records.map((r) => ({
        skill: r.skill,
        dest: r.dest,
        layout: r.layout,
        scope: r.scope ?? null,
        changes: r.changes,
      })),
    });
    return 0;
  }

  if (!result.interactivePrinted) {
    ctx.stdout(`${formatInstallSummary(result.records)}\n`);
  }
  return 0;
}
