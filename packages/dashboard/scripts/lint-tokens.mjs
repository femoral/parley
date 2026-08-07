/**
 * Dependency-free CSS token lint for Parley Console (#367).
 *
 * Fails when screen/chrome CSS under a source root contains:
 *   - literal `font:` shorthands (must be `font: var(--type-*)`)
 *   - hard-coded hex colors (must live only in tokens.css)
 *
 * tokens.css is the only file allowed to declare hex color values.
 *
 * Usage:
 *   node packages/dashboard/scripts/lint-tokens.mjs
 *   node packages/dashboard/scripts/lint-tokens.mjs --root /path/to/src
 *   LINT_TOKENS_ROOT=/path/to/src node …/lint-tokens.mjs
 *
 * Exit 0 = clean; exit 1 = violations listed on stderr.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(__dirname, "../src");
const tokensName = "tokens.css";

/** font: property whose value is not a single var(--…) token. */
const FONT_DECL = /(^|[{;\s])font\s*:\s*([^;]+)/g;
const HEX = /#[0-9a-fA-F]{3,8}\b/g;

function resolveRoot(argv = process.argv.slice(2), env = process.env) {
  const flagIdx = argv.indexOf("--root");
  if (flagIdx !== -1 && argv[flagIdx + 1]) {
    return path.resolve(argv[flagIdx + 1]);
  }
  const eq = argv.find((a) => a.startsWith("--root="));
  if (eq) return path.resolve(eq.slice("--root=".length));
  if (env.LINT_TOKENS_ROOT) return path.resolve(env.LINT_TOKENS_ROOT);
  return defaultRoot;
}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (ent.name.endsWith(".css")) out.push(full);
  }
  return out;
}

/** Strip block comments (including multi-line) while preserving newlines. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (block) => {
    // Preserve newlines so line numbers stay stable.
    return block.replace(/[^\n]/g, " ");
  });
}

function lintFile(file, srcRoot) {
  const rel = path.relative(srcRoot, file);
  if (path.basename(file) === tokensName) return [];

  const raw = fs.readFileSync(file, "utf8");
  const code = stripComments(raw);
  const lines = code.split(/\r?\n/);
  const hits = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    FONT_DECL.lastIndex = 0;
    let m;
    while ((m = FONT_DECL.exec(line)) !== null) {
      const value = m[2].trim();
      // Allowed: font: var(--type-…); optionally with !important
      if (/^var\(\s*--[\w-]+\s*\)(\s*!important)?$/.test(value)) continue;
      hits.push({
        file: rel,
        line: i + 1,
        kind: "font-literal",
        text: line.trim(),
      });
    }

    HEX.lastIndex = 0;
    if (HEX.test(line)) {
      hits.push({
        file: rel,
        line: i + 1,
        kind: "hex-color",
        text: line.trim(),
      });
    }
  }
  return hits;
}

export function lintTokens(srcRoot) {
  if (!fs.existsSync(srcRoot)) {
    return { files: 0, violations: [{ file: srcRoot, line: 0, kind: "missing-root", text: "source root does not exist" }] };
  }
  const files = walk(srcRoot);
  const violations = files.flatMap((f) => lintFile(f, srcRoot));
  return { files: files.length, violations };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const srcRoot = resolveRoot();
  const { files, violations } = lintTokens(srcRoot);

  if (violations.length > 0) {
    console.error(
      `lint-tokens: ${violations.length} violation(s) — use tokens.css vars only outside tokens.css\n`,
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} [${v.kind}] ${v.text}`);
    }
    process.exit(1);
  }

  console.log(`lint-tokens: ok (${files} css files scanned)`);
}
