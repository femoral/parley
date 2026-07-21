import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  readSessionState,
  sessionStatePath,
  writeSessionState,
  type SessionState,
} from "@useparley/core";

const HARNESS = "claude";
const TRANSCRIPT_CHUNK_BYTES = 1024 * 1024;

interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  model?: string;
  transcript_path?: string;
}

export interface HookOptions {
  parleyHome?: string;
  envFile?: string;
  harnessPid?: number;
  now?: () => string;
}

export function runHook(rawInput: string, options: HookOptions = {}): void {
  try {
    const input = parseInput(rawInput);
    if (!input) return;

    const parleyHome =
      options.parleyHome ?? process.env.PARLEY_HOME ?? path.join(os.homedir(), ".parley");
    const stateFile = sessionStatePath(parleyHome, HARNESS, input.session_id);
    const now = (options.now ?? (() => new Date().toISOString()))();
    const pid = options.harnessPid ?? process.ppid;

    if (input.hook_event_name === "SessionStart") {
      const previous = readSessionState(stateFile);
      const state: SessionState = {
        harness: HARNESS,
        harness_session_id: input.session_id,
        model: nonEmpty(input.model),
        effort: null,
        pid,
        started_at: previous?.started_at || now,
        updated_at: now,
      };
      writeSessionState(stateFile, state);
      appendEnvironment(options.envFile ?? process.env.CLAUDE_ENV_FILE, state);
      return;
    }

    const previous = readSessionState(stateFile);
    if (!previous) return;
    const transcript = readTranscriptMetadata(input.transcript_path);
    const model = transcript.model ?? previous.model;
    const effort = transcript.effort ?? previous.effort;
    if (model === previous.model && effort === previous.effort) return;
    writeSessionState(stateFile, {
      ...previous,
      model,
      effort,
      pid,
      updated_at: now,
    });
  } catch {
    // Claude hooks are fail-open: provenance must never interrupt a session.
  }
}

function parseInput(rawInput: string): Required<Pick<HookInput, "session_id">> & HookInput | null {
  let value: unknown;
  try {
    value = JSON.parse(rawInput);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = value as HookInput;
  const sessionId = nonEmpty(input.session_id);
  if (!sessionId) return null;
  return { ...input, session_id: sessionId };
}

function appendEnvironment(envFile: string | undefined, state: SessionState): void {
  if (!envFile) return;
  const exports = [
    shellExport("PARLEY_SESSION_ID", state.harness_session_id),
    shellExport("PARLEY_HARNESS", HARNESS),
  ];
  if (state.model) exports.push(shellExport("PARLEY_MODEL", state.model));
  fs.appendFileSync(envFile, `${exports.join("\n")}\n`, "utf8");
}

function shellExport(name: string, value: string): string {
  return `export ${name}='${value.replaceAll("'", `'\\''`)}'`;
}

function readTranscriptMetadata(transcriptPath: string | undefined): {
  model: string | null;
  effort: string | null;
} {
  if (!transcriptPath) return { model: null, effort: null };
  let raw: string;
  try {
    const stat = fs.statSync(transcriptPath);
    if (!stat.isFile()) return { model: null, effort: null };
    raw = readTranscriptEdges(transcriptPath, stat.size);
  } catch {
    return { model: null, effort: null };
  }

  let model: string | null = null;
  let effort: string | null = null;
  for (const line of raw.split("\n")) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isInitEvent(event)) continue;
    model = nonEmpty(event.model) ?? model;
    effort =
      nonEmpty(event.effort) ??
      nonEmpty(event.effort_level) ??
      nonEmpty(event.thinking_level) ??
      effort;
  }
  return { model, effort };
}

function readTranscriptEdges(transcriptPath: string, size: number): string {
  if (size <= TRANSCRIPT_CHUNK_BYTES * 2) return fs.readFileSync(transcriptPath, "utf8");
  const fd = fs.openSync(transcriptPath, "r");
  try {
    const first = Buffer.allocUnsafe(TRANSCRIPT_CHUNK_BYTES);
    const last = Buffer.allocUnsafe(TRANSCRIPT_CHUNK_BYTES);
    fs.readSync(fd, first, 0, first.length, 0);
    fs.readSync(fd, last, 0, last.length, size - last.length);
    return `${first.toString("utf8")}\n${last.toString("utf8")}`;
  } finally {
    fs.closeSync(fd);
  }
}

function isInitEvent(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return event.type === "system" && event.subtype === "init";
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

async function main(): Promise<void> {
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  runHook(input);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main();
}
