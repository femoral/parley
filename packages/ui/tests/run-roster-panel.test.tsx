/** @vitest-environment happy-dom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  RosterPanel,
  describePipTrack,
  visiblePipTrack,
  ROSTER_PIP_VISIBLE_CAP,
} from "../src/hud/index.js";
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

  it("exposes pip progress via accessible description once, not class (#260)", () => {
    // coding-1: 3 done, 1 live, 1 empty — description only (not the option name).
    render(<RosterPanel {...baseProps()} />);
    const option = screen.getByRole("option", { name: /coding-1/i });
    // Name stays short — progress is not in the accessible name.
    expect(option.getAttribute("aria-label") ?? "").not.toMatch(/Progress/i);
    const descId = option.getAttribute("aria-describedby");
    expect(descId).toBeTruthy();
    const desc = document.getElementById(descId!);
    expect(desc?.textContent).toBe("Progress of 5: 3 done, 1 live, 1 empty");
    // Reachable without querying by class.
    expect(desc?.className).toMatch(/pc-visually-hidden/);
    // Held gate track — single carrier.
    const held = screen.getByRole("option", { name: /coding-2/i });
    const heldDesc = document.getElementById(held.getAttribute("aria-describedby")!);
    expect(heldDesc?.textContent).toBe("Progress of 4: 3 done, 1 gate");
    // No role=img progress node (would double the sentence in the AX tree).
    expect(screen.queryByRole("img", { name: /Progress/i })).toBeNull();
  });

  it("describePipTrack uses honest kind labels and leading bound", () => {
    const pips: RosterPip[] = [
      { kind: "done" },
      { kind: "done" },
      { kind: "live" },
      { kind: "empty" },
      { kind: "empty" },
    ];
    // Kind names only — live/empty fold more than one wire state.
    expect(describePipTrack(pips)).toBe("Progress of 5: 2 done, 1 live, 2 empty");
  });

  it("visiblePipTrack caps at ROSTER_PIP_VISIBLE_CAP and keeps severity", () => {
    const pips: RosterPip[] = Array.from({ length: 70 }, (_, i) => {
      if (i === 50) return { kind: "fail" as const };
      if (i < 40) return { kind: "done" as const };
      return { kind: "empty" as const };
    });
    const visible = visiblePipTrack(pips);
    expect(visible).toHaveLength(ROSTER_PIP_VISIBLE_CAP);
    expect(visible.some((p) => p.kind === "fail")).toBe(true);
    expect(describePipTrack(pips)).toMatch(
      new RegExp(
        `Progress of 70: 40 done, 1 failed, 29 empty; showing ${ROSTER_PIP_VISIBLE_CAP} segments`,
      ),
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

  it("CSS: pip min-width stays 4px; overflow handled by JS cap (#260/#269)", () => {
    const track = blockFor(HUD_CSS, ".pc-roster__pips");
    const pip = blockFor(HUD_CSS, ".pc-roster__pip");
    expect(track).toMatch(/overflow:\s*hidden/);
    expect(track).toMatch(/flex-wrap:\s*nowrap/);
    // #269 requires the 4px floor; do not shrink pips to 0.
    expect(pip).toMatch(/min-width:\s*4px/);
  });

  it("CSS: selection is border + inset rail; wash stays at rest (no tint-18)", () => {
    // Avoid substring match: `.pc-roster__row--selected` also appears inside
    // `.pc-roster__row--run.pc-roster__row--selected`.
    const taskSelectedBlocks = [
      ...HUD_CSS.matchAll(
        /(?<![\w-])\.pc-roster__row--selected\s*\{([^}]+)\}/g,
      ),
    ];
    expect(taskSelectedBlocks.length).toBeGreaterThan(0);
    const selected = taskSelectedBlocks[taskSelectedBlocks.length - 1]![1]!;
    const runSelected = blockFor(
      HUD_CSS,
      ".pc-roster__row--run.pc-roster__row--selected",
    );
    const runRestBlocks = [
      ...HUD_CSS.matchAll(/(?<![\w-])\.pc-roster__row--run\s*\{([^}]+)\}/g),
    ];
    expect(runRestBlocks.length).toBeGreaterThan(0);
    const runRest = runRestBlocks[runRestBlocks.length - 1]![1]!;
    const runHover = blockFor(HUD_CSS, ".pc-roster__row--run:hover");
    const runSelectedHover = blockFor(
      HUD_CSS,
      ".pc-roster__row--run.pc-roster__row--selected:hover",
    );
    // Lookbehind: bare `.pc-roster__row--selected:hover` must not match the
    // run-prefixed selector that also ends in that suffix.
    const taskSelectedHoverBlocks = [
      ...HUD_CSS.matchAll(
        /(?<![\w-])\.pc-roster__row--selected:hover\s*\{([^}]+)\}/g,
      ),
    ];
    expect(taskSelectedHoverBlocks.length).toBeGreaterThan(0);
    const taskSelectedHover =
      taskSelectedHoverBlocks[taskSelectedHoverBlocks.length - 1]![1]!;
    // Task selected: no wash (matches rest).
    expect(selected).toMatch(/background:\s*none/);
    // Run selected: same tint-06 as rest, not hover's 0.12, not 0.18.
    expect(runSelected).toMatch(/background:\s*var\(--brass-tint-06\)/);
    expect(runRest).toMatch(/background:\s*var\(--brass-tint-06\)/);
    expect(runHover).toMatch(/background:\s*var\(--brass-tint-12\)/);
    expect(runSelected).not.toMatch(/--brass-tint-12/);
    // Selected still responds to hover (was a QC blocker when selected
    // outranked :hover with no selected:hover rule).
    expect(runSelectedHover).toMatch(/background:\s*var\(--brass-tint-12\)/);
    expect(taskSelectedHover).toMatch(/background:\s*var\(--brass-tint-06\)/);
    expect(selected).toMatch(/border-color:\s*var\(--brass-border-selected\)/);
    expect(runSelected).toMatch(/border-color:\s*var\(--brass-border-selected\)/);
    // Exclusive non-wash channel: inset leading rail (edge weight).
    expect(selected).toMatch(
      /box-shadow:\s*inset\s+3px\s+0\s+0\s+0\s+var\(--brass\)/,
    );
    expect(runSelected).toMatch(
      /box-shadow:\s*inset\s+3px\s+0\s+0\s+0\s+var\(--brass\)/,
    );
    // Token resolves to solid brass, not the old #f0c25a88 alpha.
    const borderSelected = tokenValue("--brass-border-selected");
    expect(borderSelected.toLowerCase()).toBe("#f0c25a");
    expect(TOKENS_CSS).not.toMatch(/--brass-tint-18/);
  });

  it("empty pip contrast ≥ 3:1 against rest / hover / selected row washes", () => {
    // Run selected wash === rest (tint-06); hover is tint-12.
    const plateTop = tokenValue("--plate-top"); // #1d140c
    const brass = tokenValue("--brass"); // #f0c25a
    const emptyPip = tokenValue("--ink-label"); // #967c54
    const restA = parseRgbaAlpha(tokenValue("--brass-tint-06"));
    const hoverA = parseRgbaAlpha(tokenValue("--brass-tint-12"));
    expect(restA).toBeCloseTo(0.06, 5);
    expect(hoverA).toBeCloseTo(0.12, 5);

    const restBg = compositeOver(brass, plateTop, restA);
    const hoverBg = compositeOver(brass, plateTop, hoverA);
    const selBg = restBg; // selected wash === rest

    const restR = contrastRatio(emptyPip, restBg);
    const hoverR = contrastRatio(emptyPip, hoverBg);
    const selR = contrastRatio(emptyPip, selBg);

    expect(restR).toBeGreaterThanOrEqual(3);
    expect(hoverR).toBeGreaterThanOrEqual(3);
    expect(selR).toBeGreaterThanOrEqual(3);
    expect(restR).toBeCloseTo(4.11, 1);
    expect(hoverR).toBeCloseTo(3.57, 1);
    expect(selR).toBeCloseTo(4.11, 1);
  });

  it("selection border contrast does not drop vs unselected brass-border", () => {
    const plateTop = tokenValue("--plate-top");
    const brass = tokenValue("--brass");
    const unselectedBorder = tokenValue("--brass-border"); // #b98f3f
    const selectedBorder = tokenValue("--brass-border-selected"); // #f0c25a
    const restA = parseRgbaAlpha(tokenValue("--brass-tint-06"));
    const restBg = compositeOver(brass, plateTop, restA);
    // Selected wash === rest, so border contrast is vs the same composite.
    const before = contrastRatio(unselectedBorder, restBg);
    const after = contrastRatio(selectedBorder, restBg);
    expect(after).toBeGreaterThanOrEqual(before);
    expect(before).toBeCloseTo(5.47, 1);
    expect(after).toBeCloseTo(9.73, 1);
  });

  it("selected-row text contrast equals rest (no drop on selection)", () => {
    // AC3: selection wash matches rest, so every ink ratio is unchanged.
    const plateTop = tokenValue("--plate-top");
    const brass = tokenValue("--brass");
    const restBg = compositeOver(brass, plateTop, 0.06);
    const selBg = restBg;
    for (const token of [
      "--ink-meta",
      "--ink-faint",
      "--ink-label",
      "--ink-parchment",
      "--ink-muted",
    ]) {
      const ink = tokenValue(token);
      expect(contrastRatio(ink, selBg)).toBeCloseTo(contrastRatio(ink, restBg), 5);
    }
  });

  it("DOM: track_bound above the cap renders only ROSTER_PIP_VISIBLE_CAP pips", () => {
    const many: RosterPip[] = Array.from({ length: 100 }, (_, i) =>
      i < 10 ? { kind: "done" as const } : { kind: "empty" as const },
    );
    const groups: RosterGroup[] = [
      {
        state: "running",
        runs: [
          {
            id: "r-cap-test",
            name: "wide-bound",
            attentionState: "running",
            runState: "running",
            subtitle: "x",
            meta: "",
            heldGate: false,
            pips: many,
            orchestratorSession: null,
          },
        ],
        tasks: [],
      },
    ];
    const { container } = render(
      <RosterPanel
        {...baseProps()}
        groups={groups}
        totalTasks={0}
        activeTasks={0}
      />,
    );
    const track = container.querySelector(".pc-roster__pips");
    expect(track?.querySelectorAll(".pc-roster__pip").length).toBe(
      ROSTER_PIP_VISIBLE_CAP,
    );
    // Sighted cue that the track is aggregated (AT already says "showing N").
    expect(track?.classList.contains("pc-roster__pips--capped")).toBe(true);
    expect(track?.querySelector(".pc-roster__pips-cap")).toBeTruthy();
    const option = screen.getByRole("option", { name: /wide-bound/i });
    const desc = document.getElementById(option.getAttribute("aria-describedby")!);
    expect(desc?.textContent).toContain("Progress of 100:");
    expect(desc?.textContent).toContain(`showing ${ROSTER_PIP_VISIBLE_CAP} segments`);
  });

  it("DOM: track at or below the cap has no aggregation mark", () => {
    const { container } = render(<RosterPanel {...baseProps()} />);
    // coding-1 has 5 pips; coding-2 has 4 — both under the cap.
    for (const track of container.querySelectorAll(".pc-roster__pips")) {
      expect(track.classList.contains("pc-roster__pips--capped")).toBe(false);
      expect(track.querySelector(".pc-roster__pips-cap")).toBeNull();
    }
  });

  it("CSS: aggregation tick is a quiet fixed-width mark, not a badge", () => {
    const cap = blockFor(HUD_CSS, ".pc-roster__pips-cap");
    expect(cap).toMatch(/flex:\s*0\s+0\s+6px/);
    expect(cap).toMatch(/repeating-linear-gradient/);
    expect(cap).toMatch(/var\(--brass-border\)/);
    // Not a pill / badge chrome.
    expect(cap).not.toMatch(/border-radius:\s*var\(--radius-pill\)/);
    expect(cap).not.toMatch(/padding:/);
  });

  it("cap fits worst-case track arithmetic (3-char age + beacon + scrollbar)", () => {
    // QC-measured narrowest track ≈156.13px. Cap mark 6px + gap 3px leaves
    // content for pips; min-content of N pips at 4px + 3px gaps must fit.
    const trackW = 156.13;
    const capMark = 6;
    const gap = 3;
    const pipMin = 4;
    const n = ROSTER_PIP_VISIBLE_CAP;
    const minContent = n * pipMin + (n - 1) * gap + gap + capMark;
    expect(minContent).toBeLessThanOrEqual(trackW);
    // Uncapped 24 at 4px floor overflows that track (QC blocker).
    const legacy24 = 24 * pipMin + 23 * gap;
    expect(legacy24).toBeGreaterThan(trackW);
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

  it("duration column header matches CLI naming (#261)", () => {
    render(<Inspector task={null} run={run} />);
    const table = screen.getByRole("table", { name: "Run nodes" });
    const headers = Array.from(table.querySelectorAll("th")).map((th) =>
      (th.textContent ?? "").trim(),
    );
    expect(headers).toContain("Duration");
    expect(headers).not.toContain("Age");
  });

  it("node table has its own accessible name via caption (#261)", () => {
    render(<Inspector task={null} run={run} />);
    // Query by accessible name — not by class — so the caption is load-bearing.
    const table = screen.getByRole("table", { name: "Run nodes" });
    expect(table).toBeTruthy();
    expect(table.querySelector("caption")?.textContent).toBe("Run nodes");
    // Region label is independent of the table's name.
    expect(screen.getByRole("region", { name: "Run node table" })).toBeTruthy();
  });

  it("held gate shows helm notice and block detail together (#261)", () => {
    render(<Inspector task={null} run={run} />);
    expect(screen.getByText(/Held — awaiting the orchestrator/i)).toBeTruthy();
    // Same block.detail the non-gate path already showed — no longer suppressed.
    const block = document.querySelector(".pc-runview__block");
    expect(block?.textContent).toBe("held");
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
