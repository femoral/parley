import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules",
      "**/dist",
      "**/coverage",
      "packages/ui/www",
      "packages/dashboard/www",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Two-register wall (#341 / #347): Console must never import Cove and
    // Cove must never import Console. Enforced mechanically both directions.
    // Patterns match the import SPECIFIER string (not the resolved path), so
    // relative walks like `../../ui/src/main.js` need `**/ui/**`-style globs
    // in addition to bare `@useparley/*` / `**/packages/*` forms.
    files: ["packages/dashboard/**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@useparley/ui",
              message:
                "Parley Console must not import Parley Cove (@useparley/ui). " +
                "The two-register wall is absolute; only the brand-mark asset file may be shared.",
            },
          ],
          patterns: [
            {
              group: [
                "@useparley/ui/*",
                "**/packages/ui",
                "**/packages/ui/**",
                // Relative: ../../ui/src/main.js, ../ui/x, etc.
                "**/ui",
                "**/ui/**",
                "*../ui",
                "*../ui/*",
                "*../ui/**",
              ],
              message:
                "Parley Console must not import from packages/ui. " +
                "The two-register wall is absolute.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/ui/**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@useparley/dashboard",
              message:
                "Parley Cove must not import Parley Console (@useparley/dashboard). " +
                "The two-register wall is absolute.",
            },
          ],
          patterns: [
            {
              group: [
                "@useparley/dashboard/*",
                "**/packages/dashboard",
                "**/packages/dashboard/**",
                // Relative: ../../dashboard/src/Shell.js, ../dashboard/x, etc.
                "**/dashboard",
                "**/dashboard/**",
                "*../dashboard",
                "*../dashboard/*",
                "*../dashboard/**",
              ],
              message:
                "Parley Cove must not import from packages/dashboard. " +
                "The two-register wall is absolute.",
            },
          ],
        },
      ],
    },
  },
  {
    // The chart measurement lab's probes execute inside the browser (they are
    // serialized across by Playwright), so they legitimately reference DOM
    // globals from a file the driver runs under Node.
    files: ["packages/ui/lab/**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    // Console verification harness (#353): Node driver scripts evaluate browser
    // snippets via Playwright (document, getComputedStyle, HTMLElement, …).
    files: ["packages/dashboard/verify/**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
);
