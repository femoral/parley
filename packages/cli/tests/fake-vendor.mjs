#!/usr/bin/env node
/**
 * Fake vendor CLI — the suite's only test double.
 *
 * Speaks a vendor-like JSONL event stream on stdout and acts as a real MCP
 * client against the daemon's streamable-HTTP endpoint (URL + correlation
 * headers injected by the fake adapter's SpawnPlan via env).
 *
 * Behavior is scripted per task: it reads `.fake-vendor.json` from its cwd —
 * an array of actions:
 *   { "emit": {...} }                       print a JSONL event line
 *   { "emit_raw": "text" }                  print a raw (non-JSON) line
 *   { "sleep": 250 }                        wait ms
 *   { "write_file": { "path": "...", "contents": "..." } }  write a file in cwd
 *   { "git_commit": { "message": "..." } }  stage all + commit in cwd
 *   { "submit_report": {...} }              MCP tools/call submit_report
 *   { "ask": "question text" }              MCP ask_orchestrator; blocks until
 *                                           `parley answer` delivers the answer,
 *                                           echoed as a tool_result, then continues
 *   { "ask": "...", "background": true }    fire-and-forget ask (misbehaving
 *                                           child that submit_reports over its
 *                                           own outstanding question — #79)
 *   { "call_tool": { "name": "...", "args": {...} } }
 *   { "exit": 0 }                           exit early with code
 * The result of each tool call is echoed to stdout as a JSONL event
 * ({"type":"tool_result", ...}) so tests can observe validation bounces.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const mcpUrl = process.env.FAKE_MCP_URL;
const headers = JSON.parse(process.env.FAKE_MCP_HEADERS ?? "{}");

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

async function main() {
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
      execFileSync("git", ["add", "-A"], { cwd: process.cwd() });
      execFileSync("git", ["commit", "-m", action.git_commit.message ?? "child commit"], {
        cwd: process.cwd(),
      });
    }
    else if (action.submit_report !== undefined) await callTool("submit_report", action.submit_report);
    else if (action.ask !== undefined) {
      const askPromise = callTool("ask_orchestrator", { question: action.ask });
      // Background ask: do not await — the next action can run while the
      // question is still outstanding (report-over-question path, #79).
      if (action.background === true) void askPromise;
      else await askPromise;
    }
    else if (action.call_tool !== undefined) await callTool(action.call_tool.name, action.call_tool.args ?? {});
    else if (action.exit !== undefined) process.exit(action.exit);
    else throw new Error(`unknown action: ${JSON.stringify(action)}`);
  }
}

main().catch((err) => {
  emit({ type: "fatal", message: String(err) });
  process.exit(1);
});
