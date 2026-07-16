import { parseArgs } from "../../args.js";
import { type CliContext, printJson } from "../../context.js";
import { UsageError } from "../../errors.js";
import {
  LAYOUTS,
  type InstallRecord,
  type InstallTarget,
  formatInstallSummary,
  installSkills,
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

/**
 * `parley skills install` — copy bundled orchestrator skill(s) into chosen
 * skill directories. Interactive (TTY) by default with a clack multi-select
 * flow; `--layout`/`--scope`/`--skill`/`--yes` make it scriptable for CI.
 */
export async function runSkillsInstall(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--scope": { value: true },
    "--layout": { value: true },
    "--skill": { value: true, multi: true },
    "--yes": {},
    "--json": {},
  });
  if (positionals.length > 0) {
    throw new UsageError(`skills install: unexpected argument: ${positionals[0]}`);
  }

  const json = flags["--json"] === true;
  const yes = flags["--yes"] === true;
  const interactive = Boolean(process.stdin.isTTY) && !json;
  const cwd = process.cwd();

  const bundled = listBundledSkillNames();
  const skillFlag = flags["--skill"];
  const requestedSkills = Array.isArray(skillFlag)
    ? skillFlag
    : typeof skillFlag === "string"
      ? [skillFlag]
      : undefined;

  let skillNames: string[];
  if (requestedSkills !== undefined) {
    for (const name of requestedSkills) {
      if (!bundled.includes(name)) {
        throw new UsageError(
          `skills install: unknown skill '${name}' (bundled: ${bundled.join(", ") || "none"})`,
        );
      }
    }
    skillNames = requestedSkills;
  } else {
    skillNames = bundled;
  }

  if (skillNames.length === 0) {
    throw new UsageError("skills install: no bundled skills to install");
  }

  let targets: InstallTarget[];

  const layoutFlag = flags["--layout"] as string | undefined;
  let scopeFlag = flags["--scope"] as string | undefined;

  if (layoutFlag === undefined) {
    // Full interactive plan when on a TTY; flags-only error otherwise.
    if (!interactive) {
      throw new UsageError(
        "skills install: --layout <claude|agents|path> is required (non-interactive)",
      );
    }
    try {
      const plan = await promptInstallPlan({
        initialSkills: skillNames,
        yes,
        cwd,
      });
      skillNames = plan.skills;
      targets = plan.targets;
    } catch (err) {
      if (err instanceof PromptCancelled) return CANCEL_EXIT;
      throw err;
    }
  } else {
    // Flags path (and partial interactive fill-in for missing scope).
    const known = LAYOUTS[layoutFlag];
    if (known) {
      if (scopeFlag === undefined) {
        if (!interactive) {
          throw new UsageError(
            "skills install: --scope <global|project> is required (non-interactive)",
          );
        }
        if (yes) {
          scopeFlag = "global";
        } else {
          try {
            scopeFlag = await promptMissingScope();
          } catch (err) {
            if (err instanceof PromptCancelled) return CANCEL_EXIT;
            throw err;
          }
        }
      }
      if (scopeFlag !== "global" && scopeFlag !== "project") {
        throw new UsageError(
          `skills install: --scope must be 'global' or 'project', got '${scopeFlag}'`,
        );
      }
      targets = [resolveKnownTarget(layoutFlag, scopeFlag, cwd)];
    } else {
      // Custom path escape hatch — scope is irrelevant to an explicit directory.
      targets = [resolveCustomTarget(layoutFlag)];
    }
  }

  const runCopy = (): InstallRecord[] => installSkills(skillNames, targets);

  let records: InstallRecord[];
  if (interactive) {
    // Spinner + summary note + outro after all prompts (no partial writes before).
    try {
      records = await withInstallSpinner("Installing skills…", runCopy, (r) => ({
        summary: formatInstallSummary(r),
        nextSteps: nextStepsMessage(skillNames),
      }));
    } catch (err) {
      if (err instanceof PromptCancelled) return CANCEL_EXIT;
      throw err;
    }
  } else {
    records = runCopy();
  }

  if (json) {
    printJson(ctx, {
      installs: records.map((r) => ({
        skill: r.skill,
        dest: r.dest,
        layout: r.layout,
        scope: r.scope ?? null,
        changes: r.changes,
      })),
    });
    return 0;
  }

  // Non-interactive: plain text tree summary (interactive already used clack note).
  if (!interactive) {
    ctx.stdout(`${formatInstallSummary(records)}\n`);
  }
  return 0;
}
