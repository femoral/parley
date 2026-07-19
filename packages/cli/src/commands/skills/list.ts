import { parseArgs } from "../../args.js";
import { type CliContext, printJson } from "../../context.js";
import { UsageError } from "../../errors.js";
import { listBundledSkillNames, readSkillDescription } from "./copy.js";

/** `parley skills list` — the skills bundled with parley, available to install. */
export function runSkillsList(ctx: CliContext, args: string[]): number {
  const { positionals, flags } = parseArgs(args, { "--json": {} });
  if (positionals.length > 0) {
    throw new UsageError(`skills list: unexpected argument: ${positionals[0]}`);
  }

  const names = listBundledSkillNames();
  const skills = names.map((name) => ({
    name,
    description: readSkillDescription(name) ?? "",
  }));

  if (flags["--json"] === true) {
    printJson(ctx, { skills });
    return 0;
  }

  if (skills.length === 0) {
    ctx.stdout("No bundled skills.\n");
    return 0;
  }

  ctx.stdout("Bundled skills (install with `parley init`):\n");
  for (const s of skills) {
    if (s.description) ctx.stdout(`  ${s.name}  ${s.description}\n`);
    else ctx.stdout(`  ${s.name}\n`);
  }
  return 0;
}
