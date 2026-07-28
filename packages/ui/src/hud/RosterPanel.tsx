import {
  memo,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type Ref,
} from "react";
import { Plate, PlateHeader, Emblem, Mark, Stat } from "../primitives/index.js";
import { MARK_ANCHOR, MARK_LENS, MARK_SLOOP } from "../tokens/chrome-glyphs.js";
import { stateMetaFor } from "../tokens/state-meta.js";
import { formatRelativeAge } from "./formatRelativeAge.js";
import {
  notifyHandRolledPopoverClosed,
  notifyHandRolledPopoverOpen,
  subscribeHandRolledPopoverOpen,
} from "./handRolledPopover.js";
import type {
  RosterGroup,
  RosterPip,
  RosterRun,
  RosterSearchHit,
  RosterSessionOption,
  RosterTask,
} from "./types.js";
import { useCopyScaffold } from "./useCopyScaffold.js";
import { formatTaskCount } from "../app/hooks/roster.js";

/** Scaffold the operator pastes into a shell to start a voyage. */
export function delegateScaffold(): string {
  return 'parley delegate -n <name> "<goal>"';
}

/**
 * Imperative surface the roster exposes for the `/` cockpit accelerator
 * (wired in `useCockpitKeys`). Lives in the hud layer so app hooks depend on
 * hud types, never the reverse.
 */
export interface RosterSearchHandle {
  /** Open the session-search well and focus its input. */
  openSearch: () => void;
  /** Whether the session-search popover is currently open. */
  isSearchOpen: () => boolean;
}

export interface RosterPanelProps {
  /** State groups, already ordered by attention rank (hooks layer). */
  groups: RosterGroup[];
  /** Recent orchestrator sessions among the roster's tasks (capped; #88). */
  sessions: RosterSessionOption[];
  /** The active session (`null` = "All hands" / every session). Filters the
   * roster groups the hooks layer projects (#76) and is the future scene's
   * camera-focus target. Single-select only. */
  selectedSessionId: string | null;
  onSelectSession: (id: string | null) => void;
  /**
   * Find across the fleet: task name/branch hits plus historical sessions by
   * id substring (#88). Task hits list first; selecting a task calls
   * {@link onSelectTask}, a session calls {@link onSelectSession}.
   */
  searchSessions: (query: string) => Promise<RosterSearchHit[]>;
  /** The selected task (feeds the inspector/scene). Mutually exclusive with
   * {@link selectedRunId}. */
  selectedTaskId: string | null;
  onSelectTask: (id: string) => void;
  /**
   * The selected run (feeds the inspector run view; centre-stage chart is
   * #253). Mutually exclusive with {@link selectedTaskId}.
   */
  selectedRunId?: string | null;
  onSelectRun?: (id: string) => void;
  totalTasks: number;
  activeTasks: number;
  /**
   * True before the first snapshot has resolved. Distinguishes "taking
   * soundings" from a genuinely empty fleet (PRODUCT.md honesty).
   */
  connecting?: boolean;
  /**
   * Imperative handle for the `/` accelerator: open/focus session search.
   * Optional so existing call sites and tests stay prop-only.
   */
  searchRef?: Ref<RosterSearchHandle | null>;
}

/** Flat listbox entry — runs and tasks are peers (#254). */
type RosterEntry =
  | { kind: "run"; id: string; state: string }
  | { kind: "task"; id: string; state: string };

function entryKey(entry: RosterEntry): string {
  return `${entry.kind}:${entry.id}`;
}

function flattenEntries(groups: RosterGroup[]): RosterEntry[] {
  const out: RosterEntry[] = [];
  for (const group of groups) {
    // Runs first within a group (prototype board 2), then tasks — peers,
    // never nested.
    for (const run of group.runs ?? []) {
      out.push({ kind: "run", id: run.id, state: group.state });
    }
    for (const task of group.tasks) {
      out.push({ kind: "task", id: task.id, state: group.state });
    }
  }
  return out;
}

/**
 * Quiet empty-fleet state: flavor line plus a copyable `parley delegate`
 * starter (mirrors InboxCard / BriefTab scaffold pattern). Read-only —
 * the cove stays watch-only; the operator pastes into their own shell.
 */
