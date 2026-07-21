export interface BundledPlugin {
  harness: "claude" | "codex" | "grok" | "pi";
  packageName: string;
  description: string;
  commands: ReadonlyArray<ReadonlyArray<string>>;
}

const BUNDLED_PLUGINS: readonly BundledPlugin[] = [
  {
    harness: "claude",
    packageName: "@useparley/plugin-claude-code",
    description: "Claude Code session provenance",
    commands: [
      ["claude", "plugin", "marketplace", "add", "useparley/parley"],
      ["claude", "plugin", "install", "parley@useparley"],
    ],
  },
  {
    harness: "codex",
    packageName: "@useparley/plugin-codex",
    description: "Codex session provenance",
    commands: [
      ["codex", "plugin", "marketplace", "add", "useparley/parley"],
      ["codex", "plugin", "add", "parley@useparley"],
    ],
  },
  {
    harness: "grok",
    packageName: "@useparley/plugin-grok",
    description: "Grok Build session provenance",
    commands: [
      ["grok", "plugin", "install", "femoral/parley#packages/plugins/grok", "--trust"],
      ["grok", "plugin", "enable", "parley-provenance"],
    ],
  },
  {
    harness: "pi",
    packageName: "@useparley/plugin-pi",
    description: "Pi session provenance",
    commands: [["pi", "install", "npm:@useparley/plugin-pi"]],
  },
];

/** First-party ADR-0013 provenance plugins bundled with the Parley repository. */
export function listBundledPlugins(): BundledPlugin[] {
  return BUNDLED_PLUGINS.map((plugin) => ({
    ...plugin,
    commands: plugin.commands.map((command) => [...command]),
  }));
}

export function bundledPluginsForHarnesses(harnesses: readonly string[]): BundledPlugin[] {
  const detected = new Set(harnesses);
  return listBundledPlugins().filter((plugin) => detected.has(plugin.harness));
}
