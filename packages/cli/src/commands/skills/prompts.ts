import * as p from "@clack/prompts";
import {
  LAYOUTS,
  type InstallTarget,
  isGitRepo,
  listBundledSkillNames,
  readSkillDescription,
  resolveCustomTarget,
  resolveKnownTarget,
} from "./copy.js";

/** Exit code when the user cancels (Ctrl-C / Escape) at a prompt. */
export const CANCEL_EXIT = 130;

export class PromptCancelled extends Error {
  override readonly name = "PromptCancelled";
  constructor() {
    super("cancelled");
  }
}

/** Unwrap a clack result or throw PromptCancelled. */
function orCancel<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel("Cancelled.");
    throw new PromptCancelled();
  }
  return value;
}

export interface InteractivePlan {
  skills: string[];
  targets: InstallTarget[];
}

/**
 * Interactive install flow (TTY): intro → skill multiselect → target multiselect
 * → optional custom path → confirm. No filesystem writes happen here.
 */
export async function promptInstallPlan(opts: {
  /** Pre-selected skill names when `--skill` was passed; otherwise all. */
  initialSkills?: string[];
  /** When true, skip the final confirm (accept defaults). */
  yes?: boolean;
  cwd: string;
}): Promise<InteractivePlan> {
  p.intro("parley skills");

  const bundled = listBundledSkillNames();
  if (bundled.length === 0) {
    p.cancel("No bundled skills to install.");
    throw new PromptCancelled();
  }

  const skillOptions = bundled.map((name) => {
    const desc = readSkillDescription(name);
    return {
      value: name,
      label: name,
      hint: desc,
    };
  });

  const initialSkills =
    opts.initialSkills && opts.initialSkills.length > 0
      ? opts.initialSkills.filter((s) => bundled.includes(s))
      : bundled;

  const skills = orCancel(
    await p.multiselect({
      message: "Skills to install",
      options: skillOptions,
      initialValues: initialSkills,
      required: true,
    }),
  );

  const inRepo = isGitRepo(opts.cwd);
  const targetOptions: { value: string; label: string; hint?: string }[] = [];
  for (const [key, layout] of Object.entries(LAYOUTS)) {
    targetOptions.push({
      value: `${key}:global`,
      label: `${layout.label} · global`,
      hint: layout.global,
    });
    if (inRepo) {
      targetOptions.push({
        value: `${key}:project`,
        label: `${layout.label} · project`,
        hint: layout.projectRel,
      });
    }
  }
  targetOptions.push({
    value: "custom",
    label: "custom path…",
    hint: "any directory",
  });

  const selected = orCancel(
    await p.multiselect({
      message: "Install targets",
      options: targetOptions,
      required: true,
    }),
  );

  const targets: InstallTarget[] = [];
  for (const id of selected) {
    if (id === "custom") {
      const custom = orCancel(
        await p.text({
          message: "Custom skills directory path",
          placeholder: "~/my-skills",
          validate: (v) => {
            if (!v || !v.trim()) return "Path is required";
          },
        }),
      );
      targets.push(resolveCustomTarget(custom.trim()));
      continue;
    }
    const [layoutKey, scope] = id.split(":") as [string, "global" | "project"];
    targets.push(resolveKnownTarget(layoutKey, scope, opts.cwd));
  }

  if (!opts.yes) {
    const summary = [
      `${skills.length} skill${skills.length === 1 ? "" : "s"} → ${targets.length} target${targets.length === 1 ? "" : "s"}`,
      ...targets.map((t) => `  ${t.layoutLabel}: ${t.base}`),
    ].join("\n");
    const ok = orCancel(
      await p.confirm({
        message: `Proceed with install?\n${summary}`,
        initialValue: true,
      }),
    );
    if (!ok) {
      p.cancel("Cancelled.");
      throw new PromptCancelled();
    }
  }

  return { skills, targets };
}

/**
 * When flags partially specify the install on a TTY (e.g. `--layout claude`
 * without `--scope`), fill in the missing choice with a clack select.
 */
export async function promptMissingScope(): Promise<"global" | "project"> {
  const scope = orCancel(
    await p.select({
      message: "Install scope",
      options: [
        { value: "global" as const, label: "global", hint: "user home" },
        { value: "project" as const, label: "project", hint: "repo root" },
      ],
      initialValue: "global" as const,
    }),
  );
  return scope;
}

/** Display a spinner while `work` runs, then a summary note and outro. */
export async function withInstallSpinner<T>(
  label: string,
  work: () => T | Promise<T>,
  onDone: (result: T) => { summary: string; nextSteps: string },
): Promise<T> {
  const s = p.spinner();
  s.start(label);
  try {
    const result = await work();
    s.stop("Installed");
    const { summary, nextSteps } = onDone(result);
    p.note(summary, "Summary");
    p.outro(nextSteps);
    return result;
  } catch (err) {
    s.stop("Install failed");
    throw err;
  }
}

/** Human-readable next-steps blurb after a successful install. */
export function nextStepsMessage(skillNames: string[]): string {
  const listed = skillNames.join(", ");
  return `Skills ready: ${listed}. Agents pick them up from the target skill dirs. Re-run to upgrade.`;
}


