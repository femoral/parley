/** @vitest-environment happy-dom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RosterPanel, describePipTrack } from "../src/hud/index.js";
import type { RosterGroup, RosterPip, RosterSessionOption } from "../src/hud/index.js";
import { Inspector } from "../src/hud/Inspector/index.js";
import type { InspectorRun } from "../src/hud/types.js";

afterEach(cleanup);

const uiRoot = process.cwd().endsWith("packages/ui")
  ? process.cwd()
  : resolve(process.cwd(), "packages/ui");

const HUD_CSS = readFileSync(resolve(uiRoot, "src/hud/hud.css"), "utf8");
const TOKENS_CSS = readFileSync(resolve(uiRoot, "src/tokens/tokens.css"), "utf8");

/** Last matching rule block for a selector (cascade order). */
function blockFor(css: string, selector: string): string {
  const re = new RegExp(
    selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]+)\\}",
    "g",
  );
  const matches = [...css.matchAll(re)];
  expect(matches.length, `expected a rule for ${selector}`).toBeGreaterThan(0);
  return matches[matches.length - 1]![1]!;
}

/** Resolve a simple `var(--token)` token value from tokens.css :root. */
function tokenValue(name: string): string {
  const re = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*([^;]+);`);
  const m = TOKENS_CSS.match(re);
  expect(m, `token ${name}`).toBeTruthy();
  let v = m![1]!.trim();
  // Follow one level of var(--other).
  const ref = v.match(/^var\((--[a-z0-9-]+)\)$/i);
  if (ref) {
    const m2 = TOKENS_CSS.match(
      new RegExp(`${ref[1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*([^;]+);`),
    );
    expect(m2, `token ref ${ref[1]}`).toBeTruthy();
    v = m2![1]!.trim();
  }
  return v;
}

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function relLum(hex: string): number {
  const [r, g, b] = parseHex(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrastRatio(a: string, b: string): number {
  const L1 = relLum(a);
  const L2 = relLum(b);
  const hi = Math.max(L1, L2);
  const lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
}

function compositeOver(fgHex: string, bgHex: string, alpha: number): string {
  const [fr, fg, fb] = parseHex(fgHex);
  const [br, bg, bb] = parseHex(bgHex);
  const r = Math.round((1 - alpha) * br! + alpha * fr!);
  const g = Math.round((1 - alpha) * bg! + alpha * fg!);
  const b = Math.round((1 - alpha) * bb! + alpha * fb!);
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

function parseRgbaAlpha(value: string): number {
  const m = value.match(/rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/i);
  expect(m, `rgba alpha in ${value}`).toBeTruthy();
  return Number(m![1]);
}

const SESSIONS: RosterSessionOption[] = [];

const GROUPS: RosterGroup[] = [
  {
    state: "awaiting_answer",
    runs: [
      {
        id: "r-a19c0001",
        name: "coding-2",
        attentionState: "awaiting_answer",
        runState: "blocked",
        subtitle: "rework-or-finish — held",
        meta: "pass 1 · 3 tasks · 6m",
        heldGate: true,
        pips: [
          { kind: "done" },
          { kind: "done" },
          { kind: "done" },
          { kind: "gate" },
        ],
        updatedAt: "2026-07-01T00:06:00.000Z",
        orchestratorSession: "sess-1",
      },
    ],
    tasks: [
      {
        id: "t-plain-await",
        name: "migrate the seed script",
        coat: "#d1784c",
        emblem: { kind: "glyph", char: "✳" },
        faction: "Claude",
        meta: "parley/t41 · t-plain-",
        updatedAt: "2026-07-01T00:05:00.000Z",
      },
    ],
  },
  {
    state: "running",
    runs: [
      {
        id: "r-7f3a0001",
        name: "coding-1",
        attentionState: "running",
        runState: "running",
        subtitle: "review — 1 of 3",
        meta: "pass 2 · 6 tasks · 11m",
        heldGate: false,
        pips: [
          { kind: "done" },
          { kind: "done" },
          { kind: "done" },
          { kind: "live" },
          { kind: "empty" },
        ],
        updatedAt: "2026-07-01T00:11:00.000Z",
        orchestratorSession: "sess-1",
      },
    ],
    tasks: [
      {
        id: "t-owned",
        name: "review the branch",
        coat: "#59616f",
        emblem: { kind: "glyph", char: "✦" },
        faction: "Grok",
        meta: "feat/review · t-owned",
        runChip: "r-7f3a00 · review.2.tests",
      },
      {
        id: "t-plain",
        name: "bump deps",
        coat: "#18a886",
        emblem: { kind: "glyph", char: "◈" },
        faction: "Codex",
        meta: "parley/t44 · t-plain",
      },
    ],
  },
];

function baseProps() {
  return {
    groups: GROUPS,
    sessions: SESSIONS,
    selectedSessionId: null,
    onSelectSession: vi.fn(),
    searchSessions: vi.fn(async () => []),
    selectedTaskId: null as string | null,
    onSelectTask: vi.fn(),
    selectedRunId: null as string | null,
    onSelectRun: vi.fn(),
    totalTasks: 3,
    activeTasks: 3,
  };
}

describe("RosterPanel run rows (#254)", () => {
  it("renders run peers in their attention groups beside tasks", () => {
    render(<RosterPanel {...baseProps()} />);
    expect(screen.getByRole("option", { name: /coding-2/i })).toBeTruthy();
    expect(screen.getByRole("option", { name: /coding-1/i })).toBeTruthy();
    expect(screen.getByRole("option", { name: /migrate the seed script/i })).toBeTruthy();
    expect(screen.getByRole("option", { name: /review the branch/i })).toBeTruthy();
    expect(screen.getByRole("option", { name: /bump deps/i })).toBeTruthy();
    // Group counts include runs + tasks (awaiting 2, running 3).
    expect(screen.getByRole("group", { name: /AWAITING \(2\)/i })).toBeTruthy();
    expect(screen.getByRole("group", { name: /RUNNING \(3\)/i })).toBeTruthy();
  });

  it("shows a run chip on run-owned tasks and none on plain tasks", () => {
    render(<RosterPanel {...baseProps()} />);
    expect(screen.getByText("r-7f3a00 · review.2.tests")).toBeTruthy();
    // Plain task keeps branch · id meta, not a run chip.
    expect(screen.getByText(/parley\/t44/)).toBeTruthy();
  });

  it("renders a static pip track on the run row", () => {
    const { container } = render(<RosterPanel {...baseProps()} />);
    const tracks = container.querySelectorAll(".pc-roster__pips");
    expect(tracks.length).toBe(2);
    const firstPips = tracks[0]!.querySelectorAll(".pc-roster__pip");
    expect(firstPips.length).toBe(4);
    expect(tracks[1]!.querySelectorAll(".pc-roster__pip").length).toBe(5);
  });

  it("exposes pip progress via accessible name, not class (#260)", () => {
    // coding-1: 3 done, 1 under way, 1 not started of 5
    render(<RosterPanel {...baseProps()} />);
    const track = screen.getByRole("img", {
      name: /Progress: 3 done, 1 under way, 1 not started of 5/i,
    });
    expect(track).toBeTruthy();
    // Reachable without querying by class.
    expect(track.className).toMatch(/pc-roster__pips/);
    // Option name also carries the summary (option aria-label overrides children).
    expect(
      screen.getByRole("option", {
        name: /coding-1.*Progress: 3 done, 1 under way, 1 not started of 5/i,
      }),
    ).toBeTruthy();
    // Held gate track.
    expect(
      screen.getByRole("img", {
        name: /Progress: 3 done, 1 gated of 4/i,
      }),
    ).toBeTruthy();
  });

  it("describePipTrack summarises kinds against the bound", () => {
    const pips: RosterPip[] = [
      { kind: "done" },
      { kind: "done" },
      { kind: "live" },
      { kind: "empty" },
      { kind: "empty" },
    ];
    expect(describePipTrack(pips)).toBe(
      "Progress: 2 done, 1 under way, 2 not started of 5",
    );
  });

  it("selecting a run calls onSelectRun, not onSelectTask", () => {
    const props = baseProps();
    render(<RosterPanel {...props} />);
    fireEvent.click(screen.getByRole("option", { name: /coding-1/i }));
    expect(props.onSelectRun).toHaveBeenCalledWith("r-7f3a0001");
    expect(props.onSelectTask).not.toHaveBeenCalled();
  });

  it("marks the selected run row", () => {
    render(<RosterPanel {...baseProps()} selectedRunId="r-7f3a0001" />);
    const row = screen.getByRole("option", { name: /coding-1/i });
    expect(row.getAttribute("aria-selected")).toBe("true");
  });

  it("renders the full 8-char short id on an attention (held) run row", () => {
    // DOM presence of all 8 id characters (roster omits the redundant "run "
    // prefix; accessible name still says "run"). CSS non-shrink is the real
    // layout contract — see the CSS-source assertions below.
    render(<RosterPanel {...baseProps()} />);
    const held = screen.getByRole("option", { name: /coding-2/i });
    const idEl = held.querySelector(".pc-roster__run-id");
    expect(idEl).toBeTruthy();
    // shortRef("r-a19c0001") → "r-a19c00" (8 chars).
    expect(idEl!.textContent).toBe("r-a19c00");
    expect(idEl!.textContent!.replace(/^r-/, "")).toHaveLength(6);
  });

  it("CSS: run-head has a shrinkable name; short-id never shrinks", () => {
    // Protects: at 300px roster with age+beacon, the head must not overflow
    // (badge overprinting age/beacon). Name is the only flex-shrink child;
    // id stays flex:0 0 auto so all 8 short-id characters render.
    const idBlocks = [
      ...HUD_CSS.matchAll(/\.pc-roster__run-id\s*\{([^}]+)\}/g),
    ];
    const nameBlocks = [
      ...HUD_CSS.matchAll(
        /\.pc-roster__run-head\s+\.pc-roster__name\s*\{([^}]+)\}/g,
      ),
    ];
    expect(idBlocks.length).toBeGreaterThanOrEqual(1);
    expect(nameBlocks.length).toBe(1);
    const idCss = idBlocks[idBlocks.length - 1]![1];
    const nameCss = nameBlocks[0]![1];
    // Id is non-shrinkable (correlation key + copy target).
    expect(idCss).toMatch(/flex:\s*0\s+0\s+auto/);
    expect(idCss).not.toMatch(/min-width:\s*0/);
    // Name shrinks (flex-shrink ≥ 1) but keeps a legible floor — not back to
    // the ~2-character collapse of original defect 5.
    expect(nameCss).toMatch(/flex:\s*1\s+1\s+auto/);
    expect(nameCss).toMatch(/min-width:\s*5ch/);
  });
});

describe("Roster pip track a11y + contrast contracts (#260)", () => {
  it("CSS: empty pip uses --ink-label (not invisible --progress-track)", () => {
    const empty = blockFor(HUD_CSS, ".pc-roster__pip--empty");
    const base = blockFor(HUD_CSS, ".pc-roster__pip");
    expect(empty).toMatch(/background:\s*var\(--ink-label\)/);
    expect(base).toMatch(/background:\s*var\(--ink-label\)/);
    expect(empty).not.toMatch(/--progress-track/);
  });

  it("CSS: track condenses under pressure (min-width 0 + overflow hidden)", () => {
    const track = blockFor(HUD_CSS, ".pc-roster__pips");
    const pip = blockFor(HUD_CSS, ".pc-roster__pip");
    expect(track).toMatch(/overflow:\s*hidden/);
    expect(track).toMatch(/min-width:\s*0/);
    expect(track).toMatch(/flex-wrap:\s*nowrap/);
    // Preferred floor was 4px; under large track_bound pips must be free to
    // shrink so the row never overflows.
    expect(pip).toMatch(/min-width:\s*0/);
    expect(pip).not.toMatch(/min-width:\s*4px/);
  });

  it("CSS: selected row uses tint-18 and solid brass border (above hover)", () => {
    const selected = blockFor(HUD_CSS, ".pc-roster__row--selected");
    const runSelected = blockFor(
      HUD_CSS,
      ".pc-roster__row--run.pc-roster__row--selected",
    );
    const runHover = blockFor(HUD_CSS, ".pc-roster__row--run:hover");
    expect(selected).toMatch(/background:\s*var\(--brass-tint-18\)/);
    expect(runSelected).toMatch(/background:\s*var\(--brass-tint-18\)/);
    expect(runHover).toMatch(/background:\s*var\(--brass-tint-12\)/);
    // Selected and hover must not share the same tint stop.
    expect(runSelected).not.toMatch(/--brass-tint-12/);
    expect(selected).toMatch(/border-color:\s*var\(--brass-border-selected\)/);
    // Token resolves to solid brass, not the old #f0c25a88 alpha.
    const borderSelected = tokenValue("--brass-border-selected");
    expect(borderSelected.toLowerCase()).toBe("#f0c25a");
    expect(TOKENS_CSS).toMatch(/--brass-tint-18:\s*rgba\(240,\s*194,\s*90,\s*0\.18\)/);
  });

  it("empty pip contrast ≥ 3:1 against rest / hover / selected row washes", () => {
    // Composite brass tints over plate-top (lighter plate → tighter ratio for
    // a light empty pip). Values from tokens.css; ratios computed here.
    const plateTop = tokenValue("--plate-top"); // #1d140c
    const brass = tokenValue("--brass"); // #f0c25a
    const emptyPip = tokenValue("--ink-label"); // #967c54
    const restA = parseRgbaAlpha(tokenValue("--brass-tint-06"));
    const hoverA = parseRgbaAlpha(tokenValue("--brass-tint-12"));
    const selA = parseRgbaAlpha(tokenValue("--brass-tint-18"));
    expect(restA).toBeCloseTo(0.06, 5);
    expect(hoverA).toBeCloseTo(0.12, 5);
    expect(selA).toBeCloseTo(0.18, 5);

    const restBg = compositeOver(brass, plateTop, restA);
    const hoverBg = compositeOver(brass, plateTop, hoverA);
    const selBg = compositeOver(brass, plateTop, selA);

    const restR = contrastRatio(emptyPip, restBg);
    const hoverR = contrastRatio(emptyPip, hoverBg);
    const selR = contrastRatio(emptyPip, selBg);

    // Measured ratios (assert both floor and documented values).
    expect(restR).toBeGreaterThanOrEqual(3);
    expect(hoverR).toBeGreaterThanOrEqual(3);
    expect(selR).toBeGreaterThanOrEqual(3);
    // Pin the measured numbers so a token drift fails loudly.
    expect(restR).toBeCloseTo(4.11, 1);
    expect(hoverR).toBeCloseTo(3.57, 1);
    expect(selR).toBeCloseTo(3.07, 1);
  });

  it("selection border contrast does not drop vs unselected brass-border", () => {
    const plateTop = tokenValue("--plate-top");
    const brass = tokenValue("--brass");
    const unselectedBorder = tokenValue("--brass-border"); // #b98f3f
    const selectedBorder = tokenValue("--brass-border-selected"); // #f0c25a
    const restA = parseRgbaAlpha(tokenValue("--brass-tint-06"));
    const selA = parseRgbaAlpha(tokenValue("--brass-tint-18"));
    const restBg = compositeOver(brass, plateTop, restA);
    const selBg = compositeOver(brass, plateTop, selA);

    const before = contrastRatio(unselectedBorder, restBg);
    const after = contrastRatio(selectedBorder, selBg);
    // Selection must not reduce border contrast (the old alpha border did).
    expect(after).toBeGreaterThanOrEqual(before);
    expect(before).toBeCloseTo(5.47, 1);
    expect(after).toBeCloseTo(7.28, 1);
  });
});

describe("Inspector run view (#254)", () => {
  const run: InspectorRun = {
    status: "ready",
    id: "r-c04e0001",
    workflow: "research",
    workflowVersion: 1,
    runState: "blocked",
    stateLabel: "blocked · gate",
    branch: "parley/r-c04e-research",
    currentNode: "accept-sources",
    iteration: 1,
    duration: "21m 0s",
    tasksTotal: 32,
    heldGate: true,
    deliverables: { status: "not_fetched" },
    block: {
      reason: "gate",
      detail: "held",
      node: "accept-sources",
    },
    nodes: [
      {
        key: "scope\u00001",
        node: "scope",
        kind: "step",
        iteration: 1,
        state: "completed",
        stateLabel: "completed",
        tasksLabel: "1",
        gist: "12 queries",
        age: "18m",
        fanoutWidth: null,
        spineState: "completed",
        live: false,
        onReject: null,
      },
      {
        key: "search\u00001",
        node: "search",
        kind: "step",
        iteration: 1,
        state: "completed",
        stateLabel: "completed",
        tasksLabel: "12",
        gist: "sources 84",
        age: "14m",
        fanoutWidth: 12,
        spineState: "completed",
        live: false,
        onReject: null,
      },
      {
        key: "accept\u00001",
        node: "accept-sources",
        kind: "gate",
        iteration: 1,
        state: "waiting",
        stateLabel: "gate · held",
        tasksLabel: "—",
        gist: "Proceed to adversarial review?",
        age: "21m",
        fanoutWidth: null,
        spineState: "awaiting_answer",
        live: true,
        onReject: "funnel",
      },
    ],
  };

  it("renders one table row per (node, iteration) with polymorphic STATE", () => {
    render(<Inspector task={null} run={run} />);
    expect(screen.getByText("scope")).toBeTruthy();
    expect(screen.getByText("search")).toBeTruthy();
    expect(screen.getByText("accept-sources")).toBeTruthy();
    expect(screen.getAllByText("completed").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("gate · held")).toBeTruthy();
    expect(screen.getByText(/×12/)).toBeTruthy();
    expect(screen.getByText(/Held — awaiting the orchestrator/i)).toBeTruthy();
    // One body row per (node, iteration).
    expect(document.querySelectorAll(".pc-runview__table tbody tr")).toHaveLength(3);
    // No gate action controls.
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /reject/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /redirect/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /finish/i })).toBeNull();
  });

  it("fan-out tally ×N is present in the node cell accessible text", () => {
    render(<Inspector task={null} run={run} />);
    const nodes = Array.from(document.querySelectorAll(".pc-runview__node"));
    const search = nodes.find((n) => n.textContent?.includes("search"));
    expect(search).toBeTruthy();
    // Load-bearing: width is written beside the node name, not drawn.
    expect(search!.textContent).toMatch(/search/);
    expect(search!.textContent).toMatch(/×12/);
    expect(search!.querySelector(".pc-runview__fan")?.textContent?.trim()).toBe("×12");
  });

  it("iteration suffix .N is present when iteration > 1", () => {
    const multi: InspectorRun = {
      ...run,
      nodes: [
        {
          key: "review\u00002",
          node: "review",
          kind: "step",
          iteration: 2,
          state: "running",
          stateLabel: "running",
          tasksLabel: "3",
          gist: "1 of 3 still out",
          age: "4m",
          fanoutWidth: 3,
          spineState: "running",
          live: true,
          onReject: null,
        },
      ],
    };
    render(<Inspector task={null} run={multi} />);
    const cell = document.querySelector(".pc-runview__node");
    expect(cell?.textContent).toMatch(/review/);
    expect(cell?.textContent).toMatch(/×3/);
    expect(cell?.textContent).toMatch(/\.2/);
  });

  it("pending run shows hailing copy without inventing 0 tasks", () => {
    render(
      <Inspector task={null} run={{ status: "pending", id: "r-pending1" }} />,
    );
    expect(screen.getByText("Hailing the run…")).toBeTruthy();
    expect(screen.queryByText("0 tasks")).toBeNull();
    expect(screen.queryByText("No nodes entered yet.")).toBeNull();
  });

  it("right-edge table fade is present and uses the hidden gate", () => {
    // Protects: fade must not paint at scroll end (AA on the age column).
    // happy-dom has no layout engine, so with zero overflow the fade starts
    // hidden — the behavioural contract is the [hidden] attribute + CSS rule.
    render(<Inspector task={null} run={run} />);
    const fade = document.querySelector(".pc-runview__table-fade");
    expect(fade).toBeTruthy();
    expect(fade!.hasAttribute("hidden")).toBe(true);
    expect(HUD_CSS).toMatch(
      /\.pc-runview__table-fade\[hidden\]\s*\{[^}]*display:\s*none/s,
    );
  });

  it("CSS: table scrolls honestly — content minima, no fixed percentage clip", () => {
    // Protects: ×N / .N / STATE stay fully written (never hard-clipped by a
    // table-layout:fixed percentage plan). Scrollport is the affordance.
    const tableBlocks = [
      ...HUD_CSS.matchAll(/\.pc-runview__table\s*\{([^}]+)\}/g),
    ];
    expect(tableBlocks.length).toBeGreaterThanOrEqual(1);
    const tableCss = tableBlocks[tableBlocks.length - 1]![1];
    // No percentage-clip plan; no redundant floor that bloated short tables.
    expect(tableCss).not.toMatch(/table-layout:\s*fixed/);
    expect(tableCss).not.toMatch(/min-width:\s*36rem/);
    expect(tableCss).toMatch(/width:\s*max-content/);
    // Per-column minima keep the port scrollable without a table-wide floor.
    expect(HUD_CSS).toMatch(
      /\.pc-runview__table\s+td\.pc-runview__node\s*\{[^}]*min-width:/s,
    );
    expect(HUD_CSS).toMatch(
      /\.pc-runview__table\s+th:nth-child\(3\)\s*\{[^}]*min-width:/s,
    );
    // Node cells must not hard-clip (would delete ×N / .N).
    const nodeBlocks = [
      ...HUD_CSS.matchAll(/\.pc-runview__node\s*\{([^}]+)\}/g),
    ];
    const nodeCss = nodeBlocks[nodeBlocks.length - 1]![1];
    expect(nodeCss).not.toMatch(/overflow:\s*hidden/);
    expect(nodeCss).not.toMatch(/text-overflow:\s*ellipsis/);
    // Spine rail holds 18px so the knot never overlays node text.
    expect(HUD_CSS).toMatch(
      /\.pc-runview__rail\s*\{[^}]*min-width:\s*18px/s,
    );
  });
});
