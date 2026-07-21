import { spawnSync } from "node:child_process";
import * as p from "@clack/prompts";
import type { CliContext } from "../../context.js";
import { PromptCancelled } from "../skills/prompts.js";
import { bundledPluginsForHarnesses, type BundledPlugin } from "./list.js";

export interface PluginSetupResult {
  available: string[];
  selected: string[];
  installed: string[];
  warnings: string[];
}

async function selectPlugins(plugins: BundledPlugin[]): Promise<BundledPlugin[]> {
  const selected = await p.multiselect({
    message: "Set up first-party session-provenance plugins",
    options: plugins.map((plugin) => ({
      value: plugin.harness,
      label: plugin.packageName,
      hint: plugin.description,
    })),
    initialValues: plugins.map((plugin) => plugin.harness),
    required: false,
  });
  if (p.isCancel(selected)) {
    p.cancel("Cancelled.");
    throw new PromptCancelled();
  }
  const ids = new Set(selected);
  return plugins.filter((plugin) => ids.has(plugin.harness));
}

/** Offer/install ADR-0013 provenance plugins for detected supported harnesses. */
export async function setupBundledPlugins(opts: {
  ctx: CliContext;
  harnesses: readonly string[];
  interactive: boolean;
  yes: boolean;
  json: boolean;
  cwd: string;
}): Promise<PluginSetupResult> {
  const available = bundledPluginsForHarnesses(opts.harnesses);
  if (available.length === 0) {
    return { available: [], selected: [], installed: [], warnings: [] };
  }
  // JSON is reporting-oriented and cannot prompt. --yes explicitly accepts setup defaults.
  const selected = opts.interactive
    ? await selectPlugins(available)
    : opts.yes && !opts.json
      ? available
      : [];
  const result: PluginSetupResult = {
    available: available.map((plugin) => plugin.harness),
    selected: selected.map((plugin) => plugin.harness),
    installed: [],
    warnings: [],
  };

  for (const plugin of selected) {
    let succeeded = true;
    for (const [bin, ...args] of plugin.commands) {
      const command = spawnSync(bin!, args, {
        cwd: opts.cwd,
        env: opts.ctx.env,
        encoding: "utf8",
      });
      if (command.status !== 0) {
        succeeded = false;
        const detail = command.stderr?.trim() || command.error?.message || `exit ${command.status}`;
        result.warnings.push(`${plugin.packageName}: ${detail}`);
        break;
      }
    }
    if (succeeded) result.installed.push(plugin.harness);
  }
  return result;
}
