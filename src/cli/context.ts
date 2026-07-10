import type { HomePaths } from "../home.js";

/** Everything a command needs to run and produce observable effects. */
export interface CliContext {
  paths: HomePaths;
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** Print an object as a single line of JSON to stdout. */
export function printJson(ctx: CliContext, value: unknown): void {
  ctx.stdout(`${JSON.stringify(value)}\n`);
}
