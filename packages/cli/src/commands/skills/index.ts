import { HelpRequested, UsageError } from "../../errors.js";
import type { CliContext } from "../../context.js";
import { runSkillsInstall } from "./install.js";
import { runSkillsList } from "./list.js";

export { rewriteSkillLinks } from "./copy.js";

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
