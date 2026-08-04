/**
 * `parley clones list|prune` — managed mirror inventory on the daemon host
 * (#318 / ADR-0031). List is client-auth; prune is config-admin / loopback.
 *
 * Runner-host mirrors are under that host's `$PARLEY_HOME/clones/` and are
 * pruned manually (or via a future runner flag) — this verb is daemon-served.
 */
import { parseArgs } from "../args.js";
import {
  DaemonRequestError,
  daemonGet,
  daemonPost,
  ensureDaemon,
} from "../client.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";

interface CloneEntry {
  name: string;
  path: string;
  repo_key: string | null;
  fetch_url: string | null;
  size_bytes: number;
  used?: boolean;
}

interface ClonesListResponse {
  clones: CloneEntry[];
}

interface ClonesPruneResponse {
  removed: CloneEntry[];
  kept: CloneEntry[];
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}M`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)}G`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function formatListTable(clones: CloneEntry[]): string {
  if (clones.length === 0) {
    return "No managed mirrors.\n";
  }
  const headers = ["REPO", "SIZE", "USED", "PATH"] as const;
  const rows = clones.map((c) => [
    c.repo_key ?? c.name,
    formatBytes(c.size_bytes),
    c.used === true ? "yes" : c.used === false ? "no" : "-",
    c.path,
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i]!.length)),
  );
  const lines: string[] = [];
  lines.push(headers.map((h, i) => pad(h, widths[i]!)).join("  "));
  for (const row of rows) {
    lines.push(row.map((cell, i) => pad(cell, widths[i]!)).join("  "));
  }
  return `${lines.join("\n")}\n`;
}

function formatPrune(result: ClonesPruneResponse): string {
  const lines: string[] = [];
  lines.push(`removed: ${result.removed.length}`);
  for (const c of result.removed) {
    lines.push(
      `  - ${c.repo_key ?? c.name}  ${formatBytes(c.size_bytes)}  ${c.path}`,
    );
  }
  lines.push(`kept: ${result.kept.length}`);
  for (const c of result.kept) {
    const used = c.used === true ? "used" : "unused";
    lines.push(
      `  - ${c.repo_key ?? c.name}  ${formatBytes(c.size_bytes)}  ${used}  ${c.path}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * `parley clones list|prune` entrypoint.
 */
export async function runClones(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--json": {},
  });
  const verb = positionals[0];
  if (verb === undefined || verb === "list" || verb === "ls") {
    if (positionals.length > 1) {
      throw new UsageError(`clones list: unexpected argument: ${positionals[1]}`);
    }
    const discovery = await ensureDaemon(ctx.paths, ctx.env);
    let body: ClonesListResponse;
    try {
      body = await daemonGet<ClonesListResponse>(discovery, "/clones");
    } catch (err) {
      if (err instanceof DaemonRequestError) {
        throw new UsageError(`clones list: ${err.message}`);
      }
      throw err;
    }
    if (flags["--json"] === true) {
      printJson(ctx, body);
    } else {
      ctx.stdout(formatListTable(body.clones));
    }
    return 0;
  }

  if (verb === "prune") {
    if (positionals.length > 1) {
      throw new UsageError(`clones prune: unexpected argument: ${positionals[1]}`);
    }
    const discovery = await ensureDaemon(ctx.paths, ctx.env);
    let body: ClonesPruneResponse;
    try {
      body = await daemonPost<ClonesPruneResponse>(discovery, "/clones/prune", {});
    } catch (err) {
      if (err instanceof DaemonRequestError) {
        throw new UsageError(`clones prune: ${err.message}`);
      }
      throw err;
    }
    if (flags["--json"] === true) {
      printJson(ctx, body);
    } else {
      ctx.stdout(formatPrune(body));
    }
    return 0;
  }

  throw new UsageError(
    `clones: unknown verb "${verb}" (expected list or prune)`,
  );
}
