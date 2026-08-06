import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";

/**
 * The sandbox enforcement matrix lives in the repo README between HTML
 * markers and is contract-tested against the adapters
 * (packages/daemon/tests/enforcement-matrix.test.ts). The docs page embeds
 * the same table at build time so the two can never drift.
 */
function readEnforcementMatrix(): string {
  const readmePath = path.join(
    fileURLToPath(new URL("../..", import.meta.url)),
    "README.md",
  );
  const readme = fs.readFileSync(readmePath, "utf8");
  const start = readme.indexOf("<!-- enforcement-matrix:start -->");
  const end = readme.indexOf("<!-- enforcement-matrix:end -->");
  if (start < 0 || end < 0) {
    throw new Error("enforcement-matrix markers not found in README.md");
  }
  return readme
    .slice(start + "<!-- enforcement-matrix:start -->".length, end)
    .trim();
}

export default defineConfig({
  title: "Parley",
  description:
    "Give your agent a crew: one orchestrating agent, many coding agents, every branch reviewed before it lands.",
  base: "/parley/",
  lang: "en-US",
  cleanUrls: true,
  appearance: "force-dark",
  head: [
    ["link", { rel: "icon", type: "image/png", href: "/parley/logo.png" }],
    ["meta", { name: "theme-color", content: "#0b0d0f" }],
  ],

  vite: {
    plugins: [
      {
        name: "parley:enforcement-matrix",
        enforce: "pre",
        transform(code, id) {
          if (id.endsWith("guide/vendors.md")) {
            return code.replace("@enforcement-matrix@", readEnforcementMatrix());
          }
        },
      },
    ],
  },

  themeConfig: {
    logo: "/logo.png",
    siteTitle: "Parley",

    nav: [
      { text: "Guide", link: "/guide/what-is-parley", activeMatch: "/guide/" },
      {
        text: "Under the hood",
        link: "/explainer/how-the-orchestrator-works",
        activeMatch: "/explainer/",
      },
      { text: "Reference", link: "/reference/cli", activeMatch: "/reference/" },
    ],

    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "What is Parley", link: "/guide/what-is-parley" },
          { text: "Installation", link: "/guide/installation" },
          { text: "Getting started", link: "/guide/getting-started" },
          { text: "The Console", link: "/guide/console" },
          { text: "Vendors and sandboxing", link: "/guide/vendors" },
          { text: "Configuration and profiles", link: "/guide/configuration" },
          { text: "Workflow runs", link: "/guide/workflows" },
          { text: "Evaluation", link: "/guide/evaluation" },
          { text: "Remote runners", link: "/guide/remote-runners" },
        ],
      },
      {
        text: "Under the hood",
        items: [
          {
            text: "How the orchestrator works",
            link: "/explainer/how-the-orchestrator-works",
          },
          { text: "How children talk back", link: "/explainer/children" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "CLI commands", link: "/reference/cli" },
          { text: "Writing an adapter", link: "/reference/adapter-authoring" },
          { text: "Troubleshooting", link: "/reference/troubleshooting" },
        ],
      },
    ],

    socialLinks: [{ icon: "github", link: "https://github.com/femoral/parley" }],

    search: { provider: "local" },

    footer: {
      message: "Released under the MIT License.",
      copyright: "Parley never merges. Judgment stays with the orchestrator.",
    },

    outline: { level: [2, 3] },
  },
})
