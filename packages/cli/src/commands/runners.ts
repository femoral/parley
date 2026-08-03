/**
 * `parley runners list` — fleet table of registered remote runners
 * (ADR-0029 / #314). Daemon-served via GET /runners.
 */
import type { RunnerListEntry, RunnersListResponse } from "@useparley/core";
import { parseArgs } from "../args.js";
import { daemonGet, ensureDaemon } from "../client.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";

function formatLastSeen(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const ageSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h ago`;
  return `${Math.floor(ageSec / 86400)}d ago`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function formatTable(runners: RunnerListEntry[]): string {
  if (runners.length === 0) {
    return "No registered runners.\n";
  }
  const headers = ["NAME", "STATUS", "VENDORS", "LAST-SEEN"] as const;
  const rows = runners.map((r) => [
    r.name,
    r.status,
    r.vendors.length > 0 ? r.vendors.join(",") : "-",
    formatLastSeen(r.last_seen),
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

/**
 * `parley runners list [--json]`
 *
 * Minimal fleet surface: name, status (online/offline/stale), advertised
 * vendor ids, last-seen. Full show/remove verbs land with the broader #309
 * surface; this ticket ships list only.
 */
export async function runRunners(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--json": {},
  });

  const sub = positionals[0] ?? "list";
  if (sub !== "list") {
    throw new UsageError(
      `runners: unknown subcommand "${sub}" (supported: list)`,
    );
  }
  if (positionals.length > 1) {
    throw new UsageError(`runners list: unexpected argument: ${positionals[1]}`);
  }

  const json = flags["--json"] === true;
  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  const body = await daemonGet<RunnersListResponse>(discovery, "/runners");
  const runners = body.runners ?? [];

  if (json) {
    printJson(ctx, { runners });
  } else {
    ctx.stdout(formatTable(runners));
  }
  return 0;
}
