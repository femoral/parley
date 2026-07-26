/**
 * Compounding PROMPT.md layers (#159) — pure composition order and skip-silently.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assembleChildPrompt,
  assemblePromptPreview,
  collectOperatorLayerBodies,
  composeOperatorInstructions,
  composeOrchestratorInstructions,
  composeStepBody,
  formatOrchestratorNote,
  joinPromptBodies,
  PromptPathError,
  readPromptFile,
  readWorkflowPrompt,
  readWorkflowRelativePrompt,
} from "../src/prompt-layers.js";

let home: string;
let project: string;
const scratch: string[] = [];

function write(root: string, rel: string, body: string): void {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-pl-home-"));
  project = fs.mkdtempSync(path.join(os.tmpdir(), "parley-pl-proj-"));
  scratch.push(home, project);
});

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("readPromptFile / joinPromptBodies", () => {
  it("returns null for missing, empty, and whitespace-only files", () => {
    expect(readPromptFile(path.join(home, "nope.md"))).toBeNull();
    write(home, "empty.md", "");
    expect(readPromptFile(path.join(home, "empty.md"))).toBeNull();
    write(home, "ws.md", "  \n\t\n  ");
    expect(readPromptFile(path.join(home, "ws.md"))).toBeNull();
  });

  it("trims and returns non-empty bodies", () => {
    write(home, "ok.md", "  hello\n");
    expect(readPromptFile(path.join(home, "ok.md"))).toBe("hello");
  });

  it("joinPromptBodies skips null/empty and blank-line separates", () => {
    expect(joinPromptBodies([null, "", undefined])).toBeNull();
    expect(joinPromptBodies(["a", null, "b"])).toBe("a\n\nb");
  });
});

describe("operator layer composition order", () => {
  it("home vendor → project vendor → home profile → project profile", () => {
    write(home, "vendors/fake/PROMPT.md", "HOME-VENDOR");
    write(project, ".parley/vendors/fake/PROMPT.md", "PROJECT-VENDOR");
    write(home, "profiles/deep/PROMPT.md", "HOME-PROFILE");
    write(project, ".parley/profiles/deep/PROMPT.md", "PROJECT-PROFILE");

    const bodies = collectOperatorLayerBodies({
      homeDir: home,
      projectDir: project,
      vendorId: "fake",
      profileName: "deep",
    });
    expect(bodies).toEqual([
      "HOME-VENDOR",
      "PROJECT-VENDOR",
      "HOME-PROFILE",
      "PROJECT-PROFILE",
    ]);

    const section = composeOperatorInstructions({
      homeDir: home,
      projectDir: project,
      vendorId: "fake",
      profileName: "deep",
    });
    expect(section).toBe(
      [
        "## Operator instructions",
        "",
        "HOME-VENDOR",
        "",
        "PROJECT-VENDOR",
        "",
        "HOME-PROFILE",
        "",
        "PROJECT-PROFILE",
      ].join("\n"),
    );
  });

  it("skips missing layers silently and invents no per-layer headers", () => {
    write(home, "vendors/fake/PROMPT.md", "only-home-vendor");
    write(project, ".parley/profiles/deep/PROMPT.md", "only-project-profile");

    const bodies = collectOperatorLayerBodies({
      homeDir: home,
      projectDir: project,
      vendorId: "fake",
      profileName: "deep",
    });
    expect(bodies).toEqual(["only-home-vendor", "only-project-profile"]);
    const section = composeOperatorInstructions({
      homeDir: home,
      projectDir: project,
      vendorId: "fake",
      profileName: "deep",
    })!;
    expect(section).not.toContain("vendors/");
    expect(section).not.toContain("profiles/");
    expect(section).toContain("## Operator instructions");
  });

  it("omits profile layers when no profile is set", () => {
    write(home, "vendors/fake/PROMPT.md", "V");
    write(home, "profiles/deep/PROMPT.md", "P-SHOULD-NOT-APPEAR");
    write(project, ".parley/profiles/deep/PROMPT.md", "P2-SHOULD-NOT-APPEAR");

    const bodies = collectOperatorLayerBodies({
      homeDir: home,
      projectDir: project,
      vendorId: "fake",
      profileName: null,
    });
    expect(bodies).toEqual(["V"]);
    expect(composeOperatorInstructions({
      homeDir: home,
      projectDir: project,
      vendorId: "fake",
      profileName: null,
    })).not.toContain("SHOULD-NOT-APPEAR");
  });

  it("returns null when nothing exists (no empty Operator section)", () => {
    expect(
      composeOperatorInstructions({
        homeDir: home,
        projectDir: project,
        vendorId: "fake",
        profileName: "deep",
      }),
    ).toBeNull();
  });

  it("skips project layers when projectDir is null", () => {
    write(home, "vendors/fake/PROMPT.md", "HOME");
    write(project, ".parley/vendors/fake/PROMPT.md", "PROJECT");
    expect(
      collectOperatorLayerBodies({
        homeDir: home,
        projectDir: null,
        vendorId: "fake",
        profileName: null,
      }),
    ).toEqual(["HOME"]);
  });
});

describe("orchestrator layers", () => {
  it("compounds home → project and never shares child paths", () => {
    write(home, "orchestrator/PROMPT.md", "ORCH-HOME");
    write(project, ".parley/orchestrator/PROMPT.md", "ORCH-PROJECT");
    write(home, "vendors/fake/PROMPT.md", "VENDOR-NOT-IN-ORCH");

    expect(
      composeOrchestratorInstructions({ homeDir: home, projectDir: project }),
    ).toBe("ORCH-HOME\n\nORCH-PROJECT");
  });

  it("is independent of operator composition (orchestrator never in children)", () => {
    write(home, "orchestrator/PROMPT.md", "ORCH-SECRET");
    write(home, "vendors/fake/PROMPT.md", "VENDOR-OK");

    const child = composeOperatorInstructions({
      homeDir: home,
      projectDir: project,
      vendorId: "fake",
      profileName: null,
    });
    expect(child).toContain("VENDOR-OK");
    expect(child).not.toContain("ORCH-SECRET");
  });
});

describe("assembleChildPrompt / assemblePromptPreview", () => {
  it("inserts operator section between preamble and brief", () => {
    const out = assembleChildPrompt("PREAMBLE", "## Operator instructions\n\nOP", "BRIEF");
    expect(out).toBe(
      ["PREAMBLE", "", "---", "", "## Operator instructions", "", "OP", "", "---", "", "BRIEF"].join(
        "\n",
      ),
    );
  });

  it("matches pre-#159 shape when no operator layers", () => {
    expect(assembleChildPrompt("PREAMBLE", null, "BRIEF")).toBe("PREAMBLE\n\n---\n\nBRIEF");
  });

  it("preview is preamble (+ operator) without brief", () => {
    expect(assemblePromptPreview("PREAMBLE", null)).toBe("PREAMBLE");
    expect(assemblePromptPreview("PREAMBLE", "## Operator instructions\n\nOP")).toBe(
      "PREAMBLE\n\n---\n\n## Operator instructions\n\nOP",
    );
  });

  it("spawn prompt is preview + separator + brief", () => {
    const op = "## Operator instructions\n\nOP";
    const preview = assemblePromptPreview("PREAMBLE", op);
    const spawn = assembleChildPrompt("PREAMBLE", op, "do the thing");
    expect(spawn).toBe(`${preview}\n\n---\n\ndo the thing`);
  });
});

describe("composeStepBody — ADR-0016 / #239", () => {
  let wfDir: string;

  beforeEach(() => {
    wfDir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-pl-wf-"));
    scratch.push(wfDir);
  });

  function writeWf(rel: string, body: string): void {
    write(wfDir, rel, body);
  }

  it("orders workflow → node → slot → orchestrator note → inputs", () => {
    writeWf("PROMPT.md", "WORKFLOW-PROMPT");
    writeWf("prompts/node.md", "NODE-PROMPT");
    writeWf("prompts/slot.md", "SLOT-APPEND");

    const body = composeStepBody({
      workflowDir: wfDir,
      nodePromptPath: "prompts/node.md",
      slotAppendPath: "prompts/slot.md",
      orchestratorNote: "please re-check auth",
      inputsSection: "## Inputs\n\n- `brief` (text): do the thing",
    });

    expect(body).toBe(
      [
        "WORKFLOW-PROMPT",
        "",
        "NODE-PROMPT",
        "",
        "SLOT-APPEND",
        "",
        "## Orchestrator note",
        "",
        "please re-check auth",
        "",
        "## Inputs",
        "",
        "- `brief` (text): do the thing",
      ].join("\n"),
    );
  });

  it("omits opt-in workflow prompt when PROMPT.md is missing", () => {
    writeWf("prompts/node.md", "NODE-ONLY");
    const body = composeStepBody({
      workflowDir: wfDir,
      nodePromptPath: "prompts/node.md",
    });
    expect(body).toBe("NODE-ONLY");
    expect(body).not.toContain("## Orchestrator note");
    expect(body).not.toContain("## Inputs");
    expect(body).not.toContain("## Deliverables");
    expect(body).not.toMatch(/node \d+ of \d+/i);
  });

  it("omits slot append, note, and empty inputs", () => {
    writeWf("prompts/node.md", "NODE");
    expect(
      composeStepBody({
        workflowDir: wfDir,
        nodePromptPath: "prompts/node.md",
        slotAppendPath: null,
        orchestratorNote: "  \n",
        inputsSection: "",
      }),
    ).toBe("NODE");
  });

  it("never invents a Deliverables section or node-position banner", () => {
    writeWf("prompts/node.md", "do work");
    const body = composeStepBody({
      workflowDir: wfDir,
      nodePromptPath: "prompts/node.md",
      orchestratorNote: "note",
      inputsSection: "## Inputs\n\n- `x` (text): y",
    });
    expect(body).not.toContain("## Deliverables");
    expect(body).not.toContain("you are node");
    expect(body).not.toMatch(/node \d+ of \d+/);
  });

  it("throws when a declared node prompt path is missing", () => {
    expect(() =>
      composeStepBody({
        workflowDir: wfDir,
        nodePromptPath: "prompts/missing.md",
      }),
    ).toThrow(PromptPathError);
  });

  it("throws when a declared slot append path is missing", () => {
    writeWf("prompts/node.md", "NODE");
    expect(() =>
      composeStepBody({
        workflowDir: wfDir,
        nodePromptPath: "prompts/node.md",
        slotAppendPath: "prompts/no-slot.md",
      }),
    ).toThrow(/slot prompt not found/);
  });

  it("workflowPrompt override null forces omit even when PROMPT.md exists", () => {
    writeWf("PROMPT.md", "SHOULD-SKIP");
    writeWf("prompts/node.md", "NODE");
    expect(
      composeStepBody({
        workflowDir: wfDir,
        nodePromptPath: "prompts/node.md",
        workflowPrompt: null,
      }),
    ).toBe("NODE");
  });

  it("readWorkflowPrompt / relative path helpers", () => {
    expect(readWorkflowPrompt(wfDir)).toBeNull();
    writeWf("PROMPT.md", "  W\n");
    expect(readWorkflowPrompt(wfDir)).toBe("W");
    writeWf("prompts/n.md", "N");
    expect(readWorkflowRelativePrompt(wfDir, "prompts/n.md")).toBe("N");
    expect(readWorkflowRelativePrompt(wfDir, "../escape.md")).toBeNull();
    expect(readWorkflowRelativePrompt(wfDir, "/abs.md")).toBeNull();
  });

  it("formatOrchestratorNote trims and nulls empty", () => {
    expect(formatOrchestratorNote(null)).toBeNull();
    expect(formatOrchestratorNote("  ")).toBeNull();
    expect(formatOrchestratorNote(" go ")).toBe(
      "## Orchestrator note\n\ngo",
    );
  });

  it("assembleChildPrompt still wraps the composed body", () => {
    writeWf("prompts/node.md", "BODY");
    const body = composeStepBody({
      workflowDir: wfDir,
      nodePromptPath: "prompts/node.md",
    });
    const full = assembleChildPrompt("PREAMBLE", null, body);
    expect(full).toBe("PREAMBLE\n\n---\n\nBODY");
  });
});
