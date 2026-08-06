/**
 * Project `Report.files_changed` — handles both path strings and
 * `{ path, added?, removed?, ... }` objects (#349). Extra custom-schema keys
 * are preserved on the view's `extra` bag.
 */
import type { Report, ReportFileEntry } from "@useparley/core";
import type { FileChangeView, ReportFilesView } from "../types.js";

/** Normalize one wire entry into a {@link FileChangeView}. */
export function projectFileEntry(
  entry: ReportFileEntry | Record<string, unknown>,
): FileChangeView | null {
  if (typeof entry === "string") {
    const path = entry.trim();
    if (path === "") return null;
    return { path, added: null, removed: null, extra: {} };
  }
  if (entry === null || typeof entry !== "object") return null;
  const rec = entry as Record<string, unknown>;
  const path = typeof rec.path === "string" ? rec.path.trim() : "";
  if (path === "") return null;
  const added =
    typeof rec.added === "number" && Number.isFinite(rec.added) ? rec.added : null;
  const removed =
    typeof rec.removed === "number" && Number.isFinite(rec.removed) ? rec.removed : null;
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rec)) {
    if (key === "path" || key === "added" || key === "removed") continue;
    extra[key] = value;
  }
  return { path, added, removed, extra };
}

/** Project a report's files_changed list (or empty when no report). */
export function projectReportFiles(report: Report | null | undefined): ReportFilesView {
  const raw = report?.files_changed ?? [];
  const files: FileChangeView[] = [];
  for (const entry of raw) {
    const projected = projectFileEntry(entry);
    if (projected) files.push(projected);
  }
  const hasChurn = files.some((f) => f.added !== null || f.removed !== null);
  return { files, hasChurn };
}

/** Compact churn label: `+3 −1`, `+3`, `−1`, or empty when unknown. */
export function formatChurn(file: FileChangeView): string {
  const parts: string[] = [];
  if (file.added !== null) parts.push(`+${file.added}`);
  if (file.removed !== null) parts.push(`−${file.removed}`);
  return parts.join(" ");
}