function RosterEmptyStarter() {
  const text = delegateScaffold();
  const { copied, canCopy, scaffoldRef, copy } = useCopyScaffold(text);

  return (
    <div className="pc-roster__empty">
      <p className="pc-roster__empty-title">The cove is quiet — no voyages under way.</p>
      <p className="pc-roster__empty-hint">Cast off from your shell:</p>
      <div className="pc-roster__empty-scaffold-row">
        <code className="pc-roster__empty-snippet">{text}</code>
        {/* Hidden scaffold text for select-on-click fallback when clipboard fails. */}
        <span ref={scaffoldRef} className="pc-roster__empty-scaffold" aria-hidden="true">
          {text}
        </span>
        {canCopy && (
          <button
            type="button"
            className="pc-roster__empty-copy"
            onClick={() => void copy()}
            aria-label={copied ? "Copied delegate command" : "Copy delegate command"}
          >
            {copied ? "copied ✓" : "copy"}
          </button>
        )}
      </div>
    </div>
  );
}

/** 8-char short ref — same truncation as InboxCard / hooks `shortId`. */
function shortRef(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/**
 * Split projected meta (`branch · shortId` or branch-alone when the id is
 * already embedded) so the short id can sit outside the ellipsis flex and
 * stay legible at narrow roster widths.
 */
function metaBranchAndId(
  meta: string,
  taskId: string,
): { branch: string | null; idRef: string } {
  const idRef = shortRef(taskId);
  const sep = " · ";
  const idx = meta.lastIndexOf(sep);
  if (idx === -1) {
    // Branch alone (id already a path segment) — no separate id chip.
    return { branch: meta, idRef };
  }
  const right = meta.slice(idx + sep.length);
  // Only treat the right segment as the id when it matches the short ref
  // (projection contract); otherwise keep the whole string as branch.
  if (right === idRef || right === taskId) {
    return { branch: meta.slice(0, idx), idRef };
  }
  return { branch: meta, idRef };
}

/** Coarse clock for attention-row ages — not the cockpit's 1s tick. */
const AGE_TICK_MS = 30_000;

function useCoarseNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => clearInterval(id);
  }, [enabled]);
  return now;
}

/** Attention states where "how long" is the triage variable. */
function showAttentionAge(
  state: string,
  freshFailure: boolean | undefined,
): boolean {
  if (state === "awaiting_answer" || state === "stalled") return true;
  if (state === "failed" && freshFailure) return true;
  return false;
}

function PipTrack({ pips }: { pips: RosterPip[] }) {
  return (
    <div className="pc-roster__pips" aria-hidden="true">
      {pips.map((pip, i) => (
        <span
          key={i}
          className={`pc-roster__pip pc-roster__pip--${pip.kind}`}
        />
      ))}
    </div>
  );
}

function TaskRow({
  task,
  groupState,
  selected,
  focused,
  onSelect,
  onFocus,
  rowRef,
  nowMs,
}: {
  task: RosterTask;
  groupState: string;
  selected: boolean;
  focused: boolean;
  onSelect: () => void;
  onFocus: () => void;
  rowRef: (el: HTMLDivElement | null) => void;
  nowMs: number;
}) {
  const meta = stateMetaFor(groupState);
  const freshFailure = Boolean(task.freshFailure);
  const quiet = freshFailure ? undefined : meta.quiet;
  const quietClass =
    quiet === "soft"
      ? " pc-roster__row--quiet-soft"
      : quiet === "archive"
        ? " pc-roster__row--quiet-archive"
        : "";
  const showBeacon = Boolean(meta.beacon) || freshFailure;
  const beaconStyle = freshFailure
    ? ({
        "--beacon-color": "var(--state-failed)",
        "--beacon-glow-color": "var(--beacon-glow-failed)",
      } as CSSProperties)
    : undefined;
  const age =
    showAttentionAge(groupState, task.freshFailure) && task.updatedAt
      ? formatRelativeAge(task.updatedAt, nowMs)
      : null;
  const accessibleName = age
    ? `${task.name} — ${meta.label}, ${age}`
    : `${task.name} — ${meta.label}`;
  const { branch, idRef } = metaBranchAndId(task.meta, task.id);
  const splitId = task.meta.includes(" · ");
  const runChip = task.runChip ?? null;

  return (
    <div
      role="option"
      className={`pc-roster__row${selected ? " pc-roster__row--selected" : ""}${quietClass}`}
      id={`roster-option-task-${task.id}`}
      aria-label={accessibleName}
      aria-selected={selected}
      tabIndex={focused ? 0 : -1}
      ref={rowRef}
      onClick={onSelect}
      onFocus={onFocus}
    >
      <Emblem coat={task.coat} mark={task.emblem} size={23} label={task.faction} />
      <span className="pc-roster__row-body">
        <span className="pc-roster__name">{task.name}</span>
        <span className="pc-roster__meta" title={task.id}>
          {runChip ? (
            <span className="pc-roster__runchip" aria-hidden="true">
              {runChip}
            </span>
          ) : splitId ? (
            <span className="pc-roster__meta-parts" aria-hidden="true">
              <span className="pc-roster__meta-branch">{branch}</span>
              <span className="pc-roster__meta-sep"> · </span>
              <span className="pc-roster__meta-id">{idRef}</span>
            </span>
          ) : (
            <span aria-hidden="true">{task.meta}</span>
          )}
          <span className="pc-visually-hidden">task id {task.id}</span>
        </span>
      </span>
      {age && (
        <span className="pc-roster__age" title={task.updatedAt ?? undefined} aria-hidden="true">
          {age}
        </span>
      )}
      {showBeacon && (
        <span
          className="pc-roster__beacon pc-dot--beacon"
          style={beaconStyle}
          aria-hidden="true"
        >
          <Mark mark={meta.mark} size={12} />
        </span>
      )}
    </div>
  );
}

