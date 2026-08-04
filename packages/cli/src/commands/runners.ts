/**
 * `parley runners list|show|remove` — fleet surface for registered remote
 * runners (ADR-0029 / #314 / #320). Daemon-served via GET/DELETE /runners.
 */
import type {
  RunnerListEntry,
  RunnerRemoveResponse,
  RunnerShowResponse,
  RunnersListResponse,
} from "@useparley/core";
import { parseArgs } from "../args.js";
import {
  DaemonRequestError,
  daemonDelete,
  daemonGet,
  ensureDaemon,
} from "../client.js";
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

function formatAgeMs(ms: number): string {
  const ageSec = Math.max(0, Math.floor(ms / 1000));
  if (ageSec < 60) return `${ageSec}s`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m`;
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h`;
  return `${Math.floor(ageSec / 86400)}d`;
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

function formatShow(detail: RunnerShowResponse): string {
  const lines: string[] = [];
  lines.push(`name:               ${detail.name}`);
  lines.push(`status:             ${detail.status}`);
  lines.push(`build_version:      ${detail.build_version}`);
  lines.push(`protocol_version:   ${detail.protocol_version}`);
  lines.push(`registered_at:      ${detail.registered_at}`);
  lines.push(
    `last_seen:          ${detail.last_seen} (${formatLastSeen(detail.last_seen)})`,
  );
  lines.push(
    `last_contact:       ${formatAgeMs(detail.last_contact_age_ms)}`,
  );

  lines.push("");
  lines.push("models:");
  if (detail.vendors.length === 0) {
    lines.push("  (none advertised)");
  } else {
    for (const v of detail.vendors) {
      if (v.models.length === 0) {
        lines.push(`  ${v.id}: (no models)`);
        continue;
      }
      for (const m of v.models) {
        const efforts =
          m.efforts.length > 0 ? m.efforts.join(",") : "-";
        const def =
          m.default_effort !== null && m.default_effort !== undefined
            ? ` default=${m.default_effort}`
            : "";
        lines.push(`  ${v.id}/${m.id}  efforts=[${efforts}]${def}`);
      }
    }
  }

  lines.push("");
  lines.push("repo_reachability:");
  if (detail.repo_reachability === null) {
    lines.push("  not advertised");
  } else if (detail.repo_reachability.length === 0) {
    lines.push("  (empty)");
  } else {
    for (const r of detail.repo_reachability) {
      lines.push(
        `  ${r.repo_key}: ${r.reachable ? "reachable" : "unreachable"}`,
      );
    }
  }

  lines.push("");
  lines.push("recent_tasks:");
  if (detail.recent_tasks.length === 0) {
    lines.push("  (none)");
  } else {
    for (const t of detail.recent_tasks) {
      const label = t.name ?? t.id;
      const vendor = t.vendor ?? "-";
      lines.push(`  ${t.id}  ${label}  ${t.state}  ${vendor}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

async function runnersList(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--json": {},
  });
  if (positionals.length > 0) {
    throw new UsageError(`runners list: unexpected argument: ${positionals[0]}`);
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

async function runnersShow(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--json": {},
  });
  const name = positionals[0];
  if (name === undefined || name === "") {
    throw new UsageError("usage: parley runners show <name> [--json]");
  }
  if (positionals.length > 1) {
    throw new UsageError(`runners show: unexpected argument: ${positionals[1]}`);
  }

  const json = flags["--json"] === true;
  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  let body: RunnerShowResponse;
  try {
    body = await daemonGet<RunnerShowResponse>(
      discovery,
      `/runners/${encodeURIComponent(name)}`,
    );
  } catch (err) {
    if (err instanceof DaemonRequestError && err.status === 404) {
      throw new Error(`runners show: ${err.message}`);
    }
    throw err;
  }

  if (json) {
    printJson(ctx, body);
  } else {
    ctx.stdout(formatShow(body));
  }
  return 0;
}

async function runnersRemove(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--json": {},
  });
  const name = positionals[0];
  if (name === undefined || name === "") {
    throw new UsageError("usage: parley runners remove <name> [--json]");
  }
  if (positionals.length > 1) {
    throw new UsageError(
      `runners remove: unexpected argument: ${positionals[1]}`,
    );
  }

  const json = flags["--json"] === true;
  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  let body: RunnerRemoveResponse;
  try {
    body = await daemonDelete<RunnerRemoveResponse>(
      discovery,
      `/runners/${encodeURIComponent(name)}`,
    );
  } catch (err) {
    if (err instanceof DaemonRequestError && err.status === 404) {
      throw new Error(`runners remove: ${err.message}`);
    }
    throw err;
  }

  if (json) {
    printJson(ctx, body);
  } else {
    const parts: string[] = [];
    if (body.deleted_row) parts.push("registration row");
    if (body.deleted_config) parts.push("config entry");
    ctx.stdout(
      `Removed runner "${body.name}" (${parts.join(" + ") || "nothing"}).\n`,
    );
  }
  return 0;
}

/**
 * `parley runners list|show|remove [--json]`
 *
 * Fleet surface for remote runners (#314 / #320):
 * - list — name, status, vendors, last-seen
 * - show — full advertisement (models, reachability, age, recent tasks)
 * - remove — delete SQLite row + `runners.<name>` config (loopback)
 */
export async function runRunners(ctx: CliContext, args: string[]): Promise<number> {
  const sub = args[0] ?? "list";
  const rest = args.slice(1);

  if (sub === "list") {
    return runnersList(ctx, rest);
  }
  if (sub === "show") {
    return runnersShow(ctx, rest);
  }
  if (sub === "remove") {
    return runnersRemove(ctx, rest);
  }
  throw new UsageError(
    `runners: unknown subcommand "${sub}" (supported: list, show, remove)`,
  );
}
