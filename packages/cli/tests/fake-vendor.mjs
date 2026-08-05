#!/usr/bin/env node
/**
 * Fake vendor CLI — the suite's only test double.
 *
 * Speaks a vendor-like JSONL event stream on stdout and acts as a real MCP
 * client against the daemon's streamable-HTTP endpoint (URL + correlation
 * headers injected by the fake adapter's SpawnPlan via env). Also exercises
 * the ADR-0011 HTTP and CLI child channels when scripted to (#155).
 *
 * Behavior is scripted per task: it reads `.fake-vendor.json` from its cwd —
 * an array of actions:
 *   { "emit": {...} }                       print a JSONL event line
 *   { "emit_raw": "text" }                  print a raw (non-JSON) line
 *   { "sleep": 250 }                        wait ms
 *   { "write_file": { "path": "...", "contents": "..." } }  write a file in cwd
 *   { "git_commit": { "message": "..." } }  stage all + commit in cwd
 *   { "submit_report": {...} }              MCP tools/call submit_report
 *   { "submit_report_http": {...} }         POST /child/report (HTTP channel)
 *   { "submit_report_cli": {...} }          `parley child report --json-file -`
 *   { "ask": "question text" }              MCP ask_orchestrator; blocks until
 *                                           `parley answer` delivers the answer,
 *                                           echoed as a tool_result, then continues
 *   { "ask_http": "question text" }         POST /child/ask (HTTP channel)
 *   { "ask_cli": "question text" }          `parley child ask "..."`
 *   { "ask": "...", "background": true }    fire-and-forget ask (misbehaving
 *                                           child that submit_reports over its
 *                                           own outstanding question — #79)
 *   { "call_tool": { "name": "...", "args": {...} } }
 *   { "exit": 0 }                           exit early with code
 * The result of each tool call is echoed to stdout as a JSONL event
 * ({"type":"tool_result", ...}) so tests can observe validation bounces.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const mcpUrl = process.env.FAKE_MCP_URL;
const headers = JSON.parse(process.env.FAKE_MCP_HEADERS ?? "{}");
const hubBase = (process.env.PARLEY_HUB_URL ?? "").replace(/\/$/, "");
const taskId = process.env.PARLEY_TASK_ID ?? "";
const TASK_HEADER = "x-parley-task";

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nextId = 1;
async function rpc(method, params) {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  if (res.status === 202) return undefined; // notification accepted
  const body = await res.json();
  if (!res.ok || body.error) {
    throw new Error(`mcp ${method} failed: ${res.status} ${JSON.stringify(body.error ?? body)}`);
  }
  return body.result;
}

async function notify(method, params) {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method, params }),
  });
  if (res.status >= 300) throw new Error(`mcp notify ${method} failed: ${res.status}`);
}

let initialized = false;
async function ensureInitialized() {
  if (initialized) return;
  await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "fake-vendor", version: "0.0.0" },
  });
  await notify("notifications/initialized", {});
  initialized = true;
}

async function callTool(name, args) {
  await ensureInitialized();
  const result = await rpc("tools/call", { name, arguments: args });
  emit({
    type: "tool_result",
    tool: name,
    is_error: result.isError === true,
    text: (result.content ?? []).map((c) => c.text ?? "").join(""),
  });
  return result;
}

/** POST /child/* using the engine-injected hub env (ADR-0011 HTTP channel). */
async function childHttp(pathname, body) {
  if (!hubBase || !taskId) {
    throw new Error("child http: PARLEY_HUB_URL / PARLEY_TASK_ID not set");
  }
  const res = await fetch(`${hubBase}${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      [TASK_HEADER]: taskId,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    parsed = text;
  }
  emit({
    type: "tool_result",
    tool: `http:${pathname}`,
    is_error: res.status >= 400,
    status: res.status,
    text: typeof parsed === "string" ? parsed : JSON.stringify(parsed ?? {}),
  });
  if (res.status >= 400 && res.status !== 504) {
    throw new Error(`child http ${pathname} failed: ${res.status} ${text}`);
  }
  return { status: res.status, body: parsed };
}

/**
 * Resolve the parley CLI entry the same way integration tests do, so
 * `submit_report_cli` / `ask_cli` exercise the real `parley child` surface.
 */
function resolveParleyCli() {
  // Prefer an explicit path (tests can set PARLEY_CLI_ENTRY); else locate the
  // packages/cli entry relative to this fake-vendor file.
  if (process.env.PARLEY_CLI_ENTRY) return process.env.PARLEY_CLI_ENTRY;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/index.ts");
}

function resolveTsxLoader() {
  if (process.env.PARLEY_TSX_LOADER) return process.env.PARLEY_TSX_LOADER;
  const require = createRequire(import.meta.url);
  return pathToFileURL(require.resolve("tsx")).href;
}

/** Shell out to `parley child …` (ADR-0011 CLI channel). */
function childCli(args, stdin) {
  const cliEntry = resolveParleyCli();
  const tsx = resolveTsxLoader();
  const result = spawnSync(
    process.execPath,
    ["--import", tsx, cliEntry, "child", ...args],
    {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
      input: stdin,
    },
  );
  emit({
    type: "tool_result",
    tool: `cli:child ${args[0]}`,
    is_error: result.status !== 0,
    status: result.status ?? 1,
    text: (result.stdout ?? "") + (result.stderr ?? ""),
  });
  if (result.status !== 0 && result.status !== 4) {
    throw new Error(
      `child cli ${args.join(" ")} failed (exit ${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

async function main() {
  // Engine injects PARLEY_HUB_URL / PARLEY_TASK_ID for every adapter (ADR-0011);
  // echo them so tests can assert the env (and .parley/child.json) path.
  let childJson = null;
  try {
    childJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".parley", "child.json"), "utf8"));
  } catch {
    /* absent */
  }
  emit({
    type: "hello",
    model: process.env.FAKE_MODEL ?? null,
    effort: process.env.FAKE_EFFORT ?? null,
    // The full vendor prompt the adapter handed us (argv[2]) — tests assert the
    // protocol preamble + caller brief + on-disk pointers were composed here.
    prompt: process.argv[2] ?? null,
    cwd: process.cwd(),
    // Echo the sandbox posture the adapter handed us — tests assert delivery.
    sandbox: process.env.FAKE_SANDBOX ?? null,
    network: process.env.FAKE_NETWORK === "1",
    pid: process.pid,
    parley_hub_url: process.env.PARLEY_HUB_URL ?? null,
    parley_task_id: process.env.PARLEY_TASK_ID ?? null,
    child_json: childJson,
  });
  // Resume semantics (#18): when respawned via the fake adapter's `resume()`,
  // FAKE_RESUME_SESSION carries the persisted vendor session id and argv[2]
  // carries the resume prompt (the orchestrator's answer). A resumed run
  // executes `.fake-vendor.resume.json` — its post-resume script — instead of
  // starting the original script over.
  const resumeSession = process.env.FAKE_RESUME_SESSION;
  let scriptName = ".fake-vendor.json";
  if (resumeSession !== undefined) {
    emit({ type: "resumed", session_id: resumeSession, answer: process.argv[2] ?? null });
    scriptName = ".fake-vendor.resume.json";
  }
  const scriptPath = path.join(process.cwd(), scriptName);
  const actions = JSON.parse(fs.readFileSync(scriptPath, "utf8"));

  for (const action of actions) {
    if (action.emit !== undefined) emit(action.emit);
    else if (action.emit_raw !== undefined) process.stdout.write(`${action.emit_raw}\n`);
    else if (action.sleep !== undefined) await sleep(action.sleep);
    else if (action.write_file !== undefined) {
      const target = path.join(process.cwd(), action.write_file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, action.write_file.contents ?? "");
    } else if (action.git_commit !== undefined) {
      // Explicit -c identity so bare-mirror worktrees (and host hooks that
      // gate on user.*) still commit in fixtures (e.g. #318 clean reclaim).
      const ident = [
        "-c",
        "user.email=test@parley.test",
        "-c",
        "user.name=parley test",
      ];
      execFileSync("git", [...ident, "add", "-A"], { cwd: process.cwd() });
      execFileSync(
        "git",
        [...ident, "commit", "-m", action.git_commit.message ?? "child commit"],
        { cwd: process.cwd() },
      );
    }
    else if (action.submit_report !== undefined) await callTool("submit_report", action.submit_report);
    else if (action.submit_report_http !== undefined) {
      await childHttp("/child/report", action.submit_report_http);
    } else if (action.submit_report_cli !== undefined) {
      childCli(["report", "--json-file", "-"], JSON.stringify(action.submit_report_cli));
    } else if (action.ask !== undefined) {
      const askPromise = callTool("ask_orchestrator", { question: action.ask });
      // Background ask: do not await — the next action can run while the
      // question is still outstanding (report-over-question path, #79).
      if (action.background === true) void askPromise;
      else await askPromise;
    } else if (action.ask_http !== undefined) {
      await childHttp("/child/ask", { question: action.ask_http });
    } else if (action.ask_cli !== undefined) {
      childCli(["ask", action.ask_cli]);
    } else if (action.call_tool !== undefined) {
      await callTool(action.call_tool.name, action.call_tool.args ?? {});
    } else if (action.exit !== undefined) process.exit(action.exit);
    else throw new Error(`unknown action: ${JSON.stringify(action)}`);
  }
}

main().catch((err) => {
  emit({ type: "fatal", message: String(err) });
  process.exit(1);
});