function RunRow({
  run,
  groupState,
  selected,
  focused,
  onSelect,
  onFocus,
  rowRef,
  nowMs,
}: {
  run: RosterRun;
  groupState: string;
  selected: boolean;
  focused: boolean;
  onSelect: () => void;
  onFocus: () => void;
  rowRef: (el: HTMLDivElement | null) => void;
  nowMs: number;
}) {
  const meta = stateMetaFor(groupState);
  const quiet = meta.quiet;
  const quietClass =
    quiet === "soft"
      ? " pc-roster__row--quiet-soft"
      : quiet === "archive"
        ? " pc-roster__row--quiet-archive"
        : "";
  const showBeacon = Boolean(meta.beacon) || run.heldGate;
  const age =
    showAttentionAge(groupState, undefined) && run.updatedAt
      ? formatRelativeAge(run.updatedAt, nowMs)
      : null;
  const short = shortRef(run.id);
  const accessibleName = age
    ? `run ${run.name} ${short} — ${meta.label}, ${age}`
    : `run ${run.name} ${short} — ${meta.label}`;

  return (
    <div
      role="option"
      className={`pc-roster__row pc-roster__row--run${
        selected ? " pc-roster__row--selected" : ""
      }${run.heldGate ? " pc-roster__row--held" : ""}${quietClass}`}
      id={`roster-option-run-${run.id}`}
      aria-label={accessibleName}
      aria-selected={selected}
      tabIndex={focused ? 0 : -1}
      ref={rowRef}
      onClick={onSelect}
      onFocus={onFocus}
    >
      <span className="pc-roster__run-mark" aria-hidden="true">
        <Mark mark={MARK_ANCHOR} size={14} />
      </span>
      <span className="pc-roster__row-body">
        <span className="pc-roster__run-head">
          <span className="pc-roster__name" title={`${run.name} · run ${run.id}`}>
            {run.name}
          </span>
          <span className="pc-roster__run-id" title={run.id}>
            run {short}
          </span>
          <span
            className={`pc-roster__run-badge${
              run.heldGate
                ? " pc-roster__run-badge--gate"
                : groupState === "cancelled"
                  ? " pc-roster__run-badge--cancelled"
                  : ""
            }`}
            style={
              run.heldGate || groupState === "cancelled"
                ? undefined
                : ({ ["--run-badge-color"]: meta.colorVar } as CSSProperties)
            }
          >
            {run.heldGate ? "Gate" : "Run"}
          </span>
        </span>
        {run.subtitle && (
          <span className="pc-roster__run-sub">{run.subtitle}</span>
        )}
        <PipTrack pips={run.pips} />
        {run.meta && (
          <span className="pc-roster__meta pc-roster__run-meta">{run.meta}</span>
        )}
      </span>
      {age && (
        <span className="pc-roster__age" title={run.updatedAt ?? undefined} aria-hidden="true">
          {age}
        </span>
      )}
      {showBeacon && (
        <span className="pc-roster__beacon pc-dot--beacon" aria-hidden="true">
          <Mark mark={meta.mark} size={12} />
        </span>
      )}
    </div>
  );
}

