import fs from "node:fs";

import {
  nonEmptyString,
  recordSessionState,
  type SessionState,
} from "@useparley/core";

const HARNESS = "codex";
const TRANSCRIPT_TAIL_BYTES = 1024 * 1024;

export interface CodexSessionStartInput {
  session_id?: unknown;
  model?: unknown;
  transcript_path?: unknown;
}

export interface RecordSessionOptions {
  parleyHome?: string;
  harnessPid?: number;
  now?: () => Date;
}

export function effortFromTranscript(transcriptPath: string): string | null {
  let contents: string;
  try {
    const file = fs.openSync(transcriptPath, "r");
    try {
      const size = fs.fstatSync(file).size;
      const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
      const buffer = Buffer.allocUnsafe(length);
      fs.readSync(file, buffer, 0, length, size - length);
      contents = buffer.toString("utf8");
    } finally {
      fs.closeSync(file);
    }
  } catch {
    return null;
  }

  let effort: string | null = null;
  for (const line of contents.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry = JSON.parse(line) as {
        type?: unknown;
        payload?: { effort?: unknown };
      };
      if (
        entry.type === "turn_context" &&
        typeof entry.payload?.effort === "string" &&
        entry.payload.effort.trim() !== ""
      ) {
        effort = entry.payload.effort.trim();
      }
    } catch {
      // A partially-written final JSONL line must not prevent provenance.
    }
  }
  return effort;
}

export function recordCodexSession(
  input: CodexSessionStartInput,
  options: RecordSessionOptions = {},
): SessionState | null {
  const sessionId = nonEmptyString(input.session_id);
  if (sessionId === null) return null;

  const model = nonEmptyString(input.model);
  const transcriptPath = nonEmptyString(input.transcript_path);
  const effort =
    transcriptPath === null ? null : effortFromTranscript(transcriptPath);
  const pid = options.harnessPid ?? process.ppid;

  const result = recordSessionState(
    {
      harness: HARNESS,
      harness_session_id: sessionId,
      model,
      effort,
      pid,
      modelPolicy: "fill",
      effortPolicy: "fill",
    },
    {
      parleyHome: options.parleyHome,
      now: options.now,
    },
  );
  return result?.state ?? null;
}
