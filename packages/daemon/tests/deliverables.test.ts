/**
 * #236 — deliverable report schema, reference stat, input materialization
 * (ADR-0016). Callable units only; no engine wiring.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compileOutputPorts,
  parsePortType,
  type PortType,
} from "@useparley/core";
import {
  deliverableKind,
  deliverablesFromReport,
  generateReportSchema,
  isInsideWorkspace,
  materializeInputs,
  renderInputFileBody,
  renderInputsSection,
  validateDeliverableReport,
  validatePortReferences,
} from "../src/deliverables.js";

const named = {
  verdict: { kind: "enum" as const, values: ["approve", "reject"] as const },
};

function t(typeStr: string): PortType {
  return parsePortType(typeStr, named);
}

const scratch: string[] = [];
afterEach(() => {
  for (const d of scratch.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function tmpDir(prefix = "parley-deliv-"): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// generateReportSchema
// ---------------------------------------------------------------------------

describe("generateReportSchema", () => {
  it("reuses compileOutputPorts (no second compiler)", () => {
    const ports = {
      verdict: { type: t("verdict") },
      notes: { type: t("text"), bounds: { maxLength: 100 } },
    };
    expect(generateReportSchema(ports)).toEqual(compileOutputPorts(ports));
  });
});

// ---------------------------------------------------------------------------
// Reference stat
// ---------------------------------------------------------------------------

describe("validatePortReferences — file/dir", () => {
  it("accepts a non-empty file and non-empty dir inside the workspace", () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, "out.txt"), "hello\n");
    fs.mkdirSync(path.join(root, "artifacts"));
    fs.writeFileSync(path.join(root, "artifacts", "a.bin"), "x");

    const errors = validatePortReferences(
      { report: "out.txt", bundle: "artifacts" },
      { report: { type: t("file") }, bundle: { type: t("dir") } },
      root,
    );
    expect(errors).toEqual([]);
  });

  it("rejects missing, empty, outside-workspace, and wrong-kind paths", () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, "empty.txt"), "");
    fs.mkdirSync(path.join(root, "empty-dir"));
    fs.writeFileSync(path.join(root, "not-a-dir"), "file");
    fs.mkdirSync(path.join(root, "not-a-file"));
    fs.writeFileSync(path.join(root, "not-a-file", "x"), "1");

    const outside = path.join(os.tmpdir(), `outside-${process.pid}.txt`);
    fs.writeFileSync(outside, "secret\n");
    scratch.push(outside);

    const cases: Array<{ payload: Record<string, unknown>; ports: Record<string, { type: PortType }>; needle: string }> = [
      {
        payload: { f: "gone.txt" },
        ports: { f: { type: t("file") } },
        needle: "does not exist",
      },
      {
        payload: { f: "empty.txt" },
        ports: { f: { type: t("file") } },
        needle: "empty",
      },
      {
        payload: { d: "empty-dir" },
        ports: { d: { type: t("dir") } },
        needle: "empty",
      },
      {
        payload: { f: outside },
        ports: { f: { type: t("file") } },
        needle: "inside the workspace",
      },
      {
        payload: { f: "not-a-file" },
        ports: { f: { type: t("file") } },
        needle: "expected a file",
      },
      {
        payload: { d: "not-a-dir" },
        ports: { d: { type: t("dir") } },
        needle: "expected a directory",
      },
      {
        payload: { f: "../escape.txt" },
        ports: { f: { type: t("file") } },
        needle: "inside the workspace",
      },
    ];

    for (const c of cases) {
      const errors = validatePortReferences(c.payload, c.ports, root);
      expect(errors.length, JSON.stringify(c.payload)).toBeGreaterThan(0);
      expect(errors.some((e) => e.includes(c.needle)), errors.join("; ")).toBe(true);
      // Bounce shape.
      expect(errors[0]).toMatch(/^\/.+: .+/);
    }
  });

  it("walks file leaves inside arrays and dicts", () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, "a.txt"), "a\n");
    // b.txt missing

    const errors = validatePortReferences(
      { files: ["a.txt", "b.txt"], named: { main: "a.txt", side: "missing.txt" } },
      {
        files: { type: t("file[]") },
        named: { type: t("dict<string, file>") },
      },
      root,
    );
    expect(errors.some((e) => e.startsWith("/files/1:"))).toBe(true);
    expect(errors.some((e) => e.startsWith("/named/side:"))).toBe(true);
    expect(errors.every((e) => !e.startsWith("/files/0:"))).toBe(true);
  });
});

describe("validateDeliverableReport", () => {
  it("returns Ajv shape errors before reference stats", () => {
    const root = tmpDir();
    const errors = validateDeliverableReport(
      { notes: 12 },
      { notes: { type: t("text"), bounds: { maxLength: 50 } } },
      root,
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("/notes"))).toBe(true);
  });

  it("runs reference stat after a passing shape check", () => {
    const root = tmpDir();
    const errors = validateDeliverableReport(
      { artifact: "nope.bin" },
      { artifact: { type: t("file") } },
      root,
    );
    expect(errors.some((e) => e.includes("does not exist"))).toBe(true);
  });

  it("accepts a fully valid file deliverable report", () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, "out.pdf"), "%PDF\n");
    expect(
      validateDeliverableReport(
        { artifact: "out.pdf" },
        { artifact: { type: t("file") } },
        root,
      ),
    ).toEqual([]);
  });
});

describe("isInsideWorkspace", () => {
  it("accepts the root and descendants; rejects siblings and escapes", () => {
    const root = "/tmp/ws-root";
    expect(isInsideWorkspace("/tmp/ws-root", root)).toBe(true);
    expect(isInsideWorkspace("/tmp/ws-root/a/b", root)).toBe(true);
    expect(isInsideWorkspace("/tmp/ws-root-evil", root)).toBe(false);
    expect(isInsideWorkspace("/tmp/other", root)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deliverablesFromReport
// ---------------------------------------------------------------------------

describe("deliverablesFromReport", () => {
  it("classifies kind from port type and serializes values", () => {
    let n = 0;
    const rows = deliverablesFromReport(
      {
        notes: "hello",
        report: ".parley/tmp/x.1/out/r.pdf",
        artifacts: "out/dir",
        items: [1, 2],
      },
      {
        notes: { type: t("text") },
        report: { type: t("file") },
        artifacts: { type: t("dir") },
        items: { type: t("text[]") },
      },
      {
        runId: "r1",
        node: "bundle",
        iteration: 1,
        slot: null,
        taskId: "t1",
        nextId: () => `d${++n}`,
      },
    );
    expect(rows).toHaveLength(4);
    const byPort = Object.fromEntries(rows.map((r) => [r.port, r]));
    expect(byPort.notes!.kind).toBe("inline");
    expect(byPort.notes!.value).toBe(JSON.stringify("hello"));
    expect(byPort.report!.kind).toBe("file");
    expect(byPort.report!.value).toBe(".parley/tmp/x.1/out/r.pdf");
    expect(byPort.artifacts!.kind).toBe("dir");
    expect(byPort.items!.kind).toBe("inline");
    expect(byPort.items!.value).toBe(JSON.stringify([1, 2]));
    expect(byPort.notes!.run_id).toBe("r1");
    expect(byPort.notes!.task_id).toBe("t1");
  });

  it("deliverableKind maps only outermost file/dir", () => {
    expect(deliverableKind(t("file"))).toBe("file");
    expect(deliverableKind(t("dir"))).toBe("dir");
    expect(deliverableKind(t("file[]"))).toBe("inline");
    expect(deliverableKind(t("text"))).toBe("inline");
  });
});

// ---------------------------------------------------------------------------
// materializeInputs
// ---------------------------------------------------------------------------

describe("materializeInputs", () => {
  it("writes one file per scalar/container port under .parley/tmp/<address>/in/", () => {
    const root = tmpDir();
    const result = materializeInputs({
      workspaceRoot: root,
      address: { node: "funnel", iteration: 1 },
      inputs: [
        { name: "brief", type: t("text"), value: "what is hybrid search?" },
        {
          name: "harvest",
          type: t("dict<string, text>"),
          value: { q1: "a", q2: "b" },
        },
        { name: "skipped", type: t("text"), value: undefined },
      ],
    });

    expect(result.address).toBe("funnel.1");
    expect(fs.existsSync(result.inDir)).toBe(true);
    expect(result.ports.map((p) => p.port).sort()).toEqual(["brief", "harvest"]);

    const brief = result.ports.find((p) => p.port === "brief")!;
    expect(brief.form).toBe("inline-file");
    expect(brief.relativePath).toBe(".parley/tmp/funnel.1/in/brief");
    expect(fs.readFileSync(brief.absolutePath, "utf8")).toBe("what is hybrid search?\n");

    const harvest = result.ports.find((p) => p.port === "harvest")!;
    expect(JSON.parse(fs.readFileSync(harvest.absolutePath, "utf8"))).toEqual({
      q1: "a",
      q2: "b",
    });
  });

  it("copies file/dir referents on read (cross-workspace handoff)", () => {
    const producer = tmpDir("parley-prod-");
    const consumer = tmpDir("parley-cons-");
    fs.writeFileSync(path.join(producer, "report.pdf"), "PDFBYTES");
    fs.mkdirSync(path.join(producer, "data"));
    fs.writeFileSync(path.join(producer, "data", "x.json"), "{\"n\":1}\n");

    const result = materializeInputs({
      workspaceRoot: consumer,
      address: "join.1",
      inputs: [
        {
          name: "report",
          type: t("file"),
          value: "report.pdf",
          referentRoot: producer,
        },
        {
          name: "data",
          type: t("dir"),
          value: "data",
          referentRoot: producer,
        },
      ],
    });

    const report = result.ports.find((p) => p.port === "report")!;
    expect(report.missingReferent).toBe(false);
    expect(report.form).toBe("copied-file");
    expect(fs.readFileSync(report.absolutePath, "utf8")).toBe("PDFBYTES");
    // Source was not moved.
    expect(fs.readFileSync(path.join(producer, "report.pdf"), "utf8")).toBe("PDFBYTES");

    const data = result.ports.find((p) => p.port === "data")!;
    expect(data.missingReferent).toBe(false);
    expect(data.form).toBe("copied-dir");
    expect(fs.readFileSync(path.join(data.absolutePath, "x.json"), "utf8")).toBe(
      "{\"n\":1}\n",
    );
  });

  it("treats a gone file/dir referent as normal (no throw)", () => {
    const consumer = tmpDir();
    const producer = tmpDir();
    // nothing written in producer

    const result = materializeInputs({
      workspaceRoot: consumer,
      address: "join.2",
      inputs: [
        {
          name: "report",
          type: t("file"),
          value: "gone.pdf",
          referentRoot: producer,
        },
        {
          name: "data",
          type: t("dir"),
          value: "gone-dir",
          referentRoot: producer,
        },
      ],
    });

    expect(result.ports).toHaveLength(2);
    expect(result.ports.every((p) => p.missingReferent)).toBe(true);
    expect(fs.existsSync(path.join(result.inDir, "report"))).toBe(false);
    expect(fs.existsSync(path.join(result.inDir, "data"))).toBe(false);
  });

  it("accepts a structured address with slot", () => {
    const root = tmpDir();
    const result = materializeInputs({
      workspaceRoot: root,
      address: { node: "search", iteration: 1, slot: "q0" },
      inputs: [{ name: "query", type: t("text"), value: "ann" }],
    });
    expect(result.address).toBe("search.1.q0");
    expect(result.ports[0]!.relativePath).toBe(".parley/tmp/search.1.q0/in/query");
  });
});

describe("renderInputFileBody", () => {
  it("writes scalars as text and containers as JSON", () => {
    expect(renderInputFileBody(t("text"), "hi")).toBe("hi");
    expect(renderInputFileBody(t("url"), "https://x.test")).toBe("https://x.test");
    expect(renderInputFileBody(t("verdict"), "approve")).toBe("approve");
    expect(JSON.parse(renderInputFileBody(t("text[]"), ["a", "b"]))).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// renderInputsSection — type-driven (ADR-0016)
// ---------------------------------------------------------------------------

describe("renderInputsSection", () => {
  it("inlines scalars and paths containers; omits unfilled and missing", () => {
    const text = renderInputsSection([
      { name: "brief", type: t("text"), value: "research hybrid search" },
      {
        name: "harvest",
        type: t("dict<string, text>"),
        value: { a: "1" },
        materializationPath: ".parley/tmp/funnel.1/in/harvest",
      },
      {
        name: "report",
        type: t("file"),
        value: "report.pdf",
        materializationPath: ".parley/tmp/join.1/in/report",
      },
      { name: "gaps", type: t("text"), value: undefined },
      {
        name: "lost",
        type: t("file"),
        value: "gone.pdf",
        missingReferent: true,
      },
      {
        // container without a path → omit (nothing to point at)
        name: "orphan",
        type: t("text[]"),
        value: ["x"],
      },
    ]);

    expect(text).toContain("## Inputs");
    expect(text).toContain("`brief` (text): research hybrid search");
    expect(text).toContain("`harvest` (dict<string, text>): see `.parley/tmp/funnel.1/in/harvest`");
    expect(text).toContain("`report` (file): see `.parley/tmp/join.1/in/report`");
    expect(text).not.toContain("gaps");
    expect(text).not.toContain("lost");
    expect(text).not.toContain("orphan");
  });

  it("returns empty string when every port is omitted", () => {
    expect(renderInputsSection([{ name: "x", type: t("text"), value: undefined }])).toBe(
      "",
    );
  });
});