function Group({
  group,
  selectedTaskId,
  selectedRunId,
  focusedKey,
  onSelectTask,
  onSelectRun,
  onFocusEntry,
  rowRefs,
  nowMs,
}: {
  group: RosterGroup;
  selectedTaskId: string | null;
  selectedRunId: string | null;
  /** Roving tabindex key (`task:id` / `run:id`). */
  focusedKey: string | null;
  onSelectTask: (id: string) => void;
  onSelectRun: (id: string) => void;
  onFocusEntry: (key: string) => void;
  rowRefs: MutableRefObject<Map<string, HTMLDivElement | null>>;
  nowMs: number;
}) {
  const meta = stateMetaFor(group.state);
  const dotStyle = { "--dot-color": meta.colorVar } as CSSProperties;
  const labelStyle = { "--group-color": meta.colorVar } as CSSProperties;
  const runs = group.runs ?? [];
  const count = runs.length + group.tasks.length;

  return (
    /* role=group: a listbox may only own option/group children — the bare div
       broke the accessible owns-tree. The label carries what the (aria-hidden)
       visual head shows, so AT hears one group name, not the head twice. */
    <div role="group" aria-label={`${meta.label} (${count})`}>
      {/* Group headers stay non-focusable; state lives on each option's name. */}
      <div className="pc-roster__group-head" aria-hidden="true">
        <span className="pc-state-dot" style={dotStyle} aria-hidden="true" title={meta.label}>
          <Mark mark={meta.mark} size={10} />
        </span>
        <span className="pc-roster__group-label" style={labelStyle}>
          {meta.label}
        </span>
        <span className="pc-roster__count">{count}</span>
      </div>
      {runs.map((run) => {
        const key = entryKey({ kind: "run", id: run.id, state: group.state });
        return (
          <RunRow
            key={key}
            run={run}
            groupState={group.state}
            selected={run.id === selectedRunId}
            focused={key === focusedKey}
            onSelect={() => {
              onFocusEntry(key);
              onSelectRun(run.id);
            }}
            onFocus={() => onFocusEntry(key)}
            rowRef={(el) => {
              if (el) rowRefs.current.set(key, el);
              else rowRefs.current.delete(key);
            }}
            nowMs={nowMs}
          />
        );
      })}
      {group.tasks.map((task) => {
        const key = entryKey({ kind: "task", id: task.id, state: group.state });
        return (
          <TaskRow
            key={key}
            task={task}
            groupState={group.state}
            selected={task.id === selectedTaskId}
            focused={key === focusedKey}
            onSelect={() => {
              onFocusEntry(key);
              onSelectTask(task.id);
            }}
            onFocus={() => onFocusEntry(key)}
            rowRef={(el) => {
              if (el) rowRefs.current.set(key, el);
              else rowRefs.current.delete(key);
            }}
            nowMs={nowMs}
          />
        );
      })}
    </div>
  );
}

const SEARCH_DEBOUNCE_MS = 180;

/** Imperative surface SessionSearch exposes to the roster (and thus `/`). */
interface SessionSearchHandle {
  open: () => void;
  isOpen: () => boolean;
}

function hitKey(hit: RosterSearchHit): string {
  return hit.kind === "task" ? `task:${hit.taskId}` : `session:${hit.id}`;
}

/**
 * Operational live-region copy for settled Find results (Flavor-Font Rule:
 * counts stay plain). Loading is never announced — the search debounce already
 * settles status; announcing "loading" on each keystroke would chatter.
 */
function formatSearchResultAnnouncement(taskCount: number, sessionCount: number): string {
  if (taskCount === 0 && sessionCount === 0) {
    return "No tasks or sessions match.";
  }
  const parts: string[] = [];
  if (taskCount > 0) {
    parts.push(taskCount === 1 ? "1 task" : `${taskCount} tasks`);
  }
  if (sessionCount > 0) {
    parts.push(sessionCount === 1 ? "1 session" : `${sessionCount} sessions`);
  }
  return parts.join(", ");
}

