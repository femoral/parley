import { normalizeUsage, type FleetSummary } from "@useparley/core";
import type { DatabaseHandle } from "./db.js";
import { parseJsonColumn } from "./report.js";

export class FleetQueryError extends Error {}
const STATES = new Set(["all", "running", "failed", "awaiting_answer", "stalled", "queued", "pending", "completed", "cancelled", "blocked", "gate", "attention"]);
const GATE = "state = 'blocked' AND EXISTS (SELECT 1 FROM run_seqs WHERE run_id = runs.id AND block_reason = 'gate')";

/** Scope-bound keyset; only identifiers are fetched before expensive projection. */
export function fleetPageIds(db: DatabaseHandle, kind: "tasks" | "runs", params: URLSearchParams) {
  const session = params.get("session") || "all";
  const state = params.get("state") || "all";
  const run = params.get("run") || "";
  const attention = params.get("attention") === "true";
  const order = attention ? kind === "tasks" ? "(CASE state WHEN 'awaiting_answer' THEN '0' WHEN 'stalled' THEN '1' ELSE '2' END || ':' || updated_at)" : "('0:' || updated_at)" : "created_at";
  const direction = attention ? "ASC" : "DESC";
  const limit = Number(params.get("limit") ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new FleetQueryError("limit must be an integer from 1 to 100");
  if (!STATES.has(state)) throw new FleetQueryError("unknown fleet state");
  const scope = JSON.stringify([kind, session, state, run, limit, attention]);
  const where = ["1 = 1"];
  const values: (string | number)[] = [];
  if (session !== "all") { where.push("orchestrator_session_id = ?"); values.push(session); }
  if (run) {
    if (kind !== "tasks") throw new FleetQueryError("run filter applies only to tasks");
    where.push("run_id = ?"); values.push(run);
  }
  if (state === "gate") where.push(kind === "runs" ? GATE : "0 = 1");
  else if (state === "attention") where.push(kind === "tasks" ? "state IN ('awaiting_answer','stalled','failed')" : GATE);
  else if (state !== "all") { where.push("state = ?"); values.push(state); }
  if (attention) where.push(kind === "tasks" ? "state IN ('awaiting_answer','stalled','failed')" : GATE);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${kind} WHERE ${where.join(" AND ")}`).get(...values) as { n: number }).n;
  const cursor = params.get("cursor");
  if (cursor) {
    try {
      if (cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
      const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (!Array.isArray(decoded) || decoded.length !== 3 || decoded[0] !== scope || typeof decoded[1] !== "string" || !Number.isFinite(Date.parse(attention ? decoded[1].slice(2) : decoded[1])) || typeof decoded[2] !== "string" || decoded[2].length > 256) throw new Error();
      where.push(`(${order}, id) ${attention ? ">" : "<"} (?, ?)`); values.push(decoded[1], decoded[2]);
    } catch { throw new FleetQueryError("invalid cursor for this fleet scope"); }
  }
  const rows = db.prepare(`SELECT id, ${order} AS created_at FROM ${kind} WHERE ${where.join(" AND ")} ORDER BY ${order} ${direction}, id ${direction} LIMIT ?`).all(...values, limit + 1) as { id: string; created_at: string }[];
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { ids: items.map((r) => r.id), total, next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify([scope, last.created_at, last.id])).toString("base64url") : null };
}

/** Exact aggregate over the retained session, never over a displayed page. */
export function fleetSummary(db: DatabaseHandle, session: string, now = Date.now()): FleetSummary {
  const clause = session === "all" ? "1 = 1" : "orchestrator_session_id = ?";
  const values = session === "all" ? [] : [session];
  const counts = (table: "tasks" | "runs") => Object.fromEntries((db.prepare(`SELECT state, COUNT(*) AS n FROM ${table} WHERE ${clause} GROUP BY state`).all(...values) as { state: string; n: number }[]).map((r) => [r.state, r.n]));
  const tasks = counts("tasks");
  const runs = counts("runs");
  const held = (db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE ${clause} AND ${GATE}`).get(...values) as { n: number }).n;
  const start = new Date(now - 86_400_000).toISOString();
  const end = new Date(now).toISOString();
  const settled = { completed: 0, failed: 0 };
  for (const row of db.prepare(`SELECT state, COUNT(*) AS n FROM tasks WHERE ${clause} AND state IN ('completed','failed') AND COALESCE(completed_at, updated_at) BETWEEN ? AND ? GROUP BY state`).all(...values, start, end) as { state: "completed" | "failed"; n: number }[]) settled[row.state] = row.n;
  const fresh_failed = (db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${clause} AND state = 'failed' AND updated_at BETWEEN ? AND ?`).get(...values, new Date(now - 300_000).toISOString(), end) as { n: number }).n;
  const buckets: FleetSummary["burn"]["buckets"] = [];
  for (let h = Math.floor((now - 86_400_000) / 3_600_000) * 3_600_000; h <= now; h += 3_600_000) buckets.push({ hourStartMs: h, input: 0, output: 0, cached: 0, tasks: 0 });
  const totals = { input: 0, output: 0, cached: 0, tasks: 0 };
  const durations: number[] = [];
  // Only the usage columns in the rolling window; no prompts, reports, or envelopes.
  for (const row of db.prepare(`SELECT COALESCE(completed_at, started_at, created_at) AS at, usage, cached_input_tokens, started_at, created_at, completed_at FROM tasks WHERE ${clause} AND COALESCE(completed_at, started_at, created_at) BETWEEN ? AND ?`).iterate(...values, start, end)) {
    const rawUsage = parseJsonColumn<Record<string, number>>(typeof row.usage === "string" ? row.usage : null);
    const usage = rawUsage ? normalizeUsage(rawUsage) : null;
    const input = usage?.input ?? 0, output = usage?.output ?? 0, cached = typeof row.cached_input_tokens === "number" ? row.cached_input_tokens : usage?.cached ?? 0;
    const bucket = buckets[Math.floor((Date.parse(String(row.at)) - buckets[0]!.hourStartMs) / 3_600_000)];
    if (bucket) { bucket.input += input; bucket.output += output; bucket.cached += cached; bucket.tasks++; }
    totals.input += input; totals.output += output; totals.cached += cached; totals.tasks++;
    if (typeof row.completed_at === "string") {
      const duration = Date.parse(row.completed_at) - Date.parse(String(row.started_at ?? row.created_at));
      if (Number.isFinite(duration)) durations.push(Math.max(0, duration));
    }
  }
  durations.sort((a, b) => a - b);
  return { tasks, runs, task_total: Object.values(tasks).reduce((a, b) => a + b, 0), run_total: Object.values(runs).reduce((a, b) => a + b, 0), held, attention: held + (tasks.awaiting_answer ?? 0) + (tasks.stalled ?? 0) + (tasks.failed ?? 0), settled, fresh_failed, p95_ms: durations[Math.floor(durations.length * .95)] ?? null, burn: { buckets, totals, retentionDays: 30, retentionSource: "default-assumed", windowMs: 86_400_000, asOfMs: now } };
}