function SessionSearch({
  searchSessions,
  onSelectSession,
  onSelectTask,
  searchHandleRef,
}: {
  searchSessions: (query: string) => Promise<RosterSearchHit[]>;
  onSelectSession: (id: string | null) => void;
  onSelectTask: (id: string) => void;
  searchHandleRef?: Ref<SessionSearchHandle | null>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<RosterSearchHit[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  /** Combobox active option index into `hits`; -1 = none. */
  const [activeIndex, setActiveIndex] = useState(-1);
  /**
   * Settled Find announcement for the polite live region. Updated only when
   * status is not "loading" so intermediate keystroke renders stay silent.
   */
  const [liveAnnouncement, setLiveAnnouncement] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const inputId = listId + "-input";
  // Keep a live open flag for the imperative isOpen() without forcing
  // useImperativeHandle to rebuild every toggle (ref-stable identity).
  const openRef = useRef(open);
  openRef.current = open;

  useImperativeHandle(
    searchHandleRef,
    () => ({
      open: () => setOpen(true),
      isOpen: () => openRef.current,
    }),
    [],
  );

  const closeSearch = useCallback(() => {
    setOpen(false);
    setQuery("");
    setHits([]);
    setStatus("idle");
    setActiveIndex(-1);
  }, []);

  // Focus the field when the search well opens.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Single-open invariant with Chart key (and any future hand-rolled peer).
  useEffect(() => {
    return subscribeHandRolledPopoverOpen("session-find", () => setOpen(false));
  }, []);

  // Announce open so peers close; close on outside click / Escape.
  // Register the surface root so inside clicks do not falsely clear the bus.
  useEffect(() => {
    if (!open) return;
    notifyHandRolledPopoverOpen("session-find", rootRef.current);
    const onPointer = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        closeSearch();
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        closeSearch();
        // Closing unmounts the focused input; without this, focus falls to
        // <body> and keyboard users lose their place (WCAG 2.4.3).
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      // Toggle, peer open, outside click, Esc, unmount — keep bus truthful.
      notifyHandRolledPopoverClosed("session-find");
    };
  }, [open, closeSearch]);

  // Debounced lookup — read-only, never mutates the fleet.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q === "") {
      setHits([]);
      setStatus("idle");
      setActiveIndex(-1);
      return;
    }
    setStatus("loading");
    let cancelled = false;
    const timer = setTimeout(() => {
      void searchSessions(q)
        .then((results) => {
          if (cancelled) return;
          setHits(results);
          setStatus("ready");
          // Auto-highlight first option so Enter works without ArrowDown.
          setActiveIndex(results.length > 0 ? 0 : -1);
        })
        .catch(() => {
          if (cancelled) return;
          setHits([]);
          setStatus("error");
          setActiveIndex(-1);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, open, searchSessions]);

  // Polite live region: announce settled Find states only (not loading).
  // Search is already debounced (SEARCH_DEBOUNCE_MS); skipping "loading" means
  // fast typing never streams intermediate announcements. Also skip the
  // transitional idle+non-empty frame before the loading effect commits.
  useEffect(() => {
    if (!open) {
      setLiveAnnouncement("");
      return;
    }
    if (status === "loading") return;
    if (status === "error") {
      setLiveAnnouncement("Could not reach the daemon.");
      return;
    }
    if (status === "ready") {
      const taskCount = hits.filter((h) => h.kind === "task").length;
      const sessionCount = hits.filter((h) => h.kind === "session").length;
      setLiveAnnouncement(formatSearchResultAnnouncement(taskCount, sessionCount));
      return;
    }
    // status === "idle" — only the empty-query tip is settled.
    if (query.trim() === "") {
      setLiveAnnouncement("Type a task name, branch, or session id.");
    }
  }, [open, status, hits, query]);

  const pickHit = useCallback(
    (hit: RosterSearchHit) => {
      if (hit.kind === "task") {
        onSelectTask(hit.taskId);
      } else {
        onSelectSession(hit.id);
      }
      closeSearch();
      // The hit unmounts with the popover — return focus to the trigger.
      triggerRef.current?.focus();
    },
    [onSelectSession, onSelectTask, closeSearch],
  );

  const onComboboxKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (hits.length === 0) return;
        setActiveIndex((i) => (i < 0 ? 0 : (i + 1) % hits.length));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (hits.length === 0) return;
        setActiveIndex((i) => (i <= 0 ? hits.length - 1 : i - 1));
        return;
      }
      if (event.key === "Enter") {
        if (activeIndex >= 0 && activeIndex < hits.length) {
          event.preventDefault();
          pickHit(hits[activeIndex]!);
        }
        return;
      }
      if (event.key === "Escape") {
        // Document listener also closes; prevent bubbling into roster listbox.
        event.preventDefault();
        event.stopPropagation();
        closeSearch();
        triggerRef.current?.focus();
      }
    },
    [hits, activeIndex, pickHit, closeSearch],
  );

  const activeHit = activeIndex >= 0 ? hits[activeIndex] : undefined;
  const activeDescendantId = activeHit
    ? `${listId}-opt-${hitKey(activeHit)}`
    : undefined;

  const taskHits = hits.filter((h): h is Extract<RosterSearchHit, { kind: "task" }> => h.kind === "task");
  const sessionHits = hits.filter(
    (h): h is Extract<RosterSearchHit, { kind: "session" }> => h.kind === "session",
  );

  return (
    <div className="pc-roster__search" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`pc-roster__session pc-roster__session--search${open ? " pc-roster__session--active" : ""}`}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label="Search fleet"
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">
          <Mark mark={MARK_LENS} size={11} />
        </span>{" "}
        Find
      </button>
      {open && (
        <div className="pc-roster__search-pop" role="search" aria-label="Fleet search">
          <label className="pc-roster__search-label" htmlFor={inputId}>
            Find tasks or sessions
          </label>
          <input
            id={inputId}
            ref={inputRef}
            type="search"
            role="combobox"
            className="pc-roster__search-input"
            placeholder="task name, branch, or session id…"
            value={query}
            autoComplete="off"
            spellCheck={false}
            aria-expanded={true}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeDescendantId}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onComboboxKeyDown}
          />
          <div
            id={listId}
            className="pc-roster__search-results"
            role="listbox"
            aria-label="Matching tasks and sessions"
          >
            {status === "loading" && (
              <p className="pc-roster__search-status">Scouring the charts…</p>
            )}
            {status === "error" && (
              <p className="pc-roster__search-status">Could not reach the daemon.</p>
            )}
            {status === "idle" && query.trim() === "" && (
              <p className="pc-roster__search-status">
                Type a task name, branch, or session id.
              </p>
            )}
            {status === "ready" && hits.length === 0 && (
              <p className="pc-roster__search-status">No tasks or sessions match.</p>
            )}
            {taskHits.length > 0 && (
              <div className="pc-roster__search-group" role="presentation">
                <p className="pc-roster__search-group-label" role="presentation">
                  Tasks
                </p>
                {taskHits.map((hit) => {
                  const key = hitKey(hit);
                  const optionId = `${listId}-opt-${key}`;
                  const idx = hits.indexOf(hit);
                  const active = idx === activeIndex;
                  return (
                    <div
                      key={key}
                      id={optionId}
                      role="option"
                      aria-selected={active}
                      className={`pc-roster__search-hit pc-roster__search-hit--task${
                        active ? " pc-roster__search-hit--active" : ""
                      }`}
                      onClick={() => pickHit(hit)}
                      onMouseEnter={() => setActiveIndex(idx)}
                    >
                      <span className="pc-roster__search-hit-id" title={hit.taskId}>
                        {hit.name}
                      </span>
                      <span className="pc-roster__search-hit-meta">
                        {hit.branch ?? "no branch"}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            {sessionHits.length > 0 && (
              <div className="pc-roster__search-group" role="presentation">
                <p className="pc-roster__search-group-label" role="presentation">
                  Sessions
                </p>
                {sessionHits.map((hit) => {
                  const key = hitKey(hit);
                  const optionId = `${listId}-opt-${key}`;
                  const idx = hits.indexOf(hit);
                  const active = idx === activeIndex;
                  return (
                    <div
                      key={key}
                      id={optionId}
                      role="option"
                      aria-selected={active}
                      className={`pc-roster__search-hit pc-roster__search-hit--session${
                        active ? " pc-roster__search-hit--active" : ""
                      }`}
                      title={hit.id}
                      onClick={() => pickHit(hit)}
                      onMouseEnter={() => setActiveIndex(idx)}
                    >
                      <span className="pc-roster__search-hit-primary">
                        <span className="pc-roster__search-hit-handle">{hit.handle}</span>
                        <span className="pc-roster__search-hit-ref" title={hit.id}>
                          {hit.shortRef}
                        </span>
                      </span>
                      <span className="pc-roster__search-hit-meta">
                        {formatTaskCount(hit.taskCount)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {/* Live region outside the listbox — listboxes must not host live children. */}
          <div className="pc-visually-hidden" aria-live="polite" aria-atomic="true">
            {liveAnnouncement}
          </div>
        </div>
      )}
    </div>
  );
}

function SessionSelector({
  sessions,
  selectedSessionId,
  onSelectSession,
  onSelectTask,
  searchSessions,
  searchHandleRef,
}: {
  sessions: RosterSessionOption[];
  selectedSessionId: string | null;
  onSelectSession: (id: string | null) => void;
  onSelectTask: (id: string) => void;
  searchSessions: (query: string) => Promise<RosterSearchHit[]>;
  searchHandleRef?: Ref<SessionSearchHandle | null>;
}) {
  // Always mount SessionSearch so `/` can open Find even when there are no
  // recent chips (historical sessions are reached via search, #88).
  return (
    <div className="pc-roster__sessions" role="group" aria-label="Orchestrator sessions">
      <button
        type="button"
        className={`pc-roster__session${selectedSessionId === null ? " pc-roster__session--active" : ""}`}
        aria-pressed={selectedSessionId === null}
        onClick={() => onSelectSession(null)}
      >
        All hands
      </button>
      {sessions.map((session) => (
        <button
          key={session.id}
          type="button"
          className={`pc-roster__session${
            selectedSessionId === session.id ? " pc-roster__session--active" : ""
          }`}
          aria-pressed={selectedSessionId === session.id}
          title={session.id}
          onClick={() => onSelectSession(session.id)}
        >
          <span aria-hidden="true">
            <Mark mark={MARK_ANCHOR} size={10} />
          </span>{" "}
          <span className="pc-roster__session-handle">{session.handle}</span>
          <span className="pc-roster__session-ref" title={session.id}>
            {session.shortRef}
          </span>
          <span className="pc-roster__session-count">{formatTaskCount(session.count)}</span>
        </button>
      ))}
      <SessionSearch
        searchSessions={searchSessions}
        onSelectSession={onSelectSession}
        onSelectTask={onSelectTask}
        searchHandleRef={searchHandleRef}
      />
    </div>
  );
}

/**
 * Layer 2 — the fleet roster (design-manifest §4.5/§4.6). Tasks and runs
 * grouped by attention state as **peer rows** (#254), with a session selector
 * that both filters the groups below (#76) and marks the future scene's
 * camera-focus target, plus row selection (feeds the inspector/scene). Recent
 * chips are capped; older sessions are reached via the Find search (#88).
 * Plain props throughout: the hooks layer does the grouping/ordering/filtering
 * via `@useparley/core`'s attention constants and owns the selection state.
 * Memoized — the cockpit shell re-renders every second for its clock, and all
 * roster props are identity-stable between snapshot updates.
 */
export const RosterPanel = memo(function RosterPanel({
  groups,
  sessions,
  selectedSessionId,
  onSelectSession,
  searchSessions,
  selectedTaskId,
  onSelectTask,
  selectedRunId = null,
  onSelectRun,
  totalTasks,
  activeTasks,
  connecting = false,
  searchRef,
}: RosterPanelProps) {
  const sessionSearchRef = useRef<SessionSearchHandle | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const selectRun = onSelectRun ?? (() => undefined);

  // Flat peer order across groups — the listbox's single navigation axis.
  const entries = useMemo(() => flattenEntries(groups), [groups]);
  const entryKeys = useMemo(() => entries.map(entryKey), [entries]);

  // Coarse clock only while attention rows (awaiting / stalled / fresh-failed)
  // are present — keeps relative ages honest without a 1s re-render.
  const needsAgeClock = useMemo(
    () =>
      groups.some(
        (g) =>
          ((g.state === "awaiting_answer" || g.state === "stalled") &&
            (g.tasks.some((t) => t.updatedAt) ||
              (g.runs ?? []).some((r) => r.updatedAt))) ||
          (g.state === "failed" &&
            g.tasks.some((t) => t.freshFailure && t.updatedAt)),
      ),
    [groups],
  );
  const nowMs = useCoarseNow(needsAgeClock);

  // Roving tabindex: one tab stop among options (APG listbox).
  // Prefer the selected run/task when present; else the first row.
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const selectedKey = selectedRunId
    ? entryKey({ kind: "run", id: selectedRunId, state: "" })
    : selectedTaskId
      ? entryKey({ kind: "task", id: selectedTaskId, state: "" })
      : null;
  const resolvedFocusKey = useMemo(() => {
    if (entryKeys.length === 0) return null;
    if (focusedKey && entryKeys.includes(focusedKey)) return focusedKey;
    if (selectedKey && entryKeys.includes(selectedKey)) return selectedKey;
    return entryKeys[0] ?? null;
  }, [entryKeys, focusedKey, selectedKey]);

  useEffect(() => {
    if (resolvedFocusKey && resolvedFocusKey !== focusedKey) {
      setFocusedKey(resolvedFocusKey);
    }
    if (entryKeys.length === 0 && focusedKey !== null) {
      setFocusedKey(null);
    }
  }, [resolvedFocusKey, focusedKey, entryKeys.length]);

  const focusEntryAt = useCallback(
    (index: number) => {
      const key = entryKeys[index];
      if (!key) return;
      setFocusedKey(key);
      requestAnimationFrame(() => {
        rowRefs.current.get(key)?.focus();
      });
    },
    [entryKeys],
  );

  // Manual-activation listbox (WAI-ARIA APG): arrows/Home/End only move focus;
  // Enter/Space select. Matches the Inspector tab bar's house style.
  const onListKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (entryKeys.length === 0) return;
      const current = resolvedFocusKey ? entryKeys.indexOf(resolvedFocusKey) : 0;
      const last = entryKeys.length - 1;
      let next: number | null = null;
      switch (event.key) {
        case "ArrowDown":
          next = current < 0 ? 0 : current === last ? 0 : current + 1;
          break;
        case "ArrowUp":
          next = current < 0 ? last : current === 0 ? last : current - 1;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = last;
          break;
        case "Enter":
        case " ": {
          event.preventDefault();
          const key = resolvedFocusKey ?? entryKeys[0];
          if (!key) return;
          const entry = entries.find((e) => entryKey(e) === key);
          if (!entry) return;
          if (entry.kind === "run") selectRun(entry.id);
          else onSelectTask(entry.id);
          return;
        }
        default:
          return;
      }
      event.preventDefault();
      focusEntryAt(next);
    },
    [entryKeys, entries, resolvedFocusKey, onSelectTask, selectRun, focusEntryAt],
  );

  useImperativeHandle(
    searchRef,
    () => ({
      openSearch: () => sessionSearchRef.current?.open(),
      isSearchOpen: () => sessionSearchRef.current?.isOpen() ?? false,
    }),
    [],
  );

  const hasRows = entryKeys.length > 0;

  return (
    <Plate padded={false} className="pc-roster">
      <PlateHeader
        icon={<Mark mark={MARK_SLOOP} size={14} />}
        iconDark
        title="FLEET ROSTER"
        subtitle="every soul at sea"
        divider
      />
      <SessionSelector
        sessions={sessions}
        selectedSessionId={selectedSessionId}
        onSelectSession={onSelectSession}
        onSelectTask={onSelectTask}
        searchSessions={searchSessions}
        searchHandleRef={sessionSearchRef}
      />
      <div
        className="pc-roster__scroll"
        role={hasRows ? "listbox" : undefined}
        aria-label={hasRows ? "Fleet tasks" : undefined}
        onKeyDown={hasRows ? onListKeyDown : undefined}
      >
        {!hasRows ? (
          connecting ? (
            <div className="pc-roster__empty" role="status">
              <p className="pc-roster__empty-title">Hailing the fleet…</p>
              <p className="pc-roster__empty-sub">listening for the fleet</p>
            </div>
          ) : (
            <RosterEmptyStarter />
          )
        ) : (
          groups.map((group) => (
            <Group
              key={group.state}
              group={group}
              selectedTaskId={selectedTaskId}
              selectedRunId={selectedRunId}
              focusedKey={resolvedFocusKey}
              onSelectTask={onSelectTask}
              onSelectRun={selectRun}
              onFocusEntry={setFocusedKey}
              rowRefs={rowRefs}
              nowMs={nowMs}
            />
          ))
        )}
      </div>
      <div className="pc-roster__footer">
        <Stat value={String(totalTasks)} label="Total tasks" color="var(--brass)" />
        {/* Active is a metric (running+queued+pending+stalled+awaiting), not
            the running *state* — State-Color Reservation: use brass, not
            --state-running. */}
        <Stat value={String(activeTasks)} label="Active" color="var(--brass)" />
      </div>
    </Plate>
  );
});
